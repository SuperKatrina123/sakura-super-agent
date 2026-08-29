# ToolSearch 延迟加载设计：给工具集加一层搜索引擎

> 配套 [../README.md](../README.md) 和 [mcp-integration-practice.md](mcp-integration-practice.md) 的拓展阅读。前者讲 MCP 怎么接进来，这篇讲**接进来太多之后怎么管**——为什么工具膨胀会成为 Agent 的显性瓶颈、Profile vs Lazy Loading 的选择、`tool_search` 的一步式激活如何工作、以及 Prompt Cache 语义带来的隐性权衡。

## 目录

- [0. 为什么需要延迟加载](#0-为什么需要延迟加载)
- [1. Profile vs Lazy Loading：两种思路的分歧](#1-profile-vs-lazy-loading两种思路的分歧)
- [2. 判定标准：频率优先 + 自适应阈值](#2-判定标准频率优先--自适应阈值)
- [3. 实现：五件事怎么串起来](#3-实现五件事怎么串起来)
- [4. 一次实测：从"查 vercel/ai issues"到完整调用链](#4-一次实测从查-vercelai-issues-到完整调用链)
- [5. Prompt Cache 的隐性权衡（最重要的一节）](#5-prompt-cache-的隐性权衡最重要的一节)
- [6. 已知的坑与后续方向](#6-已知的坑与后续方向)

## 0. 为什么需要延迟加载

前一篇 [MCP 集成实践](mcp-integration-practice.md) 结尾时项目有 38 个工具（12 内置 + 26 GitHub MCP）。这一篇开始时我们**故意再注入 11 个模拟 MCP 工具**（Notion / Browser / Supabase 共 3 个领域），把总数推到 **50**——目的是**制造压力**，让工具膨胀的痛点变得可见。

工具膨胀的痛点分**两层**：

**显性痛：token 成本**

50 个工具的 schema 全塞进 system prompt，实测约 **5535 tokens**。600k 预算的 ~0.9%——看起来不多，但每一轮 loop 都会重复消耗（除非命中 cache）。

**隐性痛：模型选择准确率下降**

50 个工具里，`get_issue` / `get_issue_comments` / `list_issue_events` / `get_pull_request` 这些语义相邻的工具挤在一起，模型每次都要在几十个选项里挑一个。**每多 10 个工具，模型犹豫和挑错的概率都会显著上升**。这不是理论——上下文工程课的经验数据里这是一条明确的曲线。

隐性痛比显性痛更难量化，但**更致命**——一个 token 花超了顶多多付钱，一个工具挑错了整轮任务就崩了。

## 1. Profile vs Lazy Loading：两种思路的分歧

行业里有两种主流应对方案，本质假设截然不同。

### Profile：预先按场景分盒子

给每个工具打场景标签（`coding` / `research` / `data`），用户切换场景时加载对应的盒子。上下文工程课介绍过 OpenClaw 的 Tool Profile 就是这个思路。

**它假设的是**：场景边界稳定 + 场景内工具需求闭合。

**问题**：真实工作里**场景是流动的**。你在 coding 会话里突然想起要查一个 GitHub issue、顺手看看 CI、去 Notion 找一份设计文档、写完代码更新那个 Notion 页面、截图放进 PR——一个"主任务"会拖出无数微支线，每一次跨场景就要么切 profile（丢上下文）、要么手动加白名单（运维负担）。

### Lazy Loading：所有工具都在，用时再拉

不按场景切，所有工具都保留在系统里，但**默认藏起来**。模型带着任务上下文进来，通过 `tool_search` 按需发现工具、按需激活。

**它假设的是**：任务是流动的，需求是被发现的。

**三个非显然优势**：

1. **没有边界维护成本**——工具就是工具，没有"归属"概念
2. **模型能自愈**——检索错了模型可以换关键词再搜，不会 hard-miss
3. **成本按"实际用了什么"付费**——一个会话只用 3 个工具就只有 3 个 schema 进 context

**但也有代价**（诚实说清）：

1. **多一次 round-trip**——第一次接触某个工具要多一轮 LLM 调用
2. **搜索质量决定天花板**——BM25 中文分词差、embedding 又要额外服务
3. **模型得"知道去搜"**——system prompt 里必须明确告诉它有隐藏工具存在
4. **搜索次数会累积**——复杂任务用到 5 个领域就要搜 5 次

### 我们的选择：Lazy Loading + 隐性 Profile

Claude Code 生态里的做法是"**Lazy Loading + 隐性 Profile**"：核心工具（read/write/bash/grep/glob）默认加载 = 隐性的"coding profile"；MCP 工具、专业工具默认 defer = lazy loading。

这个项目走同样的路——**因为这两种思路不互斥**。等未来需要"devops 场景切一批 kubernetes 工具"的时候，可以在 lazy loading 之上再加一层 profile hint，架构不用改。

## 2. 判定标准：频率优先 + 自适应阈值

哪些工具该 defer？分类依据是**使用频率**，其他都是干扰变量。

### Claude Code 的分类逻辑

- **核心工具**：Read / Edit / Write / Bash / Grep / Glob——写代码离不开
- **低频工具**：WebSearch / NotebookEdit / LSP / Cron 等——大部分对话用不上，标 `shouldDefer: true`
- **MCP 工具**：**全部默认 defer**——用户自己装的，数量不可控

### 落到我们项目

按同样标准分完，49 个业务工具 + 1 个 `tool_search` = 50 个：

| 分类 | 工具 | 数量 |
|---|---|---|
| **核心（eager）** | read/write/edit/bash/grep/glob/list_directory/calculator/get_weather + tool_search | 10 |
| **低频（defer）** | web_search / web_fetch / start_preview | 3 |
| **MCP（defer）** | 26 GitHub 工具 | 26 |
| **模拟 MCP（defer）** | 11 Notion/Browser/Supabase 工具 | 11 |

启动时的实测输出：

```
=== 工具统计 ===
  全部工具: 50 个
  活跃工具: 10 个（直接进 system prompt）
  延迟工具: 40 个（走 tool_search 按需激活）
  Token 估算: ~654 (活跃) + ~4881 (延迟，不占 prompt)
  节省比例: ~88%
```

### 自适应阈值：什么时候才该启用 ToolSearch

Claude Code 有个隐性规则：**当延迟工具的 schema 总量超过上下文窗口的 10% 时才启用延迟加载**。低于阈值——比如只接了一个 MCP server、3 个工具——没必要多此一举，全量加载就行。

阈值的目的是让机制**自适应**——用户没接 MCP 时 Agent 就是普通 Agent，接了大量 MCP 才启用。

我们项目目前**总是启用**（简单起见），实测发现 40 个 defer 工具已经落到甜蜜区。等以后遇到"只接一个 3 工具 server"的场景再补阈值判断。

## 3. 实现：五件事怎么串起来

`tool_search` 从零到能用需要五件事协同工作：

### 3.1 `ToolDefinition` 加两个字段

[`tool-registry.ts:3-18`](../src/tools/tool-registry.ts#L3-L18)：

```ts
export interface ToolDefinition {
  // ... 原有字段
  shouldDefer?: boolean;  // 是否延迟加载
  searchHint?: string;    // 检索关键词（不进 system prompt，只喂给 searchTools）
}
```

**关键分工**：
- `description` 是给**模型**看的——清晰简洁的一句话说明工具做什么
- `searchHint` 是给**检索器**看的——冗余的、多语言的、含同义词的关键词汇

对比：

```ts
// ❌ 把 hint 塞进 description → 污染 tool schema、浪费 token
description: '搜索 Notion 页面 notion search pages documents 笔记 知识库'

// ✅ 分开
description: '[MCP:notion] 搜索 Notion 页面'
searchHint: 'notion search pages documents 笔记 知识库'
```

写 hint 的三条建议：
1. **中英文都写**（BM25 词面匹配，"笔记"永远匹配不到 "note"）
2. **动词名词都覆盖**（"query" + "search"、"发送" + "消息"）
3. **同义词摆多个**（"navigate" + "goto" + "visit" + "open"）

### 3.2 MCP 工具自动 defer

[`tool-registry.ts:79-90`](../src/tools/tool-registry.ts#L79-L90)——`registerMCPServer` 里给每个 MCP 工具默认打两个标：

```ts
this.register({
    name: prefixed,
    description: `[MCP:${serverName}] ${tool.description}`,
    // ...
    shouldDefer: true,
    // hint = serverName + toolName + description，让 BM25 通过三条路都找到
    searchHint: `${serverName} ${tool.name} ${tool.description}`,
});
```

**理由**：MCP 工具本质是"外挂"——用户装什么完全不可控，几十上百个都可能。默认 defer 是符合语义的保守策略；需要立即加载的特殊 server 可以注册后手动 `registry.get(name).shouldDefer = false` 覆盖。

### 3.3 `discoveredTools` 集合

[`tool-registry.ts:41-45`](../src/tools/tool-registry.ts#L41-L45)：

```ts
private discoveredTools = new Set<string>();
```

**语义**：System prompt 已列出所有 defer 工具名，模型主动 pick 名字调 `tool_search` → 精确匹配后加入这个 Set，从此该工具对模型"可见"（进 prompt + 可调用）。

### 3.4 `searchTools` / `getActiveTools` / `getDeferredToolSummary`

[`tool-registry.ts:122-179`](../src/tools/tool-registry.ts#L122-L179) 三个方法配合：

- **`searchTools(query)`**：精确名字匹配，支持逗号分隔一次查多个。命中即加入 `discoveredTools`。**没有模糊匹配和评分**——因为名字已经全告诉模型了，模型选好名字才调 `tool_search`，精确匹配零依赖、零误召回、可预测。

- **`getActiveTools()`**：当前对模型可见的工具集 = eager + 已发现的 defer + `tool_search` 本身。

- **`getDeferredToolSummary()`**：生成挂到 system prompt 尾巴的"隐藏工具目录"。这是 ToolSearch 模式能工作的关键——**模型必须"知道有哪些能力可用"**，否则永远不会想到去搜。

`toAISDKFormat()` 只序列化 `getActiveTools()` 返回的工具——defer 工具的 schema 不进 prompt。

### 3.5 `tool_search` 元工具

[`src/tools/tool-search.ts`](../src/tools/tool-search.ts)——闭包 registry 引用的工厂函数：

```ts
export function createToolSearchTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: 'tool_search',
    description: '获取延迟工具的完整定义。传入工具名（从 system prompt 的延迟工具列表中选取）...',
    // ...
    execute: async ({ query }) => {
      const results = registry.searchTools(query);
      if (results.length === 0) return `没有找到匹配 "${query}" 的工具...`;
      return JSON.stringify(results.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })), null, 2);
    },
  };
}
```

**一个关键设计决策：一步式激活（搜索即激活），而不是两步式（search + load）**

Claude Code 的 `mcp__loadTools` 也是这个做法。理由：教学场景里"一步到位"更清晰，也省一次 round-trip。`isReadOnly: true` 是**善意的谎言**——有内部状态变更（`discoveredTools`），但不改外部世界，语义上归为安全操作。

### 3.6 SYSTEM prompt 每轮动态拼接

[`src/index.ts:158-161`](../src/index.ts#L158-L161)：

```ts
// 每轮都重新拼 SYSTEM——因为 discoveredTools 可能变，defer 目录要跟着更新
const dynamicSystem = SYSTEM + registry.getDeferredToolSummary();
await agentLoop(model, registry, messages, dynamicSystem, budget);
```

**这一句是整个机制的最后一环**——不拼上去，模型永远不知道有隐藏工具。

**但这一句也埋了一个 Cache 副作用**——见 [§5](#5-prompt-cache-的隐性权衡最重要的一节)。

## 4. 一次实测：从"查 vercel/ai issues"到完整调用链

用户输入：`查看 vercel/ai 的 issues`

### Step 1：模型主动调 tool_search

```
[调用: tool_search({"query":"mcp__github__list_issues"})]
[并发] tool_search 获取共享锁
[结果: 完整的 mcp__github__list_issues schema]
[Token] 2663/600000
```

模型从 SYSTEM 尾巴的 defer 目录里读到 `mcp__github__list_issues — github list_issues [MCP:github] List issues...`，**精确传了名字**——没走模糊搜索、没试探。这说明 defer 目录挂在 SYSTEM 里的效果非常好。

### Step 2：模型用刚发现的工具调 GitHub

```
[调用: mcp__github__list_issues({"owner":"vercel","repo":"ai","state":"open","sort":"created","direction":"desc","per_page":10})]
[结果: 5 万字符的原始 issue JSON，被 registry 截断到 3000]
[Token] 5971/600000
```

**这里出现了意料之外但有教育意义的行为**：GitHub API 返回的每个 issue 带 30+ 字段的 metadata（`comments_url` / `events_url` / `reactions.laugh: 0` ...），一次 10 条就把 3000 字符限制撑爆了，触发 registry 的截断——**关键的 issue 列表被截掉**。

### Step 3：模型识别数据不完整，自救

```
返回数据太长被截断了，我用更简洁的方式重新获取一下：
[调用: bash({"command":"curl -s ... | python3 -c ..."})]
```

模型主动切到 `bash + curl + python3` 自己格式化——这不是我们指导的，是模型识别"数据不完整"信号后的自救。

**这个现象值得沉淀**：Anthropic 官方 [Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) 那篇的核心论点就是这个——**不要把 MCP 工具的 raw JSON 塞给模型，让模型写代码在沙箱里 filter/map/format，只把精简结果回传**。你的 Agent 无意中演示了这个论点。等未来做"工具结果压缩"或"code execution mode"时，Step 3 就是活样本。

### Step 4：最终答复

```
[Token] 15893/600000
```

四步走完总共花 ~16k tokens——如果 naive 全量加载 50 个工具的 schema，光工具部分每轮就要 5.5k tokens × 4 轮 = 22k，且没有真正 tool_search 发现工具的机制，模型可能根本调不到 `mcp__github__list_issues`。

### 一次会话的成本账

单轮理论对比（用真实 schema 长度算出来的估算）：

| 项目 | Naive 全量 | ToolSearch |
|---|---|---|
| system prompt 工具部分 | ~5535 tokens（50 个 schema） | ~654 tokens（10 个 schema）+ ~800 tokens（defer 目录） |
| tool_search 一次调用（in + out） | 0 | ~200 tokens |
| **单轮成本** | 5535 | ~1654 |
| **净省** | — | **~3900 tokens / 轮 ≈ 70%** |

多的一轮不是"额外成本"，是"预付订金买了 70% 的折扣"。多轮对话时账更划算——因为 defer 目录随 discoveredTools 增长而收缩，已发现的工具从目录里消失、进入 tools 参数，**在两个地方"守恒"**。

## 5. Prompt Cache 的隐性权衡（最重要的一节）

Anthropic API 的 Prompt Cache 让重复的 prompt 前缀命中缓存、只按 10% 成本计费。多轮长对话里价值巨大。**但 ToolSearch 会跟 cache 打架**——具体打在哪、多严重、能不能避开，这一节讲清。

### 5.1 Cache 的前缀匹配特性

```
system prompt        ← 定长，永不变（理想情况）
tools 参数           ← ★ cache 失效切点
messages[0..N]       ← 追加式，只影响 N 之后的 cache
```

只要 system + tools 前缀不变，前面的 cache 全部命中；一旦 tools 变化，cache 从 tools 那段开始失效；messages 是追加式的，历史消息 cache 永远命中。

### 5.2 我们的实现里 cache 什么时候失效

**情况一：tool_search 发现新工具**

新工具加进 `getActiveTools()` → `toAISDKFormat()` 输出多了一个 → **tools 参数变了 → cache 从 tools 开始失效**。

**情况二：defer 目录随 discoveredTools 变化**

看这一行：

```ts
const dynamicSystem = SYSTEM + registry.getDeferredToolSummary();
```

每次发现新工具，defer 目录里就少一项——**system prompt 也每轮都在变**。理论上 cache 应该是**每轮都从 system 开始就失效**。

这是当前实现里**一个实实在在的缺陷**。

### 5.3 三种解决方向

**方向 A：defer 目录不随 discoveredTools 变化**
- 目录始终列出**全部** defer 工具（包括已发现的）
- 已发现的工具**同时**在 tools 参数里
- 好处：system prompt 稳定
- 代价：模型可能重复搜索已发现的工具（需要在 SYSTEM 指令里规避）

**方向 B：defer 目录挂在 messages 而非 system**
- 每次 discoveredTools 变化时，在消息流里追加"当前可搜索工具"通知
- system 保持完全定长
- 更接近 Anthropic `defer_loading` beta 的思路

**方向 C：Anthropic defer_loading beta**
- Claude Code 用的方式——**延迟工具的 schema 出现在对话历史里**（`tool_result` 消息中），不在工具定义区域
- Cache 前缀完全不受影响
- **只 Anthropic API 支持**，模型无关的项目用不了

### 5.4 更激进的方案：双元工具代理

行业里还有一种更极端的做法：**tools 列表里永远只有 `tool_search` 和 `call_tool` 两个元工具**，模型先搜索获取 schema，再通过 `call_tool` 转发执行，应用层根据 `tool_name` 路由到真正的工具实现。

**好处**：tools 从头到尾不变，cache 完全稳定。

**代价**：模型不是通过 tools 参数里的**结构化 schema** 认识工具的，而是通过对话历史里的**文本描述**——LLM 提供商在 tool_call 时的原生结构验证失效。参数复杂的工具（比如 20+ 参数的 GitHub `create_issue`）准确率会显著下降。

### 5.5 四种方案的权衡矩阵

| 维度 | Naive 全量 | 动态 tools（我们的做法） | defer_loading beta | 双元工具代理 |
|---|---|---|---|---|
| tools 列表变化 | 从不变 | 发现即改 | 从不变 | 从不变 |
| Cache 稳定性 | 完美 | 前几轮失效、后期稳定 | 完美 | 完美 |
| Prompt 体积 | 大 | 小 | 小 | 极小 |
| 模型对工具的理解 | 结构化 schema | 结构化 schema | 结构化 schema | **纯文本描述** |
| 参数准确率 | 最高 | 最高 | 最高 | 略低 |
| 依赖 | 无 | 无 | Anthropic beta | 无 |
| 模型无关 | ✅ | ✅ | ❌ | ✅ |

### 5.6 我们为什么接受这个 cache 缺陷

三个理由：

**1. 模型无关是硬约束**
项目要跑 DeepSeek / OpenAI / Mock 三种模型——**defer_loading beta 用不上**。生产 Agent 想切模型也是一样。

**2. 发现集中在前几轮**
真实使用里模型发现工具的动作**集中在对话前几轮**——用户一上来就会说"查个 issue"、"看看数据库"，前两三轮把需要的工具都搜出来。**后面的 cache 不受影响**。

**3. 双元工具代理的准确率代价太大**
`mcp__github__list_issues` 有 8+ 个参数，`state: "open" | "closed" | "all"` 这种 enum 限制走原生结构验证是免费的，走文本描述模型经常拼错（`"opened"` / `"OPEN"` / `"OpenIssues"`）。**生产上宁可 cache 差一点，也要参数准**。

### 5.7 结论

**生产推荐用我们这个方案（动态 tools）**——用的是**原生 tools 列表**做工具加载，稳定性更有保障。cache 代价是前几轮的**一次性折损**，不是**全会话的持续损失**。

**§5.2 里说的 defer 目录随 discoveredTools 变化的缺陷**——目前留作已知问题。修的话建议走 **方向 A**（目录不变、已发现工具同时进 tools），代价可控、实现简单。

## 6. 已知的坑与后续方向

**1. Defer 目录动态变化导致 system prompt 不稳定**（见 §5.2）

修法：走方向 A，defer 目录始终列全，靠 SYSTEM 指令告诉模型"已发现的直接调用即可"。

**2. `discoveredTools` 无淘汰机制**

单进程 REPL 里"越用越多工具暖起来"是正常曲线；但长 running Agent 上会累积几十个工具在 tools 参数里，重回 naive 加载的开销。修法：LRU 淘汰，按最近使用时间保留 top-N。

**3. searchHint 的运维成本**

40 个工具手写 hint 还行，200 个就是负担。未来方向：用 LLM 预处理一次 description 派生 hint。

**4. 工具结果的 verbose 问题**

第 4 节实测里 GitHub API 返回被截断、模型自救走 `bash + curl` 的现象说明：**MCP 工具的 raw JSON 对 Agent 太 verbose 了**。Anthropic 的 [Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) 提出的"沙箱里跑代码、只回传精简结果"是下一步方向。

**5. 自适应阈值缺失**

现在总是启用 ToolSearch。工具数少时其实没必要——完全可以判断"defer 工具 schema 总量 < system 10%"时全量加载。补充这个判断能让机制在小规模场景下**自动关闭**。

---

## 相关文档

- [mcp-integration-practice.md](mcp-integration-practice.md) — 工具的**来源**（MCP 协议），这一篇讲工具的**管理**
- [tool-call-concurrency.md](tool-call-concurrency.md) — 工具的**执行调度**（读写锁）
- [agent-loop-protections.md](agent-loop-protections.md) — Agent Loop 三道防线，跟工具管理正交
