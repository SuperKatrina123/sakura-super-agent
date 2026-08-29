# Deep Research Agent 设计文档

从当前的 Research Agent 雏形（一次 fetch + summarize）演化到 **Deep Research 类产品**（多轮迭代研究链路）的设计方案。

> 前置阅读：[code-agent-todo-practice.md](code-agent-todo-practice.md)（代码分析实践）· [agent-loop-protections.md](agent-loop-protections.md)（三道防线）· [tool-call-concurrency.md](tool-call-concurrency.md)（工具读写锁）

## 一、目标场景

用户输入一句话（不预先给 URL）：

```
研究一下 esm.sh 的技术架构、主要竞品和适用场景
```

Agent 自主完成：

1. **搜索** 相关信息来源（不依赖用户提供 URL）
2. **并发抓取** 高相关度页面
3. **判断信息缺口**，提出新的子问题
4. **迭代 2-3 轮** 搜索 + 抓取
5. **综合成结构化报告**，写到 `reports/YYYY-MM-DD-topic.md`

对比当前 Research Agent 的差异：

| 能力 | 当前 Research Agent | Deep Research |
|---|---|---|
| 起点 | 需要用户给 URL | 只需要主题词 |
| 抓取 | 单次或简单重试 | 多轮迭代，每轮基于上一轮发现 |
| 输出 | 聊天体总结 | 结构化 md 文档 + 引用列表 |
| 上下文 | 全量塞进 messages | 摘要压缩，只保留精华 |
| 停止 | 模型自己 `hasToolCall=false` | 软停止条件（问题回答完） |

## 二、前置知识：搜索 API 生态

在设计 `web_search` 工具之前，需要先想清楚一个问题：**"搜索"这个能力到底怎么接？**

用过 Claude Code 的 WebSearch、用过 Cursor 的联网搜索，本质就是一个 Tool——调一个搜索 API 拿结果，跟我们之前写的 `get_weather` 没有本质区别。

**但搜索这个场景有意思的地方在于：市面上的搜索 API 五花八门，选哪个直接影响 Agent 的信息质量和使用成本**。

### 2.1 三类搜索 API

#### 第一类：传统搜索引擎 API（Google 生态）

**代表**：Serper、SerpAPI、ScraperAPI

**做的事**：**Google 搜索结果的爬虫代理**——绕过 Google 官方限制，拿到跟浏览器里搜 google.com 一样的结果。

**返回结构**：
```json
{
  "organic": [
    { "title": "...", "link": "...", "snippet": "150 字预览" }
  ]
}
```

**特点**：
- ✅ **搜索质量 = Google 质量**（业界天花板）
- ✅ 便宜（Serper $50 / 10K 搜索 = 单次 $0.005）
- ❌ **只返回摘要**——真要读文章还得二次 `fetch_url`
- ❌ 本质是绕过 Google 反爬的灰色地带

**适合**：预算敏感、需要 Google 结果质量、Agent 有能力二次抓取。

#### 第二类：AI-native 搜索 API

**代表**：Tavily、Exa、Perplexity Sonar API

**做的事**：**为 LLM 优化的搜索**——不只返回链接，还**抓好网页正文、按相关性排序、甚至直接给一段 AI 总结**。

**返回结构**（Tavily 示例）：
```json
{
  "answer": "AI 直接给的一段答案",
  "results": [
    { "title": "...", "url": "...", "content": "5000 字正文（不是 snippet）", "score": 0.94 }
  ]
}
```

**特点**：
- ✅ **一次调用拿全**：链接 + 正文 + 排序 + 摘要（Agent 不用二次 fetch）
- ✅ 结果为 LLM 优化过——去广告、去导航栏、按语义相关度排
- ❌ 贵（Tavily $5 / 1K 搜索 = 5 倍 Serper）
- ❌ 结果覆盖不如 Google 全（是二级源）

**适合**：Deep Research 类场景、追求"少步数完成任务"、不差钱。

#### 第三类：垂直/新范式搜索

**代表**：Brave Search（隐私中立的独立索引）、Exa（语义搜索）、Kagi（付费无广告）

**做的事**：用不同的搜索哲学：
- **Brave**：不用 Google，自建索引 + 用户隐私第一
- **Exa**：**用 embedding 做语义搜索**——搜 "startups building LLM agents"，不匹配关键词而是匹配"含义相近"的内容
- **Kagi**：付费换无广告、无 SEO 垃圾

**特点**：
- ✅ 独特的搜索能力（Exa 能找到 Google 找不到的"意图相近"内容）
- ✅ 隐私 / 无广告
- ❌ 覆盖不如 Google
- ❌ 定价更高（Kagi 用户订阅制）

**适合**：特定场景（研究、学术、隐私）、不追求"搜什么都有"。

### 2.2 三个选型判断维度

选搜索 API 本质是回答三个问题：

**问题 1：Agent 需要的是"链接"还是"内容"？**
- 需要链接（然后自己抓取）→ 传统搜索 API（Serper）
- 需要内容（一步到位）→ AI-native（Tavily）

**Deep Research 场景 → Tavily 更合适**：省一次 fetch_url 调用 = 省时间 + 省 token + 少一层不确定性（真实 fetch 可能超时、可能返回 JS-rendered 空页）。

**问题 2：搜索的"覆盖率"重要还是"精准度"重要？**
- 覆盖率（"帮我找所有相关信息"）→ Serper（Google 全量）
- 精准度（"最相关的 5 个来源就够"）→ Tavily / Exa（已排序）

**问题 3：成本能承受多少？**

单次 Deep Research 大概搜 2-3 次：

| API | 单次成本 | Deep Research 单次成本 |
|---|---|---|
| Serper | $0.005 | ~$0.015 |
| Tavily basic | $0.005 | ~$0.015 |
| Tavily advanced | $0.01 | ~$0.03 |
| Exa | $0.01 | ~$0.03 |
| Kagi | 订阅 $10/月 | 摊薄很低 |

**看起来都很便宜**——但一天跑 100 次研究，Tavily advanced 就是 $3/天 = $90/月。加上 LLM 输出成本，搜索 API 只是小头。

### 2.3 一个反直觉观察：大厂产品不用第三方 API

**主流 Deep Research 产品用的都是自己的搜索**：

- **OpenAI Deep Research** → Bing（微软战略投资、Azure 内部通道）
- **Perplexity Pro Search** → **自训练的重排模型** + 混合来源
- **Google Deep Research** → Google Search（自家）
- **Anthropic Claude** → Brave（战略合作）

**为什么不用 Tavily / Serper**？

- **成本**：产品级流量下第三方 API 成本失控
- **质量控制**：第三方 API 是黑盒，改动了你没法预警
- **战略**：搜索是护城河，用别人的等于把命脉交出去

**对我们的启示**：**做原型用 Tavily / Serper 都行，做产品必须自己控搜索层**。本文档推荐 Serper / Brave / Mock 三选一，是"能跑通"的最低成本方案——**不是"能变产品"的方案**。

### 2.4 工具接口设计：暴露差异 vs 统一抽象

从 Agent 视角看，`web_search` tool 应该长什么样？

**方案 A：暴露原始 API 差异**
```ts
web_search_serper(query, limit)
web_search_tavily(query, mode: 'basic' | 'advanced')
```
Agent 需要知道用哪个——**心智负担**。

**方案 B：统一抽象**（推荐）
```ts
web_search(query, mode: 'quick' | 'deep')
```
`quick` → Serper 拿链接；`deep` → Tavily 拿正文。Agent 只关心"要多深"，不关心后端。

**方案 B 是对的**——这跟 [src/tools/tool-registry.ts](../src/tools/tool-registry.ts) 里"读写锁"的哲学一样：**把复杂度封在工具层，Agent 只看清晰的语义**。

## 三、实测对照：Tavily 自动挡 vs Serper 手动挡

在真正实施 Deep Research 之前，我们**先接了 Tavily 和 Serper 两个后端**（[src/tools/index.ts](../src/tools/index.ts) 里的 `tavilySearchTool` / `serperSearchTool`，通过 `pickSearchTool()` 根据环境变量自动切换），并且做了**三次实测**——结果比理论预期更有意思。

### 3.1 三次实测数据

| # | 问题 | 后端 | 步数 | Token | 触发 web_fetch | Agent 表现 |
|---|---|---|---|---|---|---|
| A | esm.sh 是什么 | Tavily | 2 | 4914 | 否 | 搬运正文 |
| B | esm.sh 是什么 | Serper | 2 | 4540 | 否 | snippet 已足够，直接答 |
| C | Vercel AI SDK 最新版本 | Serper | 2 | 4948 | 否 | **中英双语并发搜索** |

### 3.2 五个关键差异点

#### （1）Token 消耗差距远小于预期

同一浅问题（"esm.sh 是什么"）:
- Tavily：**4914 token**
- Serper：**4540 token**

**只差 8%**——不是理论预估的"贵 3 倍"。原因是**这两次都是 2 步完成的浅问题**，谁都没触发多轮迭代。

Tavily 的成本溢价体现在"每条来源附带 500+ 字正文"——Agent 消化正文用了更多 output token，但整体只多几百。

**换句话说**：Tavily 更贵的假设**只在多轮场景**下成立。单次浅问答里，两者成本差异可忽略。

#### （2）输出深度：Tavily 更细，但可能是过量信息

**Tavily 输出里独有的技术细节**：
- "esm.sh 用 Go + esbuild 写的"（来自 Medium 文章正文）
- "esm.sh/tsx 是 1KB 脚本"（来自官网正文）
- "Deno 兼容"（来自官网正文）

**Serper 输出**：介绍性内容为主，没有深度细节。

**核心差异**：
- Tavily = 帮你读完 5 篇文章的摘要员
- Serper = 只给你 5 个标题让你自己判断

对"简单介绍"这类浅问题，**Tavily 的深度是过量**——用户其实不需要那么详细。反过来对"研究报告"类深问题，Serper 的 snippet 就明显不够。

#### （3）Agent 智能表现：Serper 场景更精彩

**Tavily 场景**：Agent 就是搬运工——正文都给你了，翻译整理输出即可。**几乎没有"推理"**。

**Serper 场景**（C 实验最典型）：Agent 表现出**三层规划能力**：

```
Step 1（一步内并发）：
  [调用: web_search({"query":"Vercel AI SDK latest version"})]    ← 英文搜索
  [调用: web_search({"query":"Vercel AI SDK 最新版本"})]           ← 中文搜索
```

- **并发意图**：一步内发出 2 个 tool 调用
- **双语覆盖**：主动想到中英双语搜索能覆盖不同信息源
- **信息源判断**：从 10 条 snippet 里精准挑出 npm 官方页面（认为最权威）

这**不是我用 SYSTEM prompt 引导的**——是模型自己的规划。**"手动挡逼出研究员气质"**的最好证据。

#### （4）触发 web_fetch 的真实边界

**三次实测里没有一次自然触发 web_fetch**——原因是这些问题的答案都在 snippet 或 Tavily 摘要里。

**我之前的判断（"深问题就会触发"）不够准确**。真正的规律是：

**web_fetch 触发条件 = "snippet 里没有明确答案 + 用户问的是具体细节"**

- ✅ 触发：`esm.sh 的构建流程细节` → snippet 只有介绍
- ✅ 触发：`v3 Language Model Specification 跟 v2 有什么区别` → 需要读 blog 原文
- ❌ 不触发：`esm.sh 是什么` → snippet 已足够
- ❌ 不触发：`最新版本是什么` → snippet 里 npm 页面明确写了 `7.0.79`

**Agent 会自己判断这个边界**——**"够用即停"** 是元认知的直接体现。

#### （5）意外发现：工具设计失误

C 实验暴露了一个隐性 bug——**当时项目里同时存在 `fetch_url`（老）和 `web_fetch`（新）**：

```
[调用: fetch_url({"url":"https://www.npmjs.com/package/ai"})]   ← 模型选错了
```

- `fetch_url` 带 MOCK_PAGES 拦截（老演示用）
- `web_fetch` 纯真实网络（新加的）
- 功能重叠，模型面对语义相似的两个工具**随机选择**
- 选到 `fetch_url` 后如果命中 MOCK_PAGES，**用户以为在跑真实数据，实际是假数据**

**修复**：删掉 `fetch_url`，只留 `web_fetch`。**工具集不允许语义重叠**。

### 3.3 决策建议

结合三次实测数据 + 五个差异点：

| 场景 | 推荐后端 | 理由 |
|---|---|---|
| 生产级 Agent（聊天/问答） | **Tavily** | 一步搞定、失败面小、延迟低 |
| 学习/演示（技术分享、教学） | **Serper** | 能观察 Agent 完整决策链 |
| Deep Research（研究报告） | **Serper + SYSTEM 引导** | 强制 web_fetch，展示多轮迭代 |
| 混合场景 | 两个都接，环境变量切换 | 现在这个项目的做法 |

### 3.4 从三次实测吸收的教训

**教训 1：不要假设"深问题一定触发多步"**。Agent 会自己判断信息够不够，snippet 质量高的话就一步答完。想触发多步，要么问 snippet 答不出的问题，要么 SYSTEM prompt 强制约束。

**教训 2：Tavily 的成本溢价场景性**。浅问题差不多、深问题差距扩大——真实成本要在具体场景测才知道。

**教训 3：工具集合语义重叠是隐性 bug**。新工具替代旧工具时必须删掉旧的。**"以防万一留着"是错的**——Agent 面对两个相似工具会随机选择，出错难以复现。

**教训 4：`isConcurrencySafe: true` 让"双语搜索"这种智能行为变得可能**。如果 web_search 声明串行，模型也只会一次发一个 query。**工具的并发属性会影响 Agent 的规划风格**。

## 四、架构增量

### 4.1 新增工具：`web_search`

**接口设计**：

```ts
export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取相关信息。返回一组 title/url/snippet，用于后续 fetch_url 精读',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询（自然语言或关键词）' },
      limit: { type: 'number', description: '返回结果数，默认 5，最大 10' },
    },
    required: ['query'],
  },
  isConcurrencySafe: true,   // 只读、可并发
  isReadOnly: true,
  maxResultChars: 2000,      // snippet 集合不会太长，兜底截断
  execute: async ({ query, limit = 5 }) => {
    // 后端可插拔：Serper / Brave / Bing / 自建索引
    const results = await searchProvider.search(query, limit);
    return results.map(r => `【${r.title}】\n${r.url}\n${r.snippet}`).join('\n\n---\n\n');
  },
};
```

**返回格式约定**：

```
【标题】
https://url.com
摘要片段（100-200 字）

---

【标题 2】
...
```

模型看到这个格式，自然会用后续的 fetch_url 精读 URL。**格式即接口**。

### 4.2 后端可插拔设计

`searchProvider` 抽象成一个接口，具体实现在环境变量控制下切换：

```ts
interface SearchProvider {
  search(query: string, limit: number): Promise<SearchResult[]>;
}

const SERPER_KEY = process.env.SERPER_API_KEY;
const BRAVE_KEY = process.env.BRAVE_SEARCH_KEY;

export const searchProvider: SearchProvider =
  SERPER_KEY ? new SerperProvider(SERPER_KEY) :
  BRAVE_KEY ? new BraveProvider(BRAVE_KEY) :
  new MockSearchProvider();  // 演示 fallback
```

**Mock 实现**：预置几个主题的搜索结果字典，让无 API key 时也能跑通链路演示。

### 4.3 提示词工程：Deep Research 模式

在 [src/index.ts](../src/index.ts) 的 `SYSTEM` 里追加一段：

```
当用户请求"研究"、"调研"、"深入了解"某个主题时，进入深度研究模式：

1. **第一轮**：用 web_search 搜 1-2 个核心查询词，拿到 5-10 个来源
2. **筛选**：从 snippet 里判断哪 3-5 个最相关，用 fetch_url 并发精读
3. **反思**：读完后回答自己三个问题：
   - 用户的问题回答完整了吗？
   - 有没有新的子问题浮现？
   - 有哪些信息是缺失或冲突的？
4. **第二轮**（如果需要）：针对子问题再 web_search + fetch_url
5. **综合**：用 write_file 把最终报告写到 reports/YYYY-MM-DD-topic.md
   - 报告结构：摘要 / 关键发现 / 详细分析 / 引用列表
   - 每个论点必须标注来源 URL
6. **停止**：最多迭代 3 轮 web_search，避免无限探索

如果不是研究场景，按普通对话回答，不要强行进入研究模式。
```

关键点：
- **触发词**明确（"研究"、"调研"、"深入了解"）
- **迭代上限**硬约束（最多 3 轮 web_search）
- **输出格式**明确（结构化 md + 引用）
- **元认知步骤**（"反思"环节是 Deep Research 的核心区别）

### 4.4 上下文管理（可选，二阶段）

**问题**：Deep Research 一次能跑 20+ 次 fetch_url，每次返回 1500 字 → messages 累计 30000+ 字 → token 消耗爆炸。

**方案 A：抓完立即摘要**（简单）

fetch_url 结果不直接进 messages，先跑一次内部摘要：

```
[原始 fetch 结果 1500 字]
       ↓ 内部调用（不进 messages）
[摘要 300 字：核心观点 + 关键数据 + URL]
       ↓
messages 只保留摘要
```

**代价**：每次 fetch 多一次模型调用，但 messages 总长度可控。

**方案 B：Scratchpad（进阶）**

新增 `scratchpad_write` / `scratchpad_read` 工具，让模型自己维护研究笔记：

```
messages（对话流）      scratchpad（研究笔记）
    - user 提问             - 发现：esm.sh 用 esbuild
    - assistant 计划        - 疑问：竞品是谁？
    - tool: fetch          - 已读：[url1, url2]
    - assistant 反思        - 下一步：搜"esm cdn 竞品"
```

每轮开始时，模型看 messages（对话上下文） + scratchpad 摘要（研究进度），不看原始 fetch 结果。

**方案 B 是产品级设计**，但也是最复杂的一层——建议先跑通方案 A，遇到瓶颈再上 B。

## 五、Agent Loop 层面的变化

好消息：**几乎不用改**。

现有的 [src/agent/loop.ts](../src/agent/loop.ts) 已经支持：
- ✅ 多轮工具调用（while 循环）
- ✅ 并发工具调用（tool-call 数组 → SDK 并发执行）
- ✅ Token 预算追踪
- ✅ 循环检测（会防止模型钻牛角尖反复搜同一个词）

需要调整的两个参数：

```ts
// src/index.ts
const budget: BudgetState = { used: 0, limit: 200000 };  // 从 60000 调到 200000

// src/agent/loop.ts
const MAX_STEPS = 50;  // 从 30 调到 50
```

**理由**：Deep Research 一次典型对话是 15-25 步（3 轮 search × 每轮 3-5 个 fetch + 反思 + 综合），token 消耗 100k-200k。

## 六、防线的新角色

### 4.1 循环检测：从"防呆"到"防重复搜索"

现在的循环检测 [src/agent/loop-detection.ts](../src/agent/loop-detection.ts) 用**工具名 + 参数**做指纹。Deep Research 里如果模型反复 `web_search("esm.sh")` 拿到相同结果，`generic_repeat` 会触发。

**新场景下的判断**：如果模型迭代到第 3 轮还在搜同一个词，说明它规划失控——该拦。

### 4.2 Token 预算：从"防泄漏"到"防跑飞"

真实场景下，Deep Research 一次调用可能烧 300k+ token（多轮 + 长文档），一次 API 费用可能几美分到几毛钱。**Token 预算成为最重要的成本控制手段**。

建议加一个"软警告"层——超过 80% 时在下一步提醒模型"预算快到了，请开始综合"：

```ts
if (budget.used / budget.limit > 0.8 && !warned) {
  messages.push({
    role: 'user',
    content: '[系统提醒] Token 预算已用 80%，请停止新的搜索，开始综合报告'
  });
  warned = true;
}
```

### 4.3 MAX_STEPS：硬闸门

30 步不够时调到 50。但**不要无限调大**——步数上限是最后的安全网，防止无限循环。

## 七、Mock 层演化（可选）

如果想保持 mock 模式下的可演示性，需要在 [src/mock-model.ts](../src/mock-model.ts) 加：

1. **`detectResearchInitial`**：识别"研究 XXX" → 首轮返回 web_search 意图
2. **`detectResearchFetch`**：识别上一步是 web_search → 从结果里抽 URL → 并发 fetch_url
3. **`detectResearchReflect`**：识别 fetch 完成 → 返回文本（模拟"反思"）→ 决定是否再搜一轮
4. **`detectResearchReport`**：识别到综合阶段 → 调 write_file 写 md

**代价**：写完就是四个硬编码 detector，不能真研究任意主题。**但演示价值有限**——Deep Research 的核心价值是**元认知**，mock 模拟不出。

**建议**：这个实践只对真实模型有意义，mock 层不做深度改造。

## 八、验证清单

跑通后应该能观察到：

- [ ] 一句话"研究 XXX"触发 web_search
- [ ] Step 1 是 web_search（可能并发 2 个不同 query）
- [ ] Step 2 是并发 3-5 个 fetch_url（`[并发] fetch_url 获取共享锁` × N）
- [ ] Step 3 模型输出"反思" 文本，说清楚"下一步要搜什么"
- [ ] Step 4+ 如果反思发现缺口，再一轮 web_search + fetch_url
- [ ] 最终一步 write_file 到 `reports/` 目录
- [ ] 完整报告有摘要 / 关键发现 / 引用列表结构

## 九、成本预估（真实模型）

按 DeepSeek-Chat 定价（假设 1M 输入 ¥1 / 1M 输出 ¥8）：

| 场景 | 估算 |
|---|---|
| 3 轮 search + 10 次 fetch | 输入 ~50k / 输出 ~80k = **~¥0.7** |
| 完整报告（3000 字）| 计入上述输出 |
| 一天 100 次研究 | ~¥70 |

Serper API 免费 2500 次搜索 → 一天 100 次研究，每次 2-3 个搜索 = **免费额度够用几周**。

## 十、实施路径（如果决定动手）

**Day 1**：注册 Serper 拿 key + 实现 `web_search` 工具 + 注册到 tool 列表
**Day 2**：改 SYSTEM prompt + 跑第一个真实场景（"研究 esm.sh"）
**Day 3**：观察问题（token 爆掉？循环？质量差？）+ 迭代 prompt
**Day 4（可选）**：加"抓完立即摘要"（方案 A）压缩上下文
**Day 5（可选）**：加 scratchpad 工具（方案 B）

## 十一、Deep Research 类产品的护城河

技术架构层面，做到"能跑"其实门槛不高——**你现在的 Agent Loop + fetch_url 就是雏形**。真正的护城河在：

1. **搜索质量**：Perplexity 有自己训练的**重排模型**，OpenAI Deep Research 有 Bing 深度集成
2. **上下文压缩**：多 Agent 架构（研究员 Agent + 编辑 Agent 交替工作）
3. **引用忠实性**：确保输出每一句话都能追溯到具体 URL 的具体段落
4. **UI 呈现**：把研究过程可视化（正在读什么、发现了什么），是**产品体验**层面的事

**架构层面，你已经到了。剩下的都是产品化的深度。**

## 十二、决策点

在开工之前需要拍板：

1. **搜索后端**：Serper vs Brave vs Mock
2. **上下文压缩**：现在做（方案 A）还是等瓶颈出现再做
3. **Mock 支持**：要不要做（推荐不做，价值有限）
4. **报告输出**：只写 md 文件？还是加个简单的 HTML 预览（复用 start_preview）？

这些决策会影响实施节奏——不是所有点都要现在做，先跑通再迭代。
