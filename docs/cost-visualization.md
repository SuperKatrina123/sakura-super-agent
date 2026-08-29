# 成本可视化：Cache、Context、Usage 三视图

> 配套 [../README.md](../README.md) 的拓展阅读。前面几篇讲的是"怎么让 Agent 跑得对"、这一篇讲**怎么让 Agent 跑得起**——Prompt Cache 三种模式的选型、把成本花在哪变得可见、以及我们项目实测 31% 命中率背后的架构问题。

## 目录

- [0. 上下文小 ≠ 花钱少](#0-上下文小--花钱少)
- [1. Prompt Cache 三种模式](#1-prompt-cache-三种模式)
- [2. 各家 provider 定价矩阵](#2-各家-provider-定价矩阵)
- [3. UsageTracker：把四类 token 分开算](#3-usagetracker把四类-token-分开算)
- [4. `/context` 命令：空间可视化](#4-context-命令空间可视化)
- [5. `/usage` 命令：成本可视化](#5-usage-命令成本可视化)
- [6. 实测数据：31% 命中率背后的架构问题](#6-实测数据31-命中率背后的架构问题)
- [7. Cache 的回报模式：前期投入、后期省心](#7-cache-的回报模式前期投入后期省心)
- [8. 已知的坑与后续方向](#8-已知的坑与后续方向)

## 0. 上下文小 ≠ 花钱少

前面 [context-compression.md](context-compression.md) 和 [instant-defenses.md](instant-defenses.md) 花了两章讲**怎么让上下文小**。那两章的思路是"减少 tokens"——每轮 loop 发给 API 的 messages 越少越好。

但**上下文小 ≠ 花钱少**。看一个反直觉的数字：

假设你的架构完美——每轮上下文稳定 20k tokens、绝不增长。你聊 50 轮：

```
无 cache 成本 = 20,000 × 50 × input_price = 1,000,000 tokens × input_price
```

**同样的 20k 会被重新发给 API 50 次、每次都全价付费**。SYSTEM prompt、工具描述、前面的对话历史——这些内容在大部分轮次里**几乎不变**、但每轮都要重新付费。

**Prompt Cache 解决的就是这个问题**。它把请求的"前缀"缓存在服务端、下次发同样的前缀直接复用、不重新跑前向计算。命中价格通常是正常 input 的 **10-25%**——**稳定不变的那部分上下文、每轮只花正常价格的十分之一到四分之一**。

## 1. Prompt Cache 三种模式

各家的实现看起来很乱、归纳起来就三种：

### 1.1 隐式缓存（Implicit）

**代表**：OpenAI GPT-5、DeepSeek V4、GLM 4.6、MiniMax M2

**特点**：
- **代码什么都不改**——只要前缀够长就自动缓存
- OpenAI 最少 1024 tokens 前缀、DeepSeek 最小单元 64 tokens
- 缓存是透明的——从 `usage` 响应里看到 `cachedInputTokens` / `cached_tokens` 字段就知道命中了多少

**优点**：零接入成本、跨模型可移植（同一份代码切换 provider 就自动生效）

**缺点**：不能主动控制断点在哪、命中率是**概率**（生产环境 60-90% 算正常）

### 1.2 显式标记（Explicit Marker）

**代表**：Claude Sonnet/Haiku/Opus、Qwen 3.6 explicit 模式

**特点**：
- 请求里挂 `cache_control: { type: 'ephemeral' }` 标记
- **告诉 API "从开头到这里都缓存"**
- 最多挂 4 个标记——通常策略是 tools 末尾、system 末尾、稳定的对话历史末尾各挂一个
- Qwen 的 explicit 直接复用了 Claude 的字段名——**代码不用改就能兼容两家**

**优点**：命中是**确定的**（绑定 cache_control 位置）

**缺点**：cache write 首次比 input 贵 25%（Anthropic）——**单次调用场景不划算**

### 1.3 显式创建（Explicit Create）

**代表**：Gemini 3 explicit 模式、豆包 2.0

**特点**：
- 先调 API 创建一个 cache 对象、拿到 cache_id
- 后续请求带这个 ID 引用
- **适合大段固定知识库的场景**（比如"帮我基于这份 500 页文档回答问题"）

**优点**：命中率极高、可以锁很长的 TTL（豆包 7 天）

**缺点**：额外的**存储费**、单请求 API 复杂度上升

### 1.4 三种模式的选型建议

**生产场景推荐顺序**：

1. **先用隐式缓存**（OpenAI / DeepSeek / GLM / MiniMax）—— 代码 0 改动、命中折扣够大
2. **或显式标记**（Claude / Qwen explicit）—— 命中确定、多加几行代码
3. **Agent 真上线、花费明显高时**、再考虑**显式创建**（Gemini / 豆包）—— 保证命中 + 长 TTL

## 2. 各家 provider 定价矩阵

| 提供商 | 模式 | 命中折扣 | 起效阈值 | TTL |
|---|---|---|---|---|
| **Claude Sonnet 4.6** | 显式标记 | 90% off | 2048 tokens | 5min / 1h |
| **Claude Opus 4.7 / Haiku 4.5** | 显式标记 | 90% off | 4096 tokens | 5min / 1h |
| **OpenAI GPT-5** | 隐式 | 75-90% off | 1024 tokens | 未公开（分钟级） |
| **Gemini 3** | 双模式 | 75% off（含存储费） | ？ | 1h |
| **DeepSeek V4 Flash/Pro** | 隐式 | **99% off** | 64 tokens | **数小时到数天** |
| **Qwen 3.6** | 双模式 | 80-90% off | ？ | 5min |
| **MiniMax M2** | 隐式 | ~80% off | ？ | 未公开 |
| **豆包 2.0** | 显式创建 | 80% off | ？ | 1h-7d |
| **智谱 GLM-4.6 / 5.x** | 隐式 | ~80% off | ？ | 未公开 |

### 2.1 我们项目的选择

**跑 DeepSeek V4 Flash** ——三个理由：

1. **99% off 是市场最高折扣**——命中的 tokens 几乎不花钱
2. **数小时到数天的 TTL**——用户思考 10 分钟再回来、cache 还活着（对 REPL 教学项目特别重要）
3. **隐式模式、零代码改动**——AI SDK 抽象层下无缝生效

### 2.2 折扣 × 命中率 = 真实节省

**单看"90% off"没意义、必须乘上命中率**。真实成本 = `input_price × (1 - 折扣 × 命中率)`。

以 DeepSeek V4 Flash（99% off）为例：

| 命中率 | 有效成本 vs 无 cache |
|---|---|
| 0% | 100%（等于没有 cache） |
| 30%（悲观） | 70.3% |
| 60%（中等） | 40.6% |
| 90%（理想） | **10.9%** |

**同样的 prompt 结构、命中率从 30% 提到 90% —— 成本从 70% 降到 11%**。**优化命中率的边际收益远大于其他任何微调**。

### 2.3 隐式缓存不 100% 保证命中

要看两件事：

1. **prompt 前缀够不够长**——低于阈值（OpenAI 1024、Claude Sonnet 2048、Opus/Haiku 4096）的前缀根本不会被写入
2. **厂商缓存池的实时状态**——同一份请求被路由到哪台机器（缓存是按节点的、不是全局共享）、LRU 有没有把它挤掉、TTL 有没有过期

**隐式缓存的命中率本质上是概率**——生产环境 60-90% 算正常、不是 100% 确定。显式缓存因为绑定了 cache_id 或 cache_control 标记、命中是确定的。

## 3. UsageTracker：把四类 token 分开算

看不到成本、就没办法优化成本。UsageTracker（[`src/session/usage-tracker.ts`](../src/session/usage-tracker.ts)）做的就是把每轮 API 调用的成本"归一化+累计"。

### 3.1 四类 token 分开算

```ts
export interface StepUsage {
  inputTokens: number;       // 真正 cache miss 的部分
  outputTokens: number;      // 模型生成的部分
  cacheReadTokens: number;   // 命中 cache 的部分
  cacheWriteTokens: number;  // 首次写入 cache 的部分（Anthropic 特有）
}
```

**为什么必须分开**：
- **`inputTokens`** —— 按 miss 价算（比如 DeepSeek $0.27/M）
- **`cacheReadTokens`** —— 按 read 价算（DeepSeek $0.027/M、99% off）
- **`cacheWriteTokens`** —— 按 write 价算（Anthropic 比 input 贵 25%）
- **`outputTokens`** —— 按 output 价算（通常最贵）

**四种价格不同、混在一起算钱就是错的**。

### 3.2 Provider 特化的归一化

**OpenAI 的坑**：`usage.inputTokens` 里**包含了 `cachedInputTokens`**——如果不减去、就会把 cached 部分按 miss 价重复算钱。

看 `normalizeUsage`：

```ts
const inputTokens = context.provider?.startsWith('openai')
  ? Math.max(0, rawInputTokens - cacheRead)
  : rawInputTokens;
```

**"用别人的数据前必须知道它的规则"**——这就是 [`normalizeUsage`](../src/session/usage-tracker.ts#L58) 存在的原因。

### 3.3 baseline vs cost = saved

对每步都算两个成本：

- **`cost`** —— 真实花费（四类 tokens 按各自价格加总）
- **`baseline`** —— 假设**全按 miss 价算**的成本（把 cacheRead / cacheWrite 的 tokens 也按 input 价算）
- **`saved` = `baseline - cost`** —— cache 省下的钱

**baseline 是"upper bound"**——展示 cache 全生态的价值。不是最严格的对照（严格版应该只算 cacheRead 的省下），但**够用来告诉用户"cache 到底给你省了多少"**。

### 3.4 命中率的分母

```ts
const cacheHitRate = cacheReadTokens / (inputTokens + cacheReadTokens);
```

**分母不含 cacheWrite**——首次写入是"投入"、不算"命中"。跟 `saved` 的算法保持一致：**命中率反映"复用"、不反映"投入"**。

## 4. `/context` 命令：空间可视化

看不到空间还剩多少、就不知道什么时候压缩。`/context` 命令仿 Claude Code 的做法——**16×16 网格 + 分类图例**。

### 4.1 实际输出

```
  ● ● ◐ ◒ ◒ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    deepseek/deepseek-v4-flash
  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    2.6k/128.0k tokens (2.0%)
  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○
  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ● System prompt    1.0k (0.79%)
  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ◐ System tools      650 (0.51%)
  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ◒ Deferred tools    932 (0.73%)
  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ◉ Messages           48 (0.04%)
  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ○ Free space     119.0k (92.9%)
  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ▢ Buffer           6.4k (5.0%)
  ...
  ○ ○ ○ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢
```

### 4.2 三个设计选择

**a. 16×16 = 256 格**——每格约 0.4% 窗口。够细看出各类别的比例、又不至于太散。

**b. 六个类别、不同符号**：
- `●` System prompt（固定系统开销）
- `◐` System tools（内置工具 schema）
- `◑` MCP tools（MCP 工具 schema）
- `◒` Deferred tools（延迟工具目录）
- `◉` Messages（对话历史）
- `○` Free space（空闲）
- `▢` Buffer（应急预留 5%）

**c. Buffer 独立显示**——预留给 autocompact/summarize 触发时的临时膨胀。**5% 是经验值**——太小会让触发时"没地方摆摘要"、太大会低估可用空间。

### 4.3 何时看 `/context`

三个典型时刻：
- **对话很久了、想知道剩多少空间** → 看 Free space
- **模型开始"忘事"、怀疑是不是压缩过头** → 看 Messages 有多小
- **接了新 MCP server、想知道占多少** → 看 MCP tools 那格

## 5. `/usage` 命令：成本可视化

### 5.1 实际输出

```
Usage Summary
  8 步累计

  ◎      Input           70.4k tokens
  ◈ Cache write         0 tokens
  ◉  Cache read      31.9k tokens   (31.2% hit)
  ◇      Output           3.2k tokens

  Cache hit rate  █████████░░░░░░░░░░░░░░░░░░░░░  31.2%

  Cost            $0.0234
  Without cache   $0.0311
  Saved           $0.0077 (24.9% off)
```

### 5.2 四类符号的语义

- **`◎ Input`** —— 真正 miss、按 miss 价花钱
- **`◈ Cache write`** —— 首次写入（Anthropic 特有）、比 input 贵 25%
- **`◉ Cache read`** —— 命中的读取、只花 10-25% 的价格
- **`◇ Output`** —— 生成、通常最贵

**这四个符号跟 `/context` 的 6 个符号语义不重复**——`/context` 讲空间分布、`/usage` 讲成本组成。

### 5.3 三行成本对比是**核心**

```
Cost            $0.0234    ← 实际花费
Without cache   $0.0311    ← 假设没 cache 该花的钱
Saved           $0.0077 (24.9% off)   ← cache 省下的
```

**"Saved" 那行是这个命令的存在意义**——让用户**眼见为实**"cache 到底给我省了多少"。数字看起来不多、但**乘上会话次数、乘上生产规模**、就是真金白银。

## 6. 实测数据：31% 命中率背后的架构问题

跑一个真实会话（8 轮）后 `/usage` 显示 **命中率 31.2%**。

**这个数字反映的不只是运行时状态、是我们架构的设计问题**——理想的 DeepSeek Agent 应该能到 70-85%。

### 6.1 四个破 cache 点

回顾前面几篇的设计决策、都影响 cache 命中：

**破 cache 点 1**：`Prompt Pipe` 的 `sessionContext` segment 每轮变化

看 [`src/context/segments.ts`](../src/context/segments.ts)：

```ts
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 会话 ${ctx.sessionId} 已有 ${ctx.sessionMessageCount} 条历史消息。`;
    //                                    ↑ 每加一条消息就 +1
  };
}
```

**每轮 SYSTEM 都不一样**——DeepSeek 的隐式 cache 前缀匹配到"第一个变化的字节"就停、SYSTEM 后半段的 cache 每轮都要重写。

**破 cache 点 2**：`deferredTools` 目录被 tool_search 命中后变短

每次 `tool_search` 激活一个 defer 工具、`getDeferredTools()` 返回的列表就少一项——SYSTEM 中的 defer 目录变化。

**破 cache 点 3**：ToolSearch 激活工具、`tools` 参数变化

`streamText({ tools: registry.toAISDKFormat() })` 里的工具列表——发现新 defer 工具后多一项。**tools 参数变了、cache 从这里失效**。

**破 cache 点 4**：Compaction / Summarization 修改 messages

`microcompact` 把老 tool_result 改成 `[tool result cleared]`、`summarize` 把老对话替换成摘要——**都在 messages 中间**，前缀立即失效。

### 6.2 教训：架构设计和 cache 命中率是**耦合**的

前面几篇提到过 cache 影响、但**当时没有实测数据**。现在有了 31% 这个具体数字：

- 每个"动态变化"的设计决策都在**扣 cache 命中率的分**
- 教学项目里我们优先了"机制清晰"—— 但**生产化时必须重新审视**每个动态点
- **Prompt Pipe 里 `sessionContext` 放最后**已经是好的取舍、但**它还是让 SYSTEM 每轮变化**——真要极致优化、这个 segment 应该重写成"只区分新会话/续会话两态"

### 6.3 可以做的优化

按性价比排：

**优化 1（推荐）**：`sessionContext` 稳定化

```ts
// 改前：每轮变（sessionMessageCount 每次 +1）
return `[会话信息] 会话 ${ctx.sessionId} 已有 ${ctx.sessionMessageCount} 条历史消息。`;

// 改后：只区分"新会话 / 恢复会话"两态、SYSTEM 完全稳定
return `[会话信息] 恢复的会话（含历史对话）。`;
```

**预期效果**：SYSTEM 稳定 → cache 前 1-2k tokens 恒定命中 → **命中率能从 31% 拉到 50%+**。

**优化 2**：defer 目录不动态过滤

现在 `getDeferredTools()` 过滤掉 `discoveredTools`——每次 tool_search 后目录变短。改成"目录始终列全部"、只在 tools 参数里加已发现的。**代价**：defer 目录多几百字符恒定占位；**收益**：defer 段稳定进 cache。

**优化 3**：延迟 Summarization 触发

Summarization 一发生、整个前缀就废了。把阈值从 60% 提到 85%、让 cache 保得更长——**代价是接近硬墙时更冒险**。

## 7. Cache 的回报模式：前期投入、后期省心

从我们实测数据看 Cache 的回报曲线：

```
第 1 轮:  hit  0% —— cache 冷启动、全 miss + 写入
第 2 轮:  hit 34% —— 第 1 轮写入的 cache 开始被读
第 3 轮:  hit 49% —— 稳定升温
...
第 8 轮:  hit 31%（累计） —— 中间有工具激活/压缩、部分 cache 失效
```

**这是 cache 的典型回报模式：前期投入、后期省心**。

第一轮写入 cache 要多花 25%（Anthropic）或不省钱（DeepSeek 隐式）——但后续每一轮都省 90%+。**所以调用次数越多越划算**：

| 会话轮数 | 单次调用场景 | Agent 多步对话 |
|---|---|---|
| 1 | 写入贵 25% | 亏本 |
| 3 | 打平 | 开始省 |
| 10 | / | 明显节省 |
| 50+ | / | 稳定省 40-80% |

**单次调用不适合开显式 cache**（写入比不写还贵）、但 **Agent 这种动辄几十轮的多步对话是 cache 的最佳应用场景**。

## 8. 已知的坑与后续方向

**1. 命中率 31% 显著低于 DeepSeek 理想值**

架构里有 4 个破 cache 点、每个都在扣分。**优化 1（`sessionContext` 稳定化）没做**——是最容易的改动、性价比最高。

**2. baseline 的算法是乐观 upper bound**

当前把 cacheRead + cacheWrite 的 tokens 都按 input 价算——展示 cache 全生态的价值。严格版应该只算 cacheRead 的省下（cacheWrite 本来就是"投入"、不算"cache 省的"）。**未来可以加两种模式的开关**。

**3. 未知模型静默 warn + zero cost**

`getPricing()` 找不到就打 warn 返回 0——防止"以为在算钱、实际是 0"的隐性 bug。但**warn 只在第一次出现时打**（`missedModels` 去重）——如果 log 被刷掉、之后就不知道了。生产上应该走 telemetry。

**4. Provider metadata 提取靠 `as any`**

看 [`agent/loop.ts`](../src/agent/loop.ts)：

```ts
stepProviderMetadata = await (result as any).providerMetadata;
```

AI SDK 5 的类型定义可能没覆盖 `providerMetadata`——用 `as any` 绕过。**未来 AI SDK 类型完善后可以移除**。

**5. Anthropic 支持不完整**

我们的 `normalizeUsage` 支持 Anthropic cache write、但**没实测过**——项目当前只跑 DeepSeek。真跑 Anthropic 需要：

- 手动挂 `cache_control: { type: 'ephemeral' }` 到 messages 数组
- 位置策略：tools 末尾、system 末尾、稳定的对话历史末尾各一个
- **PRICE_TABLE** 里的 Claude 定价可能过时——需要生产前对齐 [Anthropic pricing](https://www.anthropic.com/pricing)

**6. 长会话累计成本不显示单价**

当前 `/usage` 只显示总花费、不显示"每 1000 tokens 花多少"这种单价对比。加一行 `$0.15 per 1k tokens` 就能一眼判断"是我花多还是模型贵"。

---

## 相关文档

- [instant-defenses.md](instant-defenses.md) — TokenTracker 的"精确基准 + 粗估增量"设计——UsageTracker 的近亲
- [prompt-pipe-design.md](prompt-pipe-design.md) — `sessionContext` segment 的实现——本篇 §6.1 的破 cache 点 1
- [tool-search-design.md](tool-search-design.md) — 动态 tools 参数导致 cache 前缀失效——本篇 §6.1 的破 cache 点 3
- [context-compression.md](context-compression.md) — Summarization 会重写 messages——本篇 §6.1 的破 cache 点 4
