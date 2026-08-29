# 零 LLM 防线：TokenTracker + applyDefense 三层协同

> 配套 [../README.md](../README.md) 的拓展阅读。前一篇 [context-compression.md](context-compression.md) 讲了 Microcompact + Summarization 两层策略。这一篇讲**Summarization 之前的三层零 LLM 防线**——为什么这些"便宜的方法"能承担 80% 的压缩需求、TokenTracker 怎么精确感知空间、TTL 修剪的两条铁律为什么必须守住。

## 目录

- [0. 为什么需要"Summarization 之前"的层](#0-为什么需要summarization-之前的层)
- [1. TokenTracker：精确基准 + 粗估增量](#1-tokentracker精确基准--粗估增量)
- [2. Layer 2：工具结果动态截断](#2-layer-2工具结果动态截断)
- [3. Layer 3：TTL 修剪的两档设计](#3-layer-3ttl-修剪的两档设计)
- [4. 两条铁律：只修剪 tool、错误经验保留](#4-两条铁律只修剪-tool错误经验保留)
- [5. WeakMap 存 timestamp：一个语义细节](#5-weakmap-存-timestamp一个语义细节)
- [6. applyDefense：三层协同的聚合入口](#6-applydefense三层协同的聚合入口)
  - [6.1 为什么 TTL 在截断之前](#61-为什么-ttl-在截断之前)
  - [6.2 跟 microcompact / summarize 的关系](#62-跟-microcompact--summarize-的关系)
  - [6.3 与 LLM 压缩的配合关系](#63-与-llm-压缩的配合关系)
  - [6.4 数据分工：即时防线管 tool_result、LLM 管对话历史](#64-数据分工即时防线管-tool_resultllm-管对话历史)
  - [6.5 行业对齐](#65-行业对齐)
- [7. REPL 快捷命令：让防线可见](#7-repl-快捷命令让防线可见)
- [8. 已知的坑与后续方向](#8-已知的坑与后续方向)

## 0. 为什么需要"Summarization 之前"的层

前一篇 [context-compression.md](context-compression.md) 里已经有分层：Microcompact（零 LLM）先跑、Summarization（有 LLM）兜底。

但**这个分层不够**。看真实数据：

- Microcompact 每次只清"最近 K 个之外的旧 tool_result"——按**消息数**为单位
- Summarization 一次 LLM 调用几秒 + 几分钱

两者之间**有一大片空间没利用**：

**a. 单条太大**（一个 `web_fetch` 返回 5 万字符）—— Microcompact 会保护它（因为在最近 3 个内）、但它一条就顶爆预算
**b. 老得跨小时**（用户 10 分钟前调的工具、现在早忘了）—— Microcompact 按"最近 K 条"保护、K=3 保住的可能都是"1 小时前的"
**c. 感知不准**（字符/4 估算中文低估 30%）—— 触发时机不对

**根本问题**：**调 LLM 本身就要花时间和钱**。一次摘要几秒 + 几千 tokens 消耗——如果每轮都检查是否需要压缩，Agent 响应速度和成本都受影响。

**实际上，大部分上下文膨胀不需要动用 LLM**：
- 读了个 5 万字符的文件 → 截断到 5000 就够了
- 10 分钟前的 grep 结果 → 直接清掉
- 这些都是**纯字符串操作，零 LLM 成本、毫秒级完成**

所以在 Microcompact 和 Summarization 之间，我们再插三层**零 LLM 的即时防线**：

```
Layer 1: TokenTracker      ← 感知（不省 tokens、让触发决策准）
    ↓
Layer 2: Truncate          ← 大小防线（单条 > 50% window 截 / 总量 > 75% 清）
    ↓
Layer 3: TTL Prune         ← 时间防线（5 min 软 / 10 min 硬）
    ↓
Microcompact               ← 零 LLM 的第 4 层
    ↓
Summarization              ← 有 LLM 的最后兜底
```

**这一篇讲前三层**——它们承担了 80% 的压缩需求，让 LLM Summarization 只在真正必要时才启动。

## 1. TokenTracker：精确基准 + 粗估增量

前面所有讨论都建立在一个前提上：**我们知道当前 messages 有多少 tokens**。这个"知道"看似简单，实际有陷阱。

### 1.1 三种候选估算方案

| 方案 | 精度 | 成本 | 缺点 |
|---|---|---|---|
| **A. tiktoken 精确计数** | ★★★★★ | 高（初始化几百 ms、每次 encode 几十 ms） | 不同模型 tokenizer 不同、要装 wasm |
| **B. 字符数 / 4** | ★★☆ | 极低（微秒级） | 中文低估 30%+ |
| **C. API 返回 usage.inputTokens** | ★★★★★ | 零（本来就有） | 只有**调完 API 才知道** |

**B 的中文问题很严重**——1 个汉字 ≈ 1.5-2 tokens、按 4 字符/token 估算 = 严重低估 → 触发太晚 → 撞 API 硬墙。

**C 是精确的、但滞后的**——decision 时刻它还没来。

### 1.2 折中方案：C 校准 + B 增量

看代码 [`src/session/defense.ts`](../src/session/defense.ts) 的 `TokenTracker`：

```ts
export class TokenTracker {
  private lastPreciseCount = 0;   // 上次 API 返回的精确 input tokens
  private pendingChars = 0;       // 上次 API 之后新增/减少的字符净增量

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0;          // 精确值到了，粗估增量清零
  }

  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message);
  }

  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  get estimatedTokens(): number {
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4);
  }
}
```

**核心机制**：
1. 每次 API 返回时用 `usage.inputTokens` 作为**精确基准**（`updateFromAPI`）
2. 中间新增的 message 用字符/4 粗估补上（`addMessage`）
3. 压缩发生时记录字符差、不重新全量计数（`replaceMessages`）

### 1.3 关键性质：偏差不累积

假设粗估有 15% 偏差：

```
只用 B（纯字符/4）：
  第 1 轮：估算偏差 15%
  第 2 轮：又偏 15%
  第 10 轮：累计偏差可达 200%   ← 灾难

TokenTracker（精确基准 + 增量）：
  第 1 轮：pendingChars 偏差 15%
  第 2 轮：API 返回，updateFromAPI 重置为精确值 → 偏差归零
  第 3 轮：又是 pendingChars 15% 偏差
  ...
  单轮偏差 ≤ 15%，跨轮永远从精确值重启
```

**"精确基准每轮 reset 增量"是这个设计的核心红利**——粗估的错误不会累积、每 API 一次调用都自动修正。

### 1.4 为什么不接 tiktoken

三个原因：
1. **初始化几百 ms、encode 几十 ms**——每轮 loop 都跑代价大
2. **不同模型 tokenizer 不一样**——GPT vs Claude vs DeepSeek，需要维护多个 tokenizer 或忍受偏差
3. **二元决策够用**——"要不要触发压缩"是 boolean、10-20% 精度完全够

**当你已经有 API 精确校准时，中间的粗估只需要"大致准"**——这个洞察让我们跳过了 tokenizer 的巨大工程复杂度。

## 2. Layer 2：工具结果动态截断

### 2.1 跟已有 truncateResult 的区别

前面 tool system 里的 [`truncateResult`](../src/tools/tool-registry.ts#L267) 是**注册时静态截断**——工具生成结果时按 `maxResultChars` 砍一刀。

这一层是**运行时动态截断**——根据当前 messages 全局总量做兜底。

**为什么两层都要**：
- 静态截断防的是"单次生成太大"
- 动态截断防的是"N 个 tool_result 累加起来超预算"
- 它们各管一维

### 2.2 双 Pass 设计

OpenClaw 的双重约束（我们对齐）：
1. 单条工具结果 ≤ 上下文窗口的 **50%**
2. 总上下文 ≤ 上下文窗口的 **75%**

对应两个 pass ([`defense.ts`](../src/session/defense.ts))：

**Pass 1: 单条截断**——遍历每条 tool 消息、超过 `maxSingleResult` 的做 Head/Tail 60/40 分割：

```ts
const head = outputText.slice(0, Math.floor(max * 0.6));
const tail = outputText.slice(-Math.floor(max * 0.4));
return `${head}\n\n[truncated: ${outputText.length} → ${max} chars]\n\n${tail}`;
```

**Pass 2: 总量控制**——Pass 1 之后总字符还超 75%，从最老的 tool_result 开始整体清空：

```ts
result[i] = { ...msg, content: msg.content.map(part => ({
  ...part,
  output: textToolResultOutput(`[compacted: ${toolName} output removed to free context]`),
})) };
```

**为什么 Pass 2 用"整体清空"而不是"再截"**：Pass 1 已经把单条收窄过了、再截意义不大——不如直接标记 `[compacted]`、彻底释放这条的空间。

### 2.3 一个字符/token 换算的细节

看 config：

```ts
const DEFAULT_TRUNCATE_CONFIG = {
  maxSingleResult: CONTEXT_WINDOW * 0.5 * 2,      // 200k
  contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4,  // 600k
};
```

**单条用 2 chars/token、总量用 4 chars/token**——为什么不一致？

- **单条**：一个 tool_result 可能是纯中文（比如 markdown 文档、日志）——中文 ≈ 2 chars/token，取**保守估计**（中文近似）→ 低估字符/token 比例、留出安全余量
- **总量**：整个 messages 数组里英文占多数（tool schema、代码、URL）——按 4 chars/token 算合理

**这两个数字都是"往严格方向偏"** —— 宁可提前截、不能来不及截。

## 3. Layer 3：TTL 修剪的两档设计

### 3.1 时间衰减的核心洞察

**老的工具结果几乎一定比新的更没用**：
- 5 分钟前读的文件内容——大概率已经不影响当前决策
- 10 分钟前的 grep 结果——基本可以扔了

但直接删掉会破坏对话结构（tool_call/tool_result 配对断裂 → API 400），所以 TTL 修剪跟 microcompact 一样——**保留消息、替换内容**。

### 3.2 两档设计：软 → 硬

看代码 [`defense.ts`](../src/session/defense.ts)：

```ts
const SOFT_PRUNE_MS = 5 * 60 * 1000;   // 5 分钟软修剪
const HARD_PRUNE_MS = 10 * 60 * 1000;  // 10 分钟硬清除
```

三个时间区间：

| Age | 处理 | 保留内容 |
|---|---|---|
| **0 - 5 min** | 不动 | 完整原文 |
| **5 - 10 min** | 软修剪 | 头 1500 字符 + 尾 1500 字符 + `[soft pruned: N chars omitted]` |
| **> 10 min** | 硬清除 | 只留 `[tool result expired: {toolName}]` |

**为什么两档而不是一刀切**：

- **软修剪的价值**：模型还能看到"文件开头长啥样、结尾长啥样"、知道"发生过这个结果、大致内容是什么"
- **硬清除的价值**：只保留"发生过什么"的事实，"具体内容"释放

**信息价值随时间递减**这个直觉、落到分档实现——比"过了 5 分钟就全清"更精细。

### 3.3 一个小陷阱：软修剪的最小尺寸

看这段：

```ts
const minSize = SOFT_PRUNE_HEAD_CHARS + SOFT_PRUNE_TAIL_CHARS;
if (text.length <= minSize) return part;
```

**如果原文本身就小于 3000 字符**（head+tail 总长）——软修剪没意义。原文比"占位符 + head + tail"还短、动手后反而更长。**直接跳过、不动**。

## 4. 两条铁律：只修剪 tool、错误经验保留

这两条铁律**必须守住**、任何一条破了都会引起严重的 bug。

### 4.1 铁律 1：只修剪 tool 消息

```ts
if (msg.role !== 'tool') return msg;
```

**user / assistant 永不修剪**——这是所有修剪层的共同底线。

**原因**：user 消息是"用户说了什么"、assistant 消息是"模型思考和回复"—— 修剪它们等于**篡改对话本身**、模型的连续性直接崩溃。

只有 **tool 消息（工具的返回值）** 才可以修剪——因为它们是"外部数据的一次快照"、丢了还能重新调工具再拿。

### 4.2 铁律 2：错误经验保留

```ts
const ERROR_PATTERN = /error|失败|不存在|denied|timeout|失效|拒绝|超时|not found|forbidden|exception/i;
const hasError = msg.content.some(p => {
  if (p.type !== 'tool-result') return false;
  return ERROR_PATTERN.test(toolResultOutputToText(p.output));
});
if (hasError) return msg;
```

**为什么错误信息不能修剪**：

模型需要记住"这条路走不通"。如果 10 分钟前调 `read_file('/nonexistent')` 失败、错误信息被 TTL 清了——模型很可能再次尝试同样的错误操作、浪费轮次和 token。

**正则的三个设计选择**：

1. **中英混合覆盖 10 种关键词**——`error / 失败 / 不存在 / denied / timeout / 失效 / 拒绝 / 超时 / not found / forbidden / exception`
2. **不区分大小写**（`/i` flag）——`ERROR` / `Error` / `error` 都命中
3. **宽松而不精确**——宁可多留一些不修剪、不能把"这条路走不通"的信号丢了

**"错误经验保留"是 Agent 学习的关键**——不是靠权重更新、是靠 context 里的历史失败记录。

## 5. WeakMap 存 timestamp：一个语义细节

TTL 修剪需要知道每条消息的年龄——但**内存里的 `ModelMessage` 没有 timestamp 字段**。三种存法：

### 5.1 三种候选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. 平行数组 `timestamps[i]`** | 直观 | 6 处 push/splice 都要同步——容易漏 |
| **B. `providerOptions` 塞时间戳** | 序列化天然带 | 用 SDK 未定义字段、兼容性风险 |
| **C. `WeakMap<Message, Date>`** | push 时一处 set / 消息 GC 时自动清理 | 语义有一点复杂度 |

### 5.2 我们选 C 的理由

看真实的 mutation 点：

```
messages.push(userMsg);                                     ← index.ts
messages.push({ role: 'user', content: '...' });            ← agentLoop 循环检测注入
messages.push(...stepResponse.messages);                    ← agentLoop 每步
messages.splice(0, messages.length, ...compacted);          ← microcompact
messages.splice(0, messages.length, ...summarizeResult...); ← summarize
messages.push(entry.message);                               ← SessionStore.load
```

**6 处修改**。如果用平行数组：
- 每处 push 都要 `timestamps.push(...)`
- 每处 splice 都要重维护整个数组
- **漏一处就数据不一致**

WeakMap 只要 **push 时一处** `markMessageTime(msg)`——`splice` 时旧对象引用消失、自动 GC 出 map。

### 5.3 恢复会话时的兼容性

`--continue` 加载历史时，messages 是从 JSONL 反序列化出来的**新对象**——WeakMap 里没有它们的 entry。

解决：`pruneByTTL` 里明确规定：

```ts
if (!ts) return msg;   // 没时间戳 = 不修剪
```

**没时间戳的消息默认按"很年轻"处理**、不动。这是**保守策略**——宁可不清、不能误清整个历史。要清得让 caller 从 `SessionEntry.timestamp` 主动重建 map（目前项目还没做这一步、留作后续）。

## 6. applyDefense：三层协同的聚合入口

三层零 LLM 防线本身可以独立调用，但**顺序有讲究**。看 [`defense.ts`](../src/session/defense.ts) 的 `applyDefense`：

```ts
export function applyDefense(messages: ModelMessage[]): DefenseResult {
  // Step 1: TTL 修剪（时间维度）
  const ttl = pruneByTTL(messages);
  // Step 2: 大小截断（Pass 1 单条 + Pass 2 总量）
  const trunc = truncateToolResults(ttl.messages);

  return { messages: trunc.messages, ...ttl, ...trunc };
}
```

### 6.1 为什么 TTL 在截断之前

看两种顺序的效果：

**顺序 A：先 TTL，后截断**（当前）
- TTL 清掉 10 min 前的一条 5 万字符 tool_result → 变成 `[tool result expired]`（<50 字符）
- 截断发现"总量已经很小了"、什么都不用做

**顺序 B：先截断，后 TTL**
- 截断花时间把这条 5 万字符切成 head 60% + tail 40%（2 万字符）
- TTL 又把这条整个清空 → 前面的截断白做了

**顺序 A 更高效**——先做"更暴力的清理"、避免"温柔的处理"被浪费。

### 6.2 跟 microcompact / summarize 的关系

`applyDefense` 完了之后，`agentLoop` 才调 microcompact 和 summarize：

```ts
while (step < MAX_STEPS) {
  const defense = applyDefense(messages);       // 零 LLM
  // ... splice + log ...

  const { messages: compacted, cleared } = microcompact(messages);   // 零 LLM
  // ...

  const summarizeResult = await summarize(model, messages);  // 有 LLM
  // ...
}
```

**四层的执行顺序**（同一个 loop 内、按"便宜到贵"）：

```
1. TTL 修剪（applyDefense 里）        ← 时间维度，最便宜
2. 大小截断（applyDefense 里）        ← 大小维度，仍便宜
3. Microcompact                        ← 消息数维度、幂等
4. Summarization                       ← 有 LLM、最贵、最后兜底
```

**"便宜的先跑、贵的最后兜底"** 是整个系统的顶层原则。每一层都可能让下一层"没事做"——从而节省时间和成本。

### 6.3 与 LLM 压缩的配合关系

三层即时防线和 LLM 摘要压缩**不是互斥的、是分工配合的**：

**即时防线**（Layer 2 + Layer 3 + Microcompact）：
- 每轮对话前**自动执行**
- 零 LLM 成本、毫秒级完成
- 负责：截断超大结果、清理过期内容、追踪 token 用量

**LLM 摘要压缩**（Summarization）：
- 只在即时防线**不够用的时候**才触发
- 上下文达到 75% 以上、即时防线已经清理了能清的、历史对话实在太多——只能调 LLM 做摘要

**整个防御体系的执行顺序**：

```
截断 (Layer 2)
    ↓
TTL 修剪 (Layer 3)
    ↓
Token 估算 (Layer 1，判断是否需要更贵的方案)
    ↓
需要？→ Microcompact（零 LLM 的第 4 层，按消息数清老 tool_result）
    ↓
还不够？→ Summarization（LLM 摘要，最后兜底）
```

**从轻到重、能用简单手段解决的绝不上复杂方案**——这是整个防御体系的顶层哲学。

### 6.4 数据分工：即时防线管 tool_result、LLM 管对话历史

一个典型的 50 轮编程对话中的**上下文构成**：

| 类别 | 占比 | 主要处理者 |
|---|---|---|
| **工具调用记录（tool_result）** | **60-80%** | 三层即时防线（截断、TTL、Microcompact） |
| **对话历史（user/assistant）** | **20-30%** | LLM 摘要压缩（Summarization） |
| **SYSTEM prompt** | **5-15%** | 不压（Prompt Pipe 管理） |

**三层即时防线主要就是在对 60-80% 那部分动手**——因为它们是"外部数据快照"，用完就作废、可以无损清理。

**对话历史本身很难无损压缩**——user 说过什么、assistant 回复过什么、都是"不可再生"的信息。想收窄它们必须用 LLM 做**有损的、结构塌陷的**摘要。**这就是 Summarization 存在的位置**——处理即时防线管不了的那 20-30%。

### 6.5 行业对齐

这套思路跟主流 Agent 系统一致：

- **Claude Code 的 Microcompact**：在 API 侧自动清理旧工具结果——类似我们的 Microcompact
- **OpenClaw 的 Tool Result Context Guard**：每次发送前做实时截断——类似我们的 Layer 2 动态截断
- **它们的共同原则**：**先 Compaction 后 Summarization、先无损后有损**

**实现细节不同，但背后的原则完全一致**：**Agent 的绝大部分上下文膨胀是工具结果导致的、而工具结果最好压——用零 LLM 的方式先把这块处理干净、剩下的才交给昂贵的 LLM 摘要**。

## 7. REPL 快捷命令：让防线可见

零 LLM 防线的**教学困境**：真实场景下要几十轮 tool 调用累积、才会触发一次防线——**跑一晚上都看不到效果**。

解法：加三个 REPL 快捷命令（[`src/index.ts`](../src/index.ts)），直接演示：

```
You: sim           ← 注入 20 条模拟历史（含大量工具结果 + 时间戳）
You: status        ← 查看当前消息数和 token 估算
You: defend        ← 手动触发三层防线、打印节省了多少 tokens
```

### 7.1 `simulateHistory` 的巧妙之处

看代码：

```ts
function simulateHistory(pairCount: number): ModelMessage[] {
  for (let i = 0; i < pairCount; i++) {
    // 前一半打 12 分钟前（老、触发硬清）、后一半打 7 分钟前（触发软修剪）
    const ageMs = i < pairCount / 2 ? 12 * 60_000 : 7 * 60_000;
    const when = new Date(now - ageMs);
    // ...
    markMessageTime(asst, when);
    markMessageTime(tool, when);
  }
}
```

**关键**：给 message 打**过去的时间戳**——立刻就能触发 TTL 修剪。不需要真等 10 分钟。

一半打 12 min 前 / 一半 7 min 前——**同时演示硬清和软修剪两档效果**：

```
[Layer 3 TTL] 软修剪: 5, 硬清除: 5
[结果] ~12000 → ~4500 tokens (节省 7500)
```

### 7.2 教学项目里 REPL 命令的价值

跟前面几篇一样——**看得见比跑到才知道重要**。启动日志里打个 `[Prompt Pipe Debug]`、`[Session Debug]`、`[压缩前/后]`、`[Layer 2/3]`——这些**不是给生产用的、是给学习的人用的**。

**它们的共同性质**：
1. 只在启动或特定命令触发时打，不刷屏
2. 显式打关键状态转移点（"之前多少、之后多少、变化多少"）
3. 有条件启用（`didAnything` / `defenseChanged`），没变化时静默

**教学项目的 log 应该比生产多、比 debug 少**——够解释机制、不干扰使用。

## 8. 已知的坑与后续方向

**1. WeakMap 恢复会话时不自动重建**

`--continue` 加载的历史 messages 没时间戳、TTL 不动它们。要修得从 `SessionEntry.timestamp` 主动重建 WeakMap。当前项目留作后续。

**2. 单条 tool_result 用 2 chars/token、总量用 4 chars/token**

不一致但故意——单条更严、总量更松。这个数字是拍脑袋的、生产上应该按实际模型 tokenizer 校准。

**3. `applyDefense` 无 config 参数**

`truncateToolResults` 支持 config、`pruneByTTL` 用硬编码常量。要生产化得让 caller 传所有阈值——教学项目先硬编码。

**4. 错误关键词是硬编码正则**

覆盖 10 种表述——但可能漏了（比如 `ECONNREFUSED` / `EACCES` / `403`）。理想是让 tool 主动标 `isError: true`（AI SDK 5 支持）—— Compactor 直接读这个字段。当前依赖 output text 里的关键词、有误判风险。

**5. Layer 2 截断的分界点是"字符数"、不是"tokens"**

`maxSingleResult` 按字符算——但真正的约束是 tokens。用 chars/2（保守）和 chars/4（宽松）近似——精度问题跟 TokenTracker 类似、生产该接 tokenizer。

**6. 没有指标暴露**

`applyDefense` 返回 `{ softPruned, hardPruned, truncated, compacted }`——但只打了 log，没接入 metrics。生产上应该发到 telemetry 系统、看长期趋势（"这周清了多少 tool_result / 命中了多少错误经验保留"）。

---

## 相关文档

- [context-compression.md](context-compression.md) — Microcompact + Summarization（这一篇的"后续两层"）
- [session-persistence.md](session-persistence.md) — SessionEntry.timestamp 是 WeakMap 恢复的数据源
- [tool-search-design.md](tool-search-design.md) — 工具本身的可见性管理，跟 tool_result 的压缩正交
- [agent-loop-protections.md](agent-loop-protections.md) — 三道防线（循环/预算/容错），跟压缩正交
