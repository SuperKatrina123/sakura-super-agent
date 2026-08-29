import type { ModelMessage } from 'ai';
import { countMessageChars, countMessagesChars } from './token-count.js';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';

// ═══════════════════════════════════════════════════════════════════════════
// TokenTracker：精确基准 + 粗估增量
// ═══════════════════════════════════════════════════════════════════════════
//
// 每轮 loop 结束后 API 返回 usage.inputTokens——这是**精确值**（tokenizer 算的）
// 但那是"调完 API 才知道"的，我们要在**调 API 之前**判断"要不要压缩"
//
// 折中方案：
//   1. 每次 API 返回时用 usage.inputTokens 作为**精确基准**（updateFromAPI）
//   2. 中间新增的 message 用 chars/4 粗估补上（addMessage）
//   3. 压缩发生时记录字符差、不重新全量计数（replaceMessages）
//
// 关键性质：**精确基准每轮 reset 增量**——粗估偏差不会累积
// 单轮偏差 ≤ 15%（chars/4 的经验误差），跨轮永远从精确值重新开始
//
// 为什么不接 tiktoken：
//   - 初始化几百 ms、encode 也要几十 ms（每次都跑代价大）
//   - 不同模型 tokenizer 不一样（GPT vs Claude vs DeepSeek）
//   - 我们要的是"要不要触发压缩"的二元决策——粗估完全够用
export class TokenTracker {
  private lastPreciseCount = 0;   // 上次 API 返回的精确 input tokens
  private pendingChars = 0;       // 上次 API 之后新增/减少的字符净增量

  // API 调用返回时校准——重置增量、以精确值为新基准
  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0;
  }

  // 新增一条 message——通常是 user 消息或 agentLoop 内部 push 的 assistant/tool
  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message);
  }

  addMessages(messages: ModelMessage[]): void {
    for (const m of messages) this.addMessage(m);
  }

  // 压缩/替换发生时——只记录字符差，不重新全量计数
  // 关键：不丢掉上次 API 已经计入的 system prompt + 工具定义成本
  //   （那些成本已经在 lastPreciseCount 里，不需要重新算）
  // 只需要知道"这次替换让 messages 数组少了/多了多少字符"
  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  // 当前估算的总 tokens = 精确基准 + 粗估增量
  get estimatedTokens(): number {
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4);
  }

  // 简洁状态——给 log 用（你的 caller 里用的是 tracker.status.tokens）
  get status(): { tokens: number; precise: number; pending: number } {
    return {
      tokens: this.estimatedTokens,
      precise: this.lastPreciseCount,
      pending: Math.ceil(this.pendingChars / 4),
    };
  }

  // Debug 用：分别看基准和增量各是多少
  get debug(): { precise: number; pendingChars: number; estimated: number } {
    return {
      precise: this.lastPreciseCount,
      pendingChars: this.pendingChars,
      estimated: this.estimatedTokens,
    };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Layer 2：工具结果动态截断——大小维度防线
// ═══════════════════════════════════════════════════════════════════════════
//
// TokenTracker 告诉你"空间紧不紧"，截断告诉你"超了怎么办"。
//
// 跟前面 tool-registry.ts 里的 truncateResult 的区别：
//   - truncateResult 是**注册时静态截断**——工具生成结果时就按 maxResultChars 砍一刀
//   - 这里是**运行时动态截断**——根据当前 messages 全局总量做兜底
//
// 为什么两层都要：静态截断防的是"单次生成太大"，动态截断防的是
//   "N 个 tool_result 累加起来超预算"——它们各管一维
//
// OpenClaw 的双重约束（我们对齐）：
//   1. 单条工具结果 ≤ 上下文窗口的 50%
//   2. 总上下文 ≤ 上下文窗口的 75%
//
// 双 Pass 设计：
//   Pass 1: 单条截断——超过 50% 窗口的做 Head/Tail 60/40 分割
//   Pass 2: 总量控制——Pass 1 后还超 75%，从最老的 tool_result 开始整体清理
//   （比 microcompact 更粗暴——Pass 2 里连"最近保护"都不管了、活在预算线内是硬约束）

// 主流 model context window 参考值——生产按实际模型改
// DeepSeek-V4: 128k, GPT-5: 200k, Claude Opus 5: 200k
const CONTEXT_WINDOW = 200_000;

export interface TruncateConfig {
  // 单条工具结果的字符上限——按 window × 50% × 2 chars/token 换算
  // 2 chars/token 是"保守估计"（中文近似）——低估字符/token 比例、留出安全余量
  maxSingleResult: number;
  // 全局总字符预算——按 window × 75% × 4 chars/token 换算
  // 4 chars/token 是"英文平均"——总量里英文占多数、按这个算合理
  contextBudgetChars: number;
}

const DEFAULT_TRUNCATE_CONFIG: TruncateConfig = {
  maxSingleResult: CONTEXT_WINDOW * 0.5 * 2,      // 200k
  contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4,  // 600k
};

// truncateToolResults：Layer 2 主入口
// 返回 { messages, truncated, compacted }：
//   - truncated: Pass 1 里被 Head/Tail 分割的条数
//   - compacted: Pass 2 里被整体清空的条数
export function truncateToolResults(
  messages: ModelMessage[],
  config: TruncateConfig = DEFAULT_TRUNCATE_CONFIG,
): { messages: ModelMessage[]; truncated: number; compacted: number } {
  let truncated = 0;
  let compacted = 0;

  // ─── Pass 1：单条截断 ────────────────────────────────────────
  // 遍历每条 tool 消息、每个 tool-result part——超过 maxSingleResult 就做 Head/Tail 分割
  let result: ModelMessage[] = messages.map(msg => {
    if (msg.role !== 'tool') return msg;
    const newContent = msg.content.map(part => {
      // tool-approval-response 没有 output，直接跳过
      if (part.type !== 'tool-result') return part;
      const outputText = toolResultOutputToText(part.output);
      if (outputText.length <= config.maxSingleResult) return part;

      truncated++;
      const max = config.maxSingleResult;
      // Head/Tail 60/40——跟 truncateResult 的分割一致，保持整个项目"截断呈现方式"统一
      const head = outputText.slice(0, Math.floor(max * 0.6));
      const tail = outputText.slice(-Math.floor(max * 0.4));
      return {
        ...part,
        output: textToolResultOutput(
          `${head}\n\n[truncated: ${outputText.length} → ${max} chars]\n\n${tail}`,
        ),
      };
    });
    return { ...msg, content: newContent };
  });

  // ─── Pass 2：总量预算 ────────────────────────────────────────
  // Pass 1 之后总字符还超 75% 窗口——从最老 tool_result 开始整体清空
  // "整体清空"而不是"再截"，是因为已经被 Pass 1 收窄过了，
  // 再截意义不大——不如直接标记 [compacted]、彻底释放这条的空间
  let totalChars = countMessagesChars(result);
  if (totalChars <= config.contextBudgetChars) {
    return { messages: result, truncated, compacted };
  }

  for (let i = 0; i < result.length && totalChars > config.contextBudgetChars; i++) {
    const msg = result[i];
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;

    // 拿第一个 tool-result part 的工具名——用于占位符提示
    const firstResult = msg.content.find(p => p.type === 'tool-result');
    const toolName = firstResult?.type === 'tool-result' ? firstResult.toolName : 'unknown';

    const oldSize = countMessageChars(msg);
    result[i] = {
      ...msg,
      content: msg.content.map(part => {
        if (part.type !== 'tool-result') return part;
        return {
          ...part,
          output: textToolResultOutput(
            `[compacted: ${toolName} output removed to free context]`,
          ),
        };
      }),
    };
    totalChars -= oldSize - countMessageChars(result[i]);
    compacted++;
  }

  return { messages: result, truncated, compacted };
}


// ═══════════════════════════════════════════════════════════════════════════
// Layer 3：TTL 修剪——时间衰减防线
// ═══════════════════════════════════════════════════════════════════════════
//
// 截断管"单条太大"，TTL 管"老消息还留着干嘛"。
//
// 核心洞察：**老的工具结果几乎一定比新的更没用**
//   - 5 分钟前读的文件内容大概率已经不影响当前决策
//   - 10 分钟前的 grep 结果基本可以扔了
// 但直接删掉会破坏对话结构（tool_call/tool_result 配对断裂 → API 400）
//
// 两档设计：信息价值随时间递减，收窄也应该分档
//   - 软修剪（5 分钟）——保留头尾、中间标记 [soft pruned]
//     模型还能看到"文件开头长啥样、结尾长啥样"，知道有过这个结果
//   - 硬清除（10 分钟）——只留事件、内容全清
//     "发生过什么"的事实保留，"具体内容"释放
//
// 时间戳的存储：WeakMap<ModelMessage, Date>
//   - push 消息时一处 map.set(msg, new Date())——只需要维护一处
//   - 消息被 splice 掉时自动 GC——不用手动清理
//   - 对比方案：平行数组 messageTimestamps[i] 需要在 6 处 push/splice 同步维护
//     WeakMap 语义有一点复杂度，但少一处遗忘就少一次数据不一致 bug

// TTL 阈值
const SOFT_PRUNE_MS = 5 * 60 * 1000;   // 5 分钟软修剪
const HARD_PRUNE_MS = 10 * 60 * 1000;  // 10 分钟硬清除

// 软修剪保留的头尾字符数——够看到"开头是什么、结尾是什么"、不占太多空间
const SOFT_PRUNE_HEAD_CHARS = 1500;
const SOFT_PRUNE_TAIL_CHARS = 1500;

// 独立的时间戳存储——通过 export 让 caller（agentLoop / index.ts）在 push 时打时间戳
export const messageTimestamps = new WeakMap<ModelMessage, Date>();

// 标记消息的时间戳——push 到 messages 数组前调用
export function markMessageTime(msg: ModelMessage, when: Date = new Date()): void {
  messageTimestamps.set(msg, when);
}

// 批量标记——用于 stepResponse.messages 那种一次性 push 多条的场景
export function markMessagesTime(messages: ModelMessage[], when: Date = new Date()): void {
  for (const m of messages) messageTimestamps.set(m, when);
}

// pruneByTTL：按时间戳修剪老的 tool 消息
// 无 timestamp 的消息（比如 --continue 加载的历史）默认按 "很老" 处理——
// 让 caller 在加载时用 SessionEntry.timestamp 重建 map，否则历史全部会被清
//
// 两条铁律（跟 tool 修剪相关的其他 layer 一致）：
//   1. 只修剪 tool 消息——user / assistant 永不修剪（对话结构必须完整）
//   2. 保留错误经验——失败的工具结果永不修剪（错误信息帮模型避免重复尝试）
//
// 错误关键词识别：中英混合的常见 error 表述
// 用宽松的正则——宁可多留一些不修剪、也不能把"这条路走不通"的信号丢了
const ERROR_PATTERN = /error|失败|不存在|denied|timeout|失效|拒绝|超时|not found|forbidden|exception/i;

export function pruneByTTL(
  messages: ModelMessage[],
  now: Date = new Date(),
): { messages: ModelMessage[]; softPruned: number; hardPruned: number } {
  let softPruned = 0;
  let hardPruned = 0;

  const result = messages.map(msg => {
    // 铁律 1：只修剪 tool 消息
    if (msg.role !== 'tool') return msg;

    const ts = messageTimestamps.get(msg);
    // 没时间戳 = 不修剪（宁可不动，不能误清没打过时间戳的消息）
    if (!ts) return msg;

    const ageMs = now.getTime() - ts.getTime();
    if (ageMs < SOFT_PRUNE_MS) return msg;   // 还年轻，不动

    // 铁律 2：错误经验保留——遍历所有 tool-result output，任何一个含错误关键词就整条跳过
    const hasError = msg.content.some(p => {
      if (p.type !== 'tool-result') return false;
      return ERROR_PATTERN.test(toolResultOutputToText(p.output));
    });
    if (hasError) return msg;

    const isHard = ageMs >= HARD_PRUNE_MS;
    let didAny = false;

    const newContent = msg.content.map(part => {
      if (part.type !== 'tool-result') return part;
      const text = toolResultOutputToText(part.output);

      if (isHard) {
        // 硬清除：只留事件、内容全清
        didAny = true;
        return {
          ...part,
          output: textToolResultOutput(
            `[tool result expired: ${part.toolName}]`,
          ),
        };
      }

      // 软修剪：保留头尾、中间标记
      // 如果原文本身就小于 head+tail、软修剪没意义（新内容会比原文还长）——跳过
      const minSize = SOFT_PRUNE_HEAD_CHARS + SOFT_PRUNE_TAIL_CHARS;
      if (text.length <= minSize) return part;

      didAny = true;
      const head = text.slice(0, SOFT_PRUNE_HEAD_CHARS);
      const tail = text.slice(-SOFT_PRUNE_TAIL_CHARS);
      return {
        ...part,
        output: textToolResultOutput(
          `${head}\n\n[soft pruned: ${text.length - minSize} chars omitted]\n\n${tail}`,
        ),
      };
    });

    if (didAny) {
      if (isHard) hardPruned++;
      else softPruned++;
    }
    return { ...msg, content: newContent };
  });

  return { messages: result, softPruned, hardPruned };
}


// ═══════════════════════════════════════════════════════════════════════════
// applyDefense：三层零 LLM 防线的统一入口
// ═══════════════════════════════════════════════════════════════════════════
//
// 按 "便宜 → 稍贵" 顺序调用：TTL 修剪 → 单条截断 → 总量控制
//   1. pruneByTTL：先按时间衰减清老的（最便宜、单遍历）
//   2. truncateToolResults：再按大小控制单条 + 总量
//     （Pass 1 单条超 50% window 截、Pass 2 总量超 75% window 清最老的）
//
// 这三层都是**同步、零 LLM 调用**——放心每轮 loop 开头调用
// LLM Summarization 走 compressor.ts 的 summarize()——那个才是"贵"的最后一层

export interface DefenseResult {
  messages: ModelMessage[];
  softPruned: number;   // TTL 软修剪的条数（5-10 min）
  hardPruned: number;   // TTL 硬清除的条数（> 10 min）
  truncated: number;    // 单条超 50% 被截断的条数
  compacted: number;    // 总量超 75% 被整体清空的条数
}

export function applyDefense(messages: ModelMessage[]): DefenseResult {
  // Step 1: TTL 修剪（时间维度）
  const ttl = pruneByTTL(messages);
  // Step 2: 大小截断（Pass 1 单条 + Pass 2 总量）
  const trunc = truncateToolResults(ttl.messages);

  return {
    messages: trunc.messages,
    softPruned: ttl.softPruned,
    hardPruned: ttl.hardPruned,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
  };
}
