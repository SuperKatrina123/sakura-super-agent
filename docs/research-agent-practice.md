# Research Agent 实践：一句话研究一个 URL

一次完整的 Research Agent 端到端实践——从"给一个 URL 让 Agent 总结"到"给两个 URL 让它对比"，观察真实模型的**元认知能力**和**并发工具调用**。这次实践是 Code Agent 实践之后的第二步，目的不是产出总结工具，而是**用一个抓网页场景验证 Agent 的自主推理、多轮迭代、意图理解**。

> 前置阅读：[code-agent-todo-practice.md](code-agent-todo-practice.md)（Code Agent 实践）· [agent-loop-protections.md](agent-loop-protections.md)（三道防线）· [tool-call-concurrency.md](tool-call-concurrency.md)（工具读写锁）

## 实践目标

用户输入一句话，包含一个或多个 URL，Agent 应该：

1. **自主识别** URL 并调用 `fetch_url`（无需前缀/指令）
2. **多个 URL 并发抓取**（读写锁放行共享锁）
3. **判断信息缺口**，必要时主动补抓
4. **综合成结构化输出**（不是复述、不是硬编）

## 场景步骤

### Step 0：零代码改动前置

`fetch_url` 工具早已注册（[src/tool/index.ts](../src/tool/index.ts)）：

```ts
export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）',
  isConcurrencySafe: true,    // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  maxResultChars: 1500,        // 网页通常很长，截断兜底
  execute: async ({ url }) => {
    // 先查 MOCK_PAGES 有没有预设 → 有则返回预设，无则真实 fetch
    // 真实抓取时自动剥 <script>/<style> 和所有 HTML 标签
  },
};
```

**关键设计**：

- 描述里明确"抓取 URL + 转纯文本"→ 模型看到 URL 会自然选它
- `isConcurrencySafe: true` → 多 URL 抓取时读写锁放行
- `maxResultChars: 1500` → 长网页兜底截断
- 内置 `MOCK_PAGES` 字典 → 部分 URL 走预设内容，稳定可复现；其它走真实网络

**唯一前置**：调大 [src/index.ts](../src/index.ts) 里的 `budget.limit`（真实模型消化长文档很费 token）和 [src/agent/loop.ts](../src/agent/loop.ts) 的 `MAX_STEPS`（长回复会分多轮流式生成）。

### Step 1：单 URL 场景

REPL 输入：

```
去 https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling 看下文档总结
```

真实 DeepSeek 的行为：

```
Step 1:
  [调用: fetch_url({"url":"https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling"})]
  [并发] fetch_url 获取共享锁
  [结果: "AI SDK Core - Tools and Tool Calling..." (~300 字预设内容)]

Step 2-30: 流式输出结构化总结（17 个特性分点）
```

**观察点**：

- **一步就调用 fetch_url**：无需任何 prompt 引导，纯靠工具 description
- **命中 MOCK_PAGES**：URL 前缀匹配了预设字典，返回预设短文本（不走真实网络）
- **长输出分多轮流式生成**：DeepSeek 长回复会拆成多个 `text-delta` 步骤，`loop.ts` 里 `if (!hasToolCall) break` 理论上第一次就该退出，实际用了 30 步——**这是真实模型流式生成的正常行为**

**关键洞察**：模型输出的 17 个特性总结**大部分来自训练数据**，不是 fetch 结果——预设文本只有 300 字，怎么可能总结出 17 个特性？答案是 **fetch_url 给模型的是"上下文触发"，真正的信息来源是模型的预训练知识**。

**验证方法**：把 MOCK_PAGES 里对应条目删掉，让 fetch_url 走真实网络请求，会看到：

- 抓取内容变成完整的 AI SDK 文档 HTML（剥完标签后几万字）
- 被 `maxResultChars: 1500` 严格截断
- 模型基于**截断后的碎片 + 训练知识**做总结

### Step 2：并发 URL 场景

REPL 输入：

```
同时去 https://esm.sh 和 https://ai-sdk.dev/docs/ai-sdk-core/generating-text 看看，对比一下
```

真实 DeepSeek 的行为：

```
Step 1:
  [调用: fetch_url({"url":"https://esm.sh"})]
  [调用: fetch_url({"url":"https://ai-sdk.dev/docs/ai-sdk-core/generating-text"})]
  [并发] fetch_url 获取共享锁
  [并发] fetch_url 获取共享锁
  [结果: "esm.sh - 一个免费的 ES module CDN..."]  # MOCK_PAGES 命中
  [结果: "AI SDK Core: Generating Text ... [省略 28141 字符] ..."]  # 真实网络

Step 2:
  [模型：内容不足，重试]
  [调用: fetch_url × 2]  # 又抓一次相同 URL——踩坑

Step 3:
  [模型：换策略，抓 GitHub README]
  [调用: fetch_url({"url":"https://raw.githubusercontent.com/esm-dev/esm.sh/main/README.md"})]

Step 4:
  [综合对比]
```

**观察点**：

- **"同时"关键词触发并发规划**：模型一步内输出**两个 tool-call**，SDK 用 `Promise.all` 并发调
- **两个 URL 命中不同路径**：esm.sh 命中 MOCK_PAGES 返回短文本，ai-sdk.dev 走真实网络请求返回被截断的长文本
- **模型 Step 2 做了个"错误重试"**：判断内容不足 → 又抓一次相同 URL → 没有新信息（这是**模型规划失误**）
- **Step 3 换策略**：模型意识到重试无效，**推理出"README 通常在 GitHub"**→ 抓 raw content URL → 拿到 10K+ 完整内容
- **Step 4 元认知诚实**：先质疑用户前提"这俩根本不是同一类东西"→ 给出真正合理的对比 + 组合用法代码 + 反问用户意图

**关键洞察**：

**并发是三层配合**（跟 Code Agent 场景一样）：
1. **模型层**：一次输出多 tool-call 数组
2. **AI SDK 层**：`Promise.all` 并发
3. **Registry 层**：两个 `fetch_url` 都 `isConcurrencySafe: true` → 都拿共享锁

**"同时"三个字对模型影响巨大**。同样两个 URL，换成"先看 A，然后看 B"，大概率会退化成两步串行——**并发 vs 串行是模型基于语言语气的推理决策**，不是硬编码规则。

## 真实模型能力对比：Code Agent vs Research Agent

|能力维度| Code Agent 场景 | Research Agent 场景 |
|---|---|---|
| 意图识别 | "找 TODO" | "去 xxx 看看" |
| 工具组合 | list_directory + grep + read_file + bash | 主要靠 fetch_url，可能配合 write_file |
| 并发触发词 | 无需（多文件并发是自然规划） | 需要"同时"这类明确语义 |
| 元认知场景 | 识别工具结果截断 → 换工具 | 识别 mock 内容不足 → 换 URL 策略 |
| 语义级判断 | 排除 mock-model.ts 里的"假 TODO" | 质疑用户前提"这俩不是一类东西" |
| 输出结构 | 按文件汇总的表格 + 优先级 | 对比表格 + 关系说明 + 代码示例 |

**共同规律**：真实模型的**元认知能力**是最大惊喜——它会主动识别"当前工具够不够用"、"当前信息够不够充分"、"用户的前提对不对"。这些都不是 prompt 里写的、也不是训练数据里明确教的，而是从大量 agent 使用样本里**涌现出来的能力**。

## 注意事项

### ⚠️ 1. `fetch_url` 有 MOCK_PAGES 拦截，容易误判

[src/tool/index.ts:319-327](../src/tool/index.ts#L319) 里的 `MOCK_PAGES` 字典会**优先命中预设内容**（`url.startsWith(key)`）。这带来两个坑：

- **误以为"抓到了真实内容"**：模型不知道自己拿到的是 mock，可能基于 mock 做出错误规划（比如反复重试希望拿到"完整版本"）
- **URL 前缀匹配可能覆盖广**：`https://esm.sh` 会匹配所有以此为前缀的路径（如 `https://esm.sh/react`），需要注意副作用

**建议改进**（未实施）：在 mock 返回值前加 `[MOCK]` 标记，让模型看到"这个内容是演示预设"，就不会盲目重试。

### ⚠️ 2. 真实模型的 token 消耗集中在**输出**，不是输入

Step 1 场景（单 URL 总结）：286143 / 600000 (48%) —— 28 万 token 里几乎全是输出（17 个特性 + 详细分点）。

Step 2 场景（对比两个 URL）：10818 / 600000 (2%) —— 少得多，因为回复简洁。

**优化点**：真正的成本控制不是"抓多少页"，而是"总结多详细"。在 SYSTEM prompt 里加"用 300 字以内总结"能显著降本。

### ⚠️ 3. 长回复会跑很多步

真实模型的长输出**分多轮流式生成**——每一轮"没有工具调用、只有 text-delta"。Step 1 场景用了 30 步，但**只有第 1 步调了工具**。

这意味着：
- **MAX_STEPS 不能设太小**：15 步对长回复完全不够
- **Step 数不等于"推理复杂度"**：30 步里 29 步是"打字"，只是流式打完了

### ⚠️ 4. 并发不是"能省时间"，是"能省 wall-clock 时间"

两个 `fetch_url` 并发跟串行相比：
- **wall-clock 时间**：从 2 × 网络延迟 → max(网络延迟) 约减半
- **token 消耗**：完全相同（模型输出的 tool-call 数量一样）
- **成本**：完全相同

**并发是延迟优化，不是成本优化**。想省钱要控输出长度、控迭代次数。

### ⚠️ 5. 模型的"重试"可能是无效重试

Step 2 场景 Step 2 里模型做的"重试相同 URL"是**错误规划**——重复调用不会有新结果。但循环检测 [src/loop-detection.ts](../src/loop-detection.ts) 里 `generic_repeat` 的阈值是 5 次警告 / 8 次熔断，**第 2 次不会拦下**。

这是循环检测阈值设计的 trade-off：
- 阈值太低 → 误伤合理的重试尝试
- 阈值太高 → 模型烧 token 才被拦

**建议**：如果观察到模型在无效重试，可以主动打断，或者在 SYSTEM prompt 里加"每个 URL 只抓一次，除非有明确变化"。

## 从 Research Agent 到 Deep Research 类产品

再往前走一步，这个 Demo 就是最近广泛讨论的 **Deep Research 类产品**（OpenAI Deep Research、Perplexity Pro Search 等）的雏形。它们的核心不是抓取能力，而是**多轮迭代的研究链路**：

```
搜索关键词 → 抓取一批 URL → 摘要
      ↓
反思：还缺什么信息？浮现新的子问题
      ↓
再搜索 → 再抓取 → 再摘要
      ↓
综合成结构化报告
```

**你现在的架构其实已经具备这个能力**：

- **Agent Loop** 支持多轮迭代（while 循环）
- **fetch_url** 支持并发抓取
- 缺的只是 **`web_search` 工具**（从主题词到 URL 列表的入口）

**Step 2 场景里模型已经"意外地"演示了 Deep Research 的核心循环**：
- Step 2：判断信息不足（"内容都被截断了"）
- Step 3：提出新问题（"去 GitHub 拿 README 补充"）
- Step 3：主动查资料（抓 raw.githubusercontent.com）
- Step 4：综合成报告

**没写一行 Deep Research 逻辑，纯粹靠 Agent Loop + fetch_url 的组合浮现出来**。

详细的 Deep Research 增量设计见 [deep-research-design.md](deep-research-design.md)——不用现在实施，作为思路延伸。

## 关键代码路径

| 关注点 | 文件 |
|---|---|
| REPL 入口、budget 声明 | [src/index.ts](../src/index.ts) |
| Agent Loop while 循环 | [src/agent/loop.ts](../src/agent/loop.ts) |
| fetch_url 工具实现 | [src/tool/index.ts](../src/tool/index.ts)（`fetchUrlTool` 和 `MOCK_PAGES`） |
| 读写锁、结果截断 | [src/tool-registry.ts](../src/tool-registry.ts) |

## 收获清单

- **一句话就能触发 Research 场景**——工具 description 写得好，模型自然会选对工具，无需前缀/指令
- **"同时" 是模型的并发触发词**——语气差异直接影响 tool-call 数组长度，`并发 vs 串行` 是模型基于语言语气的推理决策
- **模型的"元认知"是最大惊喜**：识别工具限制、判断信息缺口、质疑用户前提、主动换策略——全部涌现，无需 prompt 引导
- **fetch_url 是"上下文触发"，不是唯一信息源**——模型的预训练知识经常比 fetch 内容更丰富，工具主要是"给模型一个话题"
- **Token 消耗集中在输出**——长回复的 wall-clock 时间和成本，都跟输出长度直接挂钩
- **Step 数不等于推理复杂度**——长回复流式生成会用很多步，但真正的"思考"可能只有几步
- **循环检测阈值需要场景化调整**——第 2 次重复调用不会被拦，需要 SYSTEM prompt 补一层软约束
- **Agent Loop + fetch_url 已经是 Deep Research 的雏形**——缺的只是 web_search，剩下都是产品化深度

## 下一步实践

- **Deep Research Agent**（延伸）：加 `web_search` 工具，从"给 URL"演化到"只给主题词" —— 设计方案见 [deep-research-design.md](deep-research-design.md)
- **Vibe Coding**：一句话让 Agent 生成能在浏览器直接跑的多文件 React 应用
