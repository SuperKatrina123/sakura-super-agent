# 上下文压缩：Microcompact + Summarization 两层策略

> 配套 [../README.md](../README.md) 的拓展阅读。前几篇解决了"记得住"（Session 持久化）和"prompt 可维护"（Prompt Pipe），这篇解决**长会话必踩的坎**——`messages` 数组无限增长。为什么工具结果占大头、为什么先 Microcompact 后 Summarization、级联压缩为什么必要、以及 prompt 模板化的关键作用。

## 目录

- [0. 为什么长会话会撞墙](#0-为什么长会话会撞墙)
- [1. 三类内容与可压缩性](#1-三类内容与可压缩性)
- [2. Layer 1：Microcompact——清理旧工具结果](#2-layer-1microcompact清理旧工具结果)
- [3. Layer 2：Summarization——LLM 摘要压缩](#3-layer-2summarizationllm-摘要压缩)
- [4. 分层策略：先便宜后贵、能保结构不摘要](#4-分层策略先便宜后贵能保结构不摘要)
- [5. 级联压缩：不让摘要堆积成新的膨胀源](#5-级联压缩不让摘要堆积成新的膨胀源)
- [6. 稳定性保障：四个必踩的坑](#6-稳定性保障四个必踩的坑)
- [7. 已知的坑与后续方向](#7-已知的坑与后续方向)

## 0. 为什么长会话会撞墙

前面几篇让 Agent 越来越能干——工具、MCP、tool_search、session 持久化、prompt pipe。但**每一个能力都在往 `messages` 数组里塞更多东西**。

看两个真实数据：

**单次 GitHub API 调用有多大**：`mcp__github__list_issues` 返回的 raw JSON 是 47892 字符（约 12k tokens）——比整个 SYSTEM prompt 都大。

**长会话的 tokens 曲线**：
- 10 轮对话 ≈ 30-50k tokens
- 50 轮工具密集会话 ≈ 150-300k tokens
- 100 轮 ≈ 400-600k tokens

**两个限制会先后触发**：

| 限制 | 数量级 | 后果 |
|---|---|---|
| **`budget.limit = 600000`** | 60 万 tokens | 到上限就停 loop——钱包问题 |
| **模型 context window** | 128k-200k tokens | 直接 API 400 拒绝——完全没法工作 |

**Context window 才是硬墙**——比预算低一个数量级。压缩要解决**这道墙**，顺带缓解预算。

## 1. 三类内容与可压缩性

`messages + SYSTEM` 里的内容不是均匀的，可以分三类，**可压缩性完全不同**：

| 类别 | 例子 | 大小占比（典型） | 可压缩性 |
|---|---|---|---|
| **SYSTEM Prompt** | 身份、规则、工具目录 | 5-15% | **不能压**——压了模型不知道自己是谁 |
| **对话历史** | user + assistant text | 15-25% | 难压——语义连贯性重要 |
| **工具调用记录** | tool_call + tool_result | **60-80%** | **好压**——旧结果基本没用 |

**核心洞察**：工具结果是大头且容易压。为什么？

**具体例子**：你在第 3 轮 `read_file('config.json')` 得到 3000 tokens 内容——模型基于这个内容做了后续 5 步。到第 30 轮，这个 config.json 内容对后续决策**已经没用了**——但它一直挂在 messages 里占位置。

**理解这个之后，后面的设计就很自然**：先清理旧工具结果（**Microcompact**），不够再调 LLM 做摘要（**Summarization**）。

## 2. Layer 1：Microcompact——清理旧工具结果

最轻的一层。**不删消息、不改对话结构，只是把旧的工具结果替换成占位符**。

代码在 [`src/session/compressor.ts`](../src/session/compressor.ts) 的 `microcompact()`。

### 2.1 关键设计：保留消息，替换内容

```
[user] 帮我列 vercel/ai 的 issues
[assistant] tool_call: mcp__github__list_issues(...)
[tool] { ...47892 字符的 raw JSON... }              ← 压缩前
[assistant] 我看到 10 个 issue：...

     ↓ Microcompact

[user] 帮我列 vercel/ai 的 issues
[assistant] tool_call: mcp__github__list_issues(...)
[tool] [tool result cleared]                        ← 压缩后（<10 tokens）
[assistant] 我看到 10 个 issue：...                 ← assistant 的结论完整保留
```

**保留了什么**：
- 消息条数（`tool` 消息还在）
- 消息结构（`assistant.tool_call` → `tool.result` 配对完整）
- 工具名（`content[i].toolName` 还是 `list_issues`）
- assistant 基于原始数据得出的**结论**（"我看到 10 个 issue"）

**丢失了什么**：只有 tool_result 的**原始内容**——那些几十 KB 的 JSON。

**Token 收益**：3000 tokens → <10 tokens，压缩比 **99%+**。

### 2.2 什么工具的结果可以清

**核心区分**：**查询类** vs **副作用类**——只清前者。

**查询类**：返回值是**一次性快照**
- `read_file` — 读到什么就是什么
- `bash`（`ls`, `cat`, `git status`）— 输出反映当时的状态
- `grep` — 搜到的匹配是当时的结果
- `mcp__github__list_issues` — issue 列表是当时的快照

**副作用类**：返回值是**未来操作的锚点**
- `create_issue` → 返回新 issue 的 **id**，模型后面可能要 `add_comment(id, ...)`
- `write_file` → 返回"已写入 N 字符"，对判断"我刚写了什么"很关键
- `edit_file` → 同上

**清了副作用类工具的结果，会让模型忘记"我刚创建了什么"** —— 破坏执行链。

### 2.3 判定规则：白名单 + 命名启发式

**内置工具用精确白名单**（[`compressor.ts`](../src/session/compressor.ts#L12)）：

```ts
const CLEARABLE_BUILTIN_TOOLS = new Set([
  'read_file', 'bash', 'grep', 'glob', 'list_directory',
]);
```

**MCP 工具用动词启发式**：

```ts
const QUERY_VERBS = ['list', 'search', 'get', 'read', 'query', 'describe', 'show', 'fetch', 'screenshot'];
const QUERY_VERB_PATTERN = new RegExp(
  `^mcp__[^_]+__(${QUERY_VERBS.join('|')})(_|$)`,
);
```

匹配示例：

| 工具 | 判定 | 说明 |
|---|---|---|
| `mcp__notion__search_pages` | ✅ 清 | `search_` 前缀命中 |
| `mcp__notion__create_page` | ❌ 不清 | 副作用工具 |
| `mcp__supabase__query` | ✅ 清 | `query` 作为完整结尾——`(_|$)` 后缀设计的关键 |
| `mcp__browser__screenshot` | ✅ 清 | `screenshot` 语义上是"抓取当前状态" |
| `mcp__browser__click` | ❌ 不清 | 副作用 |

**默认策略**：命名不匹配的、未知内置工具——**保守不清**。宁可放过，不能误清。

### 2.4 保护最近 K 个 tool result

```ts
const KEEP_RECENT_TOOL_RESULTS = 3;
```

最近几轮的工具结果**很可能还在被模型引用**：
- 你刚 `read_file` 一个文件、模型下一步可能要基于内容 `edit_file`
- 你刚 `grep` 一个 pattern、模型下一步可能要 `read_file` 具体命中的行

清了这些"活的"结果，模型会"失忆"、要重新调工具——**得不偿失**。K=3 是 Claude Code 的经验值——覆盖"当前正在做的事"。

### 2.5 零成本、幂等、可反复调用

Microcompact 有三个好性质：

1. **零 LLM 调用**：纯字符串扫描，O(n)
2. **幂等**：反复跑不会误清（已清的内容再次匹配还是替换成同一个占位符）
3. **无损结构**：消息条数、role 分布、tool_call/result 配对都不变

所以可以**在每轮 loop 开头无脑调用**——没有清的就直接返回，成本近似 0。

## 3. Layer 2：Summarization——LLM 摘要压缩

如果 Microcompact 之后 context 还是太大，上第二层——调 LLM 把老对话压成一段结构化摘要。

代码在 [`src/session/compressor.ts`](../src/session/compressor.ts#L110) 的 `summarize()`。

### 3.1 触发条件

```ts
const CONTEXT_TOKEN_THRESHOLD = 6000;   // 6k tokens ≈ 24k 字符

if (estimateTokens(messages) < CONTEXT_TOKEN_THRESHOLD) {
  return { messages, summary: '', compressedCount: 0 };
}
```

**只在超阈值时调 LLM**——未超时零成本直接返回。所以跟 Microcompact 一样能"每轮 loop 无脑调用"。

**当前阈值 6k tokens 是调试值**——目的是让长会话很快就触发一次 `[Summarize]`、方便观察机制。

**生产建议 60k tokens**：
- 主流 model context 是 128k-200k
- 留一半给对话继续和输出
- 触发 → 压缩后 messages 变短 → 有充足空间继续

### 3.2 压缩 Prompt 的三个核心问题

这一层的核心不是代码——是 **prompt 怎么写**。

看 [`compressor.ts`](../src/session/compressor.ts#L131) 里的 `COMPRESS_PROMPT`：

```ts
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话
历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

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
```

一个好的压缩 Prompt 要解决三个问题：

**a. 保什么——给模板不给自由**

反例：`"帮我总结上面对话的要点"`——模型每次输出格式都不同，第一次给你 3 段、下一次给你 5 个 bullet、再下次是一大段文字。**后续对话根本没法利用**。

正解：**表格填空**——五个固定字段，每次输出结构一致。**模型不再"写作"、只在"填表"**——这是稳定性的关键。

**b. 不保什么——只要具体、可操作**

反例：`"用户希望获取信息"`——废话，等于没说。

正解：显式规定 "不要写笼统的概述，只保留具体的、可操作的信息"——把"用户希望获取信息"这种废话过滤掉。

**c. 标识符保护**

文件路径、UUID、版本号、错误信息——这些是**不可翻译改写**的。反例：模型可能会把 `/tmp/abc-123.log` "美化"成 `/tmp/日志文件.log`，或者把 `commit_sha: 3fa9c1b` 简化成 `最新提交`。这些改写会让后续操作全部失败。

**解法**：prompt 里明确 "文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写"。

### 3.3 核心原则：给模型一个表格让它填

**这是这一层最重要的一个洞见**——也是 Manus 分享过的最佳实践：

> **模板越具体，压缩结果越稳定。**

自由写作 → 每次输出格式都不一样 → 下游没法稳定利用
表格填空 → 次次稳定 → 下游可以针对每个字段做处理

跟人类写作训练一样：**开放题最难改卷、填空题最好评分**。压缩 prompt 本质是"让模型做填空题"。

### 3.4 保留最近 K 条 + 对齐 user 边界

```ts
const KEEP_RECENT_MESSAGES = 10;
```

**保留策略**：最后 10 条完整保留、前面的压成一段摘要。

**为什么必须"对齐 user 边界"**：

```
messages: [user, assistant.tool_call, tool.result, assistant, user, ...]
                                                             ↑
                                              这里切才安全（是 user）
```

**API 硬约束**：`assistant.tool_call` 后面必须紧跟对应的 `tool.result`。切在中间会导致下次请求 400。

**实现**（[`compressor.ts:194`](../src/session/compressor.ts#L194)）：

```ts
function alignToUserBoundary(messages: ModelMessage[], splitIdx: number): number {
  for (let i = splitIdx; i < messages.length; i++) {
    if (messages[i].role === 'user') return i;
  }
  return -1;   // 找不到 → 保留区里全是 assistant/tool → 当前轮未结束、先不压
}
```

**未找到 user 边界时不压**——宁可这一轮 context 超一点，也不能切坏结构。

### 3.5 role: 'user' 装摘要是妥协

看摘要消息的结构：

```ts
{ role: 'user', content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束]` }
```

**理论上更合适的是 `role: 'system'`**——摘要是"上下文注入"、不是用户说的话。但 AI SDK 5 的 messages 数组通常不允许中间插 system（system 只在最开始或 SYSTEM prompt 里）。

**用 `user` 的副作用**：
- 模型可能误以为"用户刚说了这段"、然后回复"好的我看到摘要了"
- 消息角色分布统计会失真

**缓解方式（两层）**：

1. **消息本身用强标记**：`[以下是之前对话的压缩摘要]` + `[摘要结束]`
2. **coreRules 补一句教育**（[`segments.ts`](../src/context/segments.ts#L14)）：
   ```
   如果 messages 里出现 [以下是之前对话的压缩摘要] 开头的消息，那是历史对话
   的摘要（不是用户新说的话），你需要基于摘要继续对话，无需对它做回应。
   ```

**这是 prompt engineering 补偿架构限制的典型例子**——SDK 不让改架构、就靠 prompt 教育模型正确处理。

## 4. 分层策略：先便宜后贵、能保结构不摘要

**核心原则**：Compaction 之前，永不 Summarization。

看 [`agentLoop`](../src/agent/loop.ts#L30) 里每轮的调用顺序：

```ts
while (step < MAX_STEPS) {
  // Layer 1：先跑 Microcompact（零成本、幂等）
  const { messages: compacted, cleared } = microcompact(messages);
  if (cleared > 0) messages.splice(0, messages.length, ...compacted);

  // Layer 2：Microcompact 之后如果还超阈值，才调 LLM 摘要
  const summarizeResult = await summarize(model, messages);
  if (summarizeResult.compressedCount > 0) messages.splice(...);

  // ... 原本的 loop 逻辑
}
```

**两层的对比**：

| 维度 | Microcompact | Summarization |
|---|---|---|
| **成本** | 零 LLM，O(n) 字符串扫描 | **一次 LLM 调用**（$0.01-0.10） |
| **可逆性** | 不改结构，只清内容 | 结构塌陷，老对话全丢 |
| **保留** | 消息条数、工具名、原始大小、assistant 结论 | 语义大意 |
| **触发** | 有旧工具结果就跑（每轮） | 超 60k tokens 才跑 |
| **幂等** | ✅ | ❌（每次调都花钱） |

**顺序不能反**：先 Summarization 会把还能保留的结构直接压塌——**贵的方法本可以避免**。

## 5. 级联压缩：不让摘要堆积成新的膨胀源

一个非显然的问题：**压缩之后再触发压缩，怎么办？**

**天真做法**：老摘要保持不变，新的一段再压一次——

```
第一次：老对话1 → summary_1
第二次：summary_1（保留）+ 老对话2 → summary_2  ← summary 数量线性增长
第三次：summary_1 + summary_2 + 老对话3 → summary_3
...
```

**结果**：多段摘要堆积在 messages[0..N]，总长度线性增长——**压缩没有解决膨胀，只是把膨胀延后了**。

**级联压缩的做法**：每次压缩把**上一次的摘要一起再压**——

```
第一次：老对话1 → summary_1
第二次：summary_1 + 老对话2 → summary_2   ← summary_1 被再次浓缩
第三次：summary_2 + 老对话3 → summary_3   ← 只有一段摘要在 messages[0]
```

**结果**：**任何时刻 messages[0] 都只有一段摘要**——摘要是"滚动更新的历史"、不是"堆积的段落"。

### 5.1 自动化：caller 无需管状态

看 [`summarize()`](../src/session/compressor.ts#L211) 的签名：

```ts
export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
): Promise<CompactionResult>
```

**只传 messages**——不需要 caller 记住 `existingSummary`。

**内部自动挖出上次摘要**（[`compressor.ts:184`](../src/session/compressor.ts#L184)）：

```ts
function extractExistingSummary(messages: ModelMessage[]): string {
  const first = messages[0];
  if (!first || first.role !== 'user') return '';
  const content = typeof first.content === 'string' ? first.content : '';
  if (!content.startsWith(SUMMARY_PREFIX)) return '';
  // 从 messages[0] 里挖出上次的摘要
  return content.slice(SUMMARY_PREFIX.length, content.lastIndexOf(SUMMARY_SUFFIX)).trim();
}
```

**这个自动化的连锁收益**：跨进程续会话（`--continue`）时，摘要作为 messages[0] 被 SessionStore 持久化。下次启动加载出来——**级联压缩仍然生效**、caller 无感知。

### 5.2 压缩 Prompt 里的合并结构

看合并的输入：

```ts
const userPrompt = existingSummary
  ? `## 已有摘要\n\n${existingSummary}\n\n## 新对话\n\n${conversationText}`
  : conversationText;
```

**给压缩 LLM 看的**：明确区分"已有摘要"和"新对话"——让它知道**要把两者合并成新的一段**，而不是并列地保留两段。

## 6. 稳定性保障：四个必踩的坑

前面 §2-§5 讲的是**压缩怎么工作**。这一节讲**压缩怎么"不出事"**——生产环境跑久了才会暴露的稳定性问题。

**四个支柱**：标识符保护、失败降级、模型选型、触发阈值。当前项目是教学定位——每个支柱**思路已经落地**，但**生产化的完整实现**部分留作待办。这一节讲清"每个支柱当前做了什么、生产该补什么"。

### 6.1 标识符保护——已实现

**问题**：对话里的 `src/tools/tool-registry.ts` 这类路径，模型在摘要里可能"翻译"成"工具注册文件"。后续对话模型就找不到这个文件了。UUID、版本号、错误信息同理。

**解法**：在压缩 Prompt 里明确要求原样保留。代码在 [`compressor.ts:110`](../src/session/compressor.ts#L110)：

```
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
```

**当前状态**：✅ **已做**——这是 §3.2 讲的"标识符保护"，直接落在 prompt 里。

**生产补充**：如果发现某类模型仍然会改写，可以加**后置校验**——比较摘要前后的路径正则命中集合，缺失的路径手动"钉"回去。这一层教学项目没做。

### 6.2 失败降级——**待做**

**问题**：`generateText()` 会失败——网络抖动、模型 rate limit、超时、上游 5xx。当前代码 [`compressor.ts:242`](../src/session/compressor.ts#L242) 直接 `await`、没 catch。

```ts
const { text: summary } = await generateText({ ... });   // ← 失败会抛异常向上传播
```

抛异常 → `agentLoop` 里也没 catch → **整个 loop 崩掉**。

**生产该做**：包 try-catch，失败返回**原始 messages**（`compressedCount: 0`）——**压缩失败不能影响 Agent 的正常工作**。

```ts
try {
  const { text: summary } = await generateText({ ... });
  return { messages: [...], summary, compressedCount: toCompress.length };
} catch (err) {
  console.warn(`[Summarize] LLM 调用失败，跳过本次压缩: ${err}`);
  return { messages, summary: '', compressedCount: 0 };   // 原样返回
}
```

**进一步**：加**连续失败计数**——像 Claude Code 的 Auto-compact 那样，连续 3 次失败就**放弃压缩、不再尝试**（避免每轮 loop 都重试一次失败的调用）。可以在 `summarize()` 内部维护 `let consecutiveFailures = 0`、超过阈值时直接返回原样、日志提示用户"压缩机制已禁用，请检查配置"。

**当前状态**：❌ **未做**——教学项目里"压缩失败 = 明显崩溃"反而有教学价值（能看到出问题），生产必须补。

### 6.3 便宜模型做压缩——**待做**

**问题**：当前用主 agent 的 model 做压缩（[`agent/loop.ts:42`](../src/agent/loop.ts#L42)）：

```ts
const summarizeResult = await summarize(model, messages);
//                                       ↑ 主力模型（DeepSeek-V4 / GPT-5 / Claude Opus 5）
```

一次摘要输入可能几千到几万 tokens、输出 800 字左右——**用主力模型这一次调用要几分钱**。长会话累计触发几十次——**成本可观**。

**核心洞察**：**压缩不需要复杂推理能力**——它只是"按模板填表"。摘要 prompt 已经把结构规定得死死的，模型不需要思考、只需要把对话内容映射到 5 个字段里。这个任务 Haiku 4.5 / Gemini Flash / DeepSeek 的小版本都能干、成本 1/10 起。

**Claude Code 的做法**：Auto-compact **用的不是 Opus 而是 Haiku**——同样思路。

**生产该做**：API 演进而非重构——

```ts
export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
  options?: { compactModel?: LanguageModel },   // ← 可选参数
): Promise<CompactionResult> {
  const compactModel = options?.compactModel ?? model;   // 没传就 fallback 到主模型
  // ...
  const { text: summary } = await generateText({
    model: compactModel,   // ← 用便宜模型
    system: COMPRESS_PROMPT,
    prompt: userPrompt,
  });
}
```

**当前状态**：❌ **未做**——教学项目里用一个模型简单直接；生产该加。

### 6.4 触发阈值——**当前是调试值**

**问题**：阈值设太低 → 频繁压缩，每次都调 LLM 浪费钱；设太高 → 来不及压缩就溢出 context window，API 直接 400。

**Claude Code 的经验值**：**上下文窗口的 87%**。200k window → 174k 阈值、128k window → 111k 阈值。

**当前状态**：⚠️ **调试值 6000 tokens**（[`compressor.ts:93`](../src/session/compressor.ts#L93)）——目的是让长会话很快就触发一次 `[Summarize]`、方便观察机制。

**生产该做**：根据你的模型 context window 算：

```ts
// 不同模型的推荐阈值（约上下文窗口 × 87%）
const CONTEXT_TOKEN_THRESHOLD_TABLE = {
  'deepseek-v4': 111_000,      // 128k × 87%
  'gpt-5':        174_000,      // 200k × 87%
  'claude-opus-5': 174_000,     // 200k × 87%
  'claude-haiku-4-5': 174_000,  // 200k × 87%
};
```

**87% 而不是 100% 的原因**：留出**Layer 2 摘要输出的空间**——如果卡到 100% 才触发，摘要生成时会撑爆 window、请求直接 fail。**87% 留 13% 给"压缩本身的运行开销"**。

**当前项目改法**：环境变量控制、可以按环境切换：

```ts
const CONTEXT_TOKEN_THRESHOLD = Number(process.env.COMPACT_THRESHOLD) || 6000;
```

Dev 用 6000 立即触发、prod 环境 export 到 174000。

### 6.5 稳定性四支柱总结

| 支柱 | 当前项目 | 生产必做 |
|---|---|---|
| 标识符保护 | ✅ prompt 里明确要求 | prompt + 后置正则校验 |
| 失败降级 | ❌ 直接抛异常 | try-catch + 连续失败计数 |
| 便宜模型 | ❌ 用主模型 | API 加可选 `compactModel` 参数 |
| 触发阈值 | ⚠️ 6000（调试值） | context window × 87% |

**这四个支柱共同保证：压缩机制 fail 时 Agent 不崩、压缩成本可控、压缩效果稳定。**

## 7. 已知的坑与后续方向

**1. `extractExistingSummary` 依赖字符串前缀**

现在靠 `SUMMARY_PREFIX = '[以下是之前对话的压缩摘要]'` 识别。如果哪天用户真的说了这句话（罕见但可能）、或者改了 prefix 忘了同步——识别就失效。

修法：给摘要消息加个 metadata 字段（AI SDK 的 `providerOptions`）作为强标记。留作后续。

**2. `estimateTokens` 是粗略估算**

字符数/4 是英文近似，中文会**低估**（中文 1 字符 ≈ 1-2 tokens）。低估比高估安全（提前触发的代价大），但会导致中文长会话的 threshold 相对更"松"。

修法：接入 `js-tiktoken` 或用 AI SDK 的 usage 反馈。留作后续。

**3. 摘要质量取决于压缩 LLM 的表现**

`generateText` 走的是 agentLoop 的**同一个 model**。如果这个 model 摘要能力弱、或者 prompt 执行不严——摘要出来质量差、后续对话就会失去信息。

生产上应该允许指定**便宜但快的摘要模型**（比如 haiku）——跟主 loop 用的 model 解耦。当前 API 没做这个区分。

**4. `role: 'user'` 装摘要的副作用**

模型偶尔会误把摘要当成用户新说的话回复。虽然 coreRules 有教育，但 prompt engineering 不 100% 可靠——尤其是能力较弱的模型。

修法：等 AI SDK 或模型 API 支持"中间插 system"的语义。

**5. 摘要不进 SessionStore 的时间戳**

SessionStore 存的是原始 messages 序列。摘要消息虽然作为 messages[0] 存了，但**它替换了原本的 N 条消息** —— 磁盘上的 JSONL 是"user0 / assistant0 / tool0 / ... 全部保留"、内存里的 messages 是"summary / user_recent / ..."。

**这是好事**：磁盘保留全量历史（可 grep、可审计）、内存跑 Agent 用压缩版（省 token）。但**恢复时是从磁盘加载全量**——恢复出来的 messages 又是完整的原始序列，下一轮 loop 才会重新压。这个"每次续会话都要重压一遍"的开销可接受。

**6. 没有"压缩前的 messages 快照"**

一旦压缩了，内存里的原始 messages 就变成摘要+近期了。如果用户想"看到未压缩的完整对话"（比如 debug 一个错误的摘要），得从 SessionStore 重新读。当前没有 UI 呈现这个，日志也只打了 `compressedCount`。

**7. 短对话上 Layer 2 反而"膨胀"**

一次真实的调试测量：

```
[压缩前]                 16 条消息, ~416 tokens
[Layer 1: Microcompact]  清理了 1 个, ~394 tokens
[Layer 2: Summarization] 压缩了 8 条, ~425 tokens  ← 反而涨了
[压缩后]                 9 条消息, ~425 tokens
```

Layer 2 之后 tokens 反而涨了——因为**摘要本身有模板开销**（5 个 `## 字段`），而被压的老对话已经被 Layer 1 清成占位符了。**当被压的内容本来就短时，摘要的固定开销超过收益**。

**这不是 bug，是压缩的边界条件**：
- 生产阈值（60k）下这种情况不会出现——真触发时被压的老对话至少几万 tokens，摘要 800 字是巨大收益
- 调试阈值（6k）下故意让它触发，只是为了"证明机制能跑"、不是"衡量压缩效果"

**教训**：`compressedCount` 是"结构简化的信号"，不是"tokens 减少的信号"。摘要真实价值是**"腾出空间给未来"**——虽然当下不省 tokens，但接下来能连续加许多轮对话都不再触发 Summarization。压缩曲线的目标是**"永远在阈值下振荡"**，不是"当下就变短"。

**8. `cleared` 计数的幂等 bug（已修）**

一次真实的调试观察，恢复历史会话时看到：

```
[压缩前] 69 条消息, ~6444 tokens
[Layer 1: Microcompact] 清理了 11 个工具结果, ~6444 tokens  ← tokens 完全没变
[压缩后] 69 条消息, ~6444 tokens
```

**"清理了 11 个 但 tokens 不变"** —— 这不是 tokens 估算的问题，是 microcompact 的 **计数 bug**。

**根因**：这 11 个 tool_result **已经是** `[tool result cleared]` 占位符了（上次会话 microcompact 过、SessionStore 存的是压缩后的版本、`--continue` 加载回来）。当前一版的代码：

```ts
if (!isClearableToolName(part.toolName)) return part;
clearedInThisMsg = true;             // ← 只要工具名可清就计数
return { ...part, output: textToolResultOutput(CLEARED_MARKER) };
```

**只判断工具名**，不判断**原本内容是不是已经是占位符**。所以每次 microcompact 都会"再清一次"、`cleared` 虚高、但实际内容没变。

**修法**：加占位符检测（[`compressor.ts:76`](../src/session/compressor.ts#L76)）——

```ts
const alreadyCleared =
  part.output.type === 'text' && part.output.value === CLEARED_MARKER;
if (alreadyCleared) return part;    // ← 幂等：已经清过就不再计数
```

**教训**：**函数幂等 ≠ 计数幂等**。前一版的 microcompact 内容层面是幂等的（重复调用不会有副作用、结果一样），但**计数不幂等**——`cleared` 每次都递增。修好之后：反复调用同样的 messages，`cleared` 稳定为 0。

**9. Session 磁盘存的是压缩后的、不是原始的**

跟 [session-persistence.md](session-persistence.md) 里最初的语义有偏差。看 [`src/index.ts`](../src/index.ts) 的落盘时机：

```ts
messages.push({ role: 'user', content: trimmed });
await agentLoop(...);              // ← 内部会跑 microcompact / summarize，修改 messages
for (let i = beforeCount; ...) {
  store.append(messages[i]);       // ← append 在 agentLoop 之后
}
```

**append 发生在压缩之后**——磁盘存的是**压缩后的** messages。这带来一个已知限制：

- **磁盘小、加载快** ✓
- **无法反悔压缩** ✗——如果某次摘要错了、想恢复原始对话，磁盘上没有原始数据

想改成"磁盘存原始"，两种做法：
- **A**：`store.append` 提前到 push 之后立刻发生（agentLoop 之前）
- **B**：让 store 在 messages push 时自动 append（Proxy 或 addMessage helper）

生产上通常选 A + 一份摘要 metadata 分开存（磁盘存原始对话 + 摘要缓存）。当前项目是教学定位，先保持现状——把这个 tradeoff 记下来。

**10. 可清白名单的维护成本**

一次真实的调试发现：一个 91 条消息的会话，前一版 microcompact **每轮只清 1 个、tokens 几乎不降**。深入排查发现——**`web_search` / `web_fetch` 根本不在白名单里**：

```ts
// 前一版
const CLEARABLE_BUILTIN_TOOLS = new Set([
  'read_file', 'bash', 'grep', 'glob', 'list_directory',
  // ← 漏了 web_search / web_fetch
]);
```

这两个工具的返回值恰好是**最容易大**的（一次 web_fetch 网页可能几万字符），却完全逃过了压缩。补进白名单后：

```
[压缩前]                 91 条消息, ~13633 tokens
[Layer 1: Microcompact] 清理了 18 个工具结果, ~????  ← 数量从 1 → 18
```

**根因**：白名单是**手工维护**——每加一个新的查询类内置工具都要**同时记得**同步 microcompact 的白名单。跟"searchHint 运维成本"是同一类问题（[tool-search-design.md §6](tool-search-design.md#6-已知的坑与后续方向)）。

**长远解法**：给 `ToolDefinition` 加 `isMicrocompactable?: boolean`，让工具定义时自己声明：

```ts
export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  shouldDefer: true,
  isMicrocompactable: true,  // ← 工具自己声明
  // ...
};
```

Compactor 不再维护白名单、从 registry 查询即可。当前 5-7 个工具规模先不重构——但**新加内置查询类工具时必须同步 microcompact 白名单**，是必踩的坑。

---

## 相关文档

- [session-persistence.md](session-persistence.md) — 摘要如何跨进程持久化（SessionStore 存原始、内存跑压缩版）
- [prompt-pipe-design.md](prompt-pipe-design.md) — `coreRules` 里教模型识别摘要消息，是 prompt engineering 补架构限制的例子
- [tool-search-design.md](tool-search-design.md) — 工具目录也是"每轮变化"的动态内容，跟本篇的 cache 讨论互补
- [agent-loop-protections.md](agent-loop-protections.md) — Agent Loop 三道防线：预算和压缩是"两个不同数量级"的问题（预算是钱包、压缩是 context 硬墙）
