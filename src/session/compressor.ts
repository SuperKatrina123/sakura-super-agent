import type { ModelMessage, ToolModelMessage, LanguageModel } from 'ai';
import { generateText } from 'ai';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';
import { countMessagesChars } from './token-count.js';

// 保留最近 K 个 tool result 完整——因为最近几轮的结果很可能还在被模型引用
// 你刚读的文件、刚跑的命令，模型下一步可能还要用
// Claude Code 也是这个思路：只清理"足够老"的结果
const KEEP_RECENT_TOOL_RESULTS = 3;

// 只清理"查询类"工具的结果——它们的返回值是一次性快照，用完就作废
// 副作用类工具（如 create_issue）的返回值是未来操作的锚点（比如新 issue 的 id），不能清
// 内置工具用精确白名单；MCP 工具用命名启发式（见 isClearableToolName）
const CLEARABLE_BUILTIN_TOOLS = new Set([
  'read_file', 'bash', 'grep', 'glob', 'list_directory',
  // 网页类查询——单次返回可能几千 tokens，是压缩的大头
  'web_search', 'web_fetch',
]);

// MCP 工具的可清判定：走命名启发式
// 大多数 MCP 生态遵循 verb_noun 命名，动词能透露副作用意图
// - 查询类（可清）：list / search / get / read / query / describe / show / fetch / screenshot
// - 副作用类（不清）：create / update / delete / write / add / remove / send / post / patch
// 命名不匹配的默认**不清**——宁可放过，不能误清
//
// 两种模式：动词_名词（如 list_issues） 和 动词单独作为完整名（如 query）
const QUERY_VERBS = ['list', 'search', 'get', 'read', 'query', 'describe', 'show', 'fetch', 'screenshot'];
const QUERY_VERB_PATTERN = new RegExp(
  `^mcp__[^_]+__(${QUERY_VERBS.join('|')})(_|$)`,
);

function isClearableToolName(toolName: string): boolean {
  if (CLEARABLE_BUILTIN_TOOLS.has(toolName)) return true;
  if (toolName.startsWith('mcp__')) return QUERY_VERB_PATTERN.test(toolName);
  // 未知内置工具（比如未来加的、没登记的）——保守不清
  return false;
}

// 清空后的占位符——足够短（<10 tokens）、保留"这里曾经有结果"的信号
const CLEARED_MARKER = '[tool result cleared]';

function isToolMessage(msg: ModelMessage): msg is ToolModelMessage {
  return msg.role === 'tool';
}

// Microcompact：清理旧的可清工具结果，保留消息结构
// - 不删消息 → 对话因果链完整（tool_call 依然对应到一条 tool 消息）
// - 不动 SYSTEM / user / assistant → 只针对 tool 角色
// - 只清"查询类"工具 → 副作用类工具的返回值可能是未来操作的锚点，保守不动
export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  const toolMsgIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isToolMessage(messages[i])) toolMsgIndices.push(i);
  }

  // 保留最后 K 个 tool 消息不动——最近的结果可能还在被引用
  const toConsiderIndices = new Set(
    toolMsgIndices.slice(0, Math.max(0, toolMsgIndices.length - KEEP_RECENT_TOOL_RESULTS))
  );

  let cleared = 0;
  const result = messages.map((msg, idx) => {
    if (!toConsiderIndices.has(idx)) return msg;
    if (!isToolMessage(msg)) return msg;

    // 一条 tool 消息里可能有多个 part：tool-result（我们要清）和 tool-approval-response（跳过）
    // 逐个 part 判定：可清的清、不可清的保留
    let clearedInThisMsg = false;
    const newContent = msg.content.map(part => {
      // tool-approval-response 没有 toolName，不是 result 类型——直接跳过
      if (part.type !== 'tool-result') return part;
      if (!isClearableToolName(part.toolName)) return part;
      // 已经是占位符了——不算"这次清了一个"，避免 --continue 加载压缩过的历史后计数虚高
      // 幂等性保留：内容不变、cleared 计数不变
      const alreadyCleared =
        part.output.type === 'text' && part.output.value === CLEARED_MARKER;
      if (alreadyCleared) return part;
      clearedInThisMsg = true;
      return { ...part, output: textToolResultOutput(CLEARED_MARKER) };
    });

    if (clearedInThisMsg) cleared++;
    return { ...msg, content: newContent };
  });

  return { messages: result, cleared };
}


// ═══════════════════════════════════════════════════════════════════════════
// Layer 2：Summarization
// 当 Microcompact 之后 context 仍然过大时，调 LLM 把老对话压成一段结构化摘要
// ═══════════════════════════════════════════════════════════════════════════

// 上下文 token 阈值——超过就触发压缩
// DeepSeek/GPT/Claude context 大多 128k-200k，取 60k 留一半给对话继续和输出
// 用字符数/4 粗估 token（中文会低估，但低估比高估安全——提前触发的代价大）
const CONTEXT_TOKEN_THRESHOLD = 600000;

// 保留最近 N 条完整消息——覆盖当前正在做的子任务
const KEEP_RECENT_MESSAGES = 10;

// 摘要消息的开头标记——同时用于：
//   1. 让模型知道这是历史摘要不是用户新说的话（配合 coreRules 里的说明）
//   2. summarize() 内部自动从 messages[0] 提取"上一次的摘要"（级联压缩）
const SUMMARY_PREFIX = '[以下是之前对话的压缩摘要]';
const SUMMARY_SUFFIX = '[摘要结束]';

// 压缩 Prompt：给模型一个表格模板让它填，而不是让它自由发挥
// 参考 Manus 分享的最佳实践：模板越具体，压缩结果越稳定
// 三个核心：
//   1. 保什么——具体、可操作的信息（不要笼统概述）
//   2. 不保什么——泛泛而谈、模型的思考过程
//   3. 标识符保护——文件路径 / UUID / 版本号 / 错误信息原样保留，不允许翻译改写
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

export interface CompactionResult {
  messages: ModelMessage[];
  summary: string;
  compressedCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1：Token 估算——知道自己还剩多少空间
// ═══════════════════════════════════════════════════════════════════════════
//
// 精确 token 计数要等 API 返回 usage.prompt_tokens——但那是"调完之后"才知道
// 我们要在**调 API 之前**决定"要不要压缩"，所以必须有一个"事前估算"
//
// 启发式：4 字符 ≈ 1 token（英文的 GPT tokenizer 经验）
// 但中文 token 效率低——1 个汉字 ≈ 1.5-2 tokens
// 如果整篇是中文、按 4 字符/token 估算 → 严重低估 → 触发太晚 → 撞 API 硬墙
//
// 解法：加 1.2 倍安全系数——宁可高估、不能低估
// 高估的代价：提前触发压缩（多花一次 LLM）
// 低估的代价：API 400 拒绝，整个 loop 崩掉
// 两害相权取其轻——**低估的代价大得多**

// 安全系数：应对中文/JSON 结构字符/特殊 token 等 tokenizer 偏差
// 中文场景大约 1.3-1.5，混合场景 1.2 够用
const TOKEN_SAFETY_MULTIPLIER = 1.2;

// 粗略 token 估算：字符数 / 4 × 安全系数
// 计数逻辑复用 token-count.ts 里的 countMessagesChars——避免跟 defense.ts 的 TokenTracker 逻辑重复
// export：让 agentLoop 打压缩前后的 tokens 对比 log
export function estimateTokens(messages: ModelMessage[]): number {
  const chars = countMessagesChars(messages);
  return Math.ceil((chars / 4) * TOKEN_SAFETY_MULTIPLIER);
}

// 从 messages 里提取上一次的摘要（如果 messages[0] 是摘要消息）
// 支持"级联压缩"——每次压缩都能把上一次的摘要一起再压
// 避免多段摘要堆积导致 messages[0] 越来越长
function extractExistingSummary(messages: ModelMessage[]): string {
  const first = messages[0];
  if (!first || first.role !== 'user') return '';
  const content = typeof first.content === 'string' ? first.content : '';
  if (!content.startsWith(SUMMARY_PREFIX)) return '';
  const start = SUMMARY_PREFIX.length;
  const end = content.lastIndexOf(SUMMARY_SUFFIX);
  return end > start ? content.slice(start, end).trim() : content.slice(start).trim();
}

// 把 ModelMessage[] 转成给压缩 LLM 看的自然语言对话
// 用 [role] content 的紧凑格式——省 token、够清晰
function messagesToText(messages: ModelMessage[]): string {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return `[${msg.role}] ${msg.content}`;
    }
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map(part => {
        if (part.type === 'text') return part.text;
        if (part.type === 'tool-call') return `<tool_call name="${part.toolName}">${JSON.stringify(part.input)}</tool_call>`;
        if (part.type === 'tool-result') return `<tool_result name="${part.toolName}">${toolResultOutputToText(part.output)}</tool_result>`;
        return '';
      }).filter(Boolean);
      return `[${msg.role}] ${parts.join('\n')}`;
    }
    return `[${msg.role}]`;
  }).join('\n\n');
}

// 找到"从 splitIdx 起第一个 user 消息"的位置
// 目的：避免切断 assistant.tool_call → tool.result 的配对（API 会 400）
// user 消息是"新一轮任务的开始"，切在这里最安全
// 找不到就返回 -1（保留区里全是 assistant/tool——说明当前轮还没结束，不该压）
function alignToUserBoundary(messages: ModelMessage[], splitIdx: number): number {
  for (let i = splitIdx; i < messages.length; i++) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

// Summarize：调 LLM 把老对话压成摘要，返回新的 messages 数组
// 语义：
//   - 未超阈值 → 原样返回，不调 LLM
//   - 超阈值但无法对齐 user 边界 → 原样返回（当前轮未结束）
//   - 触发压缩 → 老对话被摘要消息替代，新 messages = [摘要, ...保留的最近对话]
//
// 级联压缩：自动从 messages[0] 提取上次的摘要，合并进新压缩——避免多段摘要堆积
export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
): Promise<CompactionResult> {
  const tokenEstimate = estimateTokens(messages);
  if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD) {
    return { messages, summary: '', compressedCount: 0 };
  }

  // 从头留 KEEP_RECENT_MESSAGES 条完整——从 messages.length - K 开始切
  const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
  const alignedIdx = alignToUserBoundary(messages, splitIdx);
  if (alignedIdx < 0) {
    // 保留区找不到 user 边界——当前轮未结束，先不压
    return { messages, summary: '', compressedCount: 0 };
  }

  const toCompress = messages.slice(0, alignedIdx);
  const toKeep = messages.slice(alignedIdx);
  if (toCompress.length === 0) return { messages, summary: '', compressedCount: 0 };

  // 级联：自动挖出上次的摘要，合并进新的压缩输入
  const existingSummary = extractExistingSummary(toCompress);
  const conversationText = messagesToText(
    existingSummary
      ? toCompress.slice(1)   // 跳过 messages[0]（那是上次的摘要，已经通过 existingSummary 拿到了）
      : toCompress,
  );
  const userPrompt = existingSummary
    ? `## 已有摘要\n\n${existingSummary}\n\n## 新对话\n\n${conversationText}`
    : conversationText;

  const { text: summary } = await generateText({
    model,
    system: COMPRESS_PROMPT,
    prompt: userPrompt,
  });

  const summaryMessage: ModelMessage = {
    role: 'user',
    content: `${SUMMARY_PREFIX}\n\n${summary}\n\n${SUMMARY_SUFFIX}`,
  };

  return {
    messages: [summaryMessage, ...toKeep],
    summary,
    compressedCount: toCompress.length,
  };
}


