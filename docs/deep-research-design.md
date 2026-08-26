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

## 二、架构增量

### 2.1 新增工具：`web_search`

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

### 2.2 后端可插拔设计

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

### 2.3 提示词工程：Deep Research 模式

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

### 2.4 上下文管理（可选，二阶段）

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

## 三、Agent Loop 层面的变化

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

## 四、防线的新角色

### 4.1 循环检测：从"防呆"到"防重复搜索"

现在的循环检测 [src/loop-detection.ts](../src/loop-detection.ts) 用**工具名 + 参数**做指纹。Deep Research 里如果模型反复 `web_search("esm.sh")` 拿到相同结果，`generic_repeat` 会触发。

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

## 五、Mock 层演化（可选）

如果想保持 mock 模式下的可演示性，需要在 [src/mock-model.ts](../src/mock-model.ts) 加：

1. **`detectResearchInitial`**：识别"研究 XXX" → 首轮返回 web_search 意图
2. **`detectResearchFetch`**：识别上一步是 web_search → 从结果里抽 URL → 并发 fetch_url
3. **`detectResearchReflect`**：识别 fetch 完成 → 返回文本（模拟"反思"）→ 决定是否再搜一轮
4. **`detectResearchReport`**：识别到综合阶段 → 调 write_file 写 md

**代价**：写完就是四个硬编码 detector，不能真研究任意主题。**但演示价值有限**——Deep Research 的核心价值是**元认知**，mock 模拟不出。

**建议**：这个实践只对真实模型有意义，mock 层不做深度改造。

## 六、验证清单

跑通后应该能观察到：

- [ ] 一句话"研究 XXX"触发 web_search
- [ ] Step 1 是 web_search（可能并发 2 个不同 query）
- [ ] Step 2 是并发 3-5 个 fetch_url（`[并发] fetch_url 获取共享锁` × N）
- [ ] Step 3 模型输出"反思" 文本，说清楚"下一步要搜什么"
- [ ] Step 4+ 如果反思发现缺口，再一轮 web_search + fetch_url
- [ ] 最终一步 write_file 到 `reports/` 目录
- [ ] 完整报告有摘要 / 关键发现 / 引用列表结构

## 七、成本预估（真实模型）

按 DeepSeek-Chat 定价（假设 1M 输入 ¥1 / 1M 输出 ¥8）：

| 场景 | 估算 |
|---|---|
| 3 轮 search + 10 次 fetch | 输入 ~50k / 输出 ~80k = **~¥0.7** |
| 完整报告（3000 字）| 计入上述输出 |
| 一天 100 次研究 | ~¥70 |

Serper API 免费 2500 次搜索 → 一天 100 次研究，每次 2-3 个搜索 = **免费额度够用几周**。

## 八、实施路径（如果决定动手）

**Day 1**：注册 Serper 拿 key + 实现 `web_search` 工具 + 注册到 tool 列表
**Day 2**：改 SYSTEM prompt + 跑第一个真实场景（"研究 esm.sh"）
**Day 3**：观察问题（token 爆掉？循环？质量差？）+ 迭代 prompt
**Day 4（可选）**：加"抓完立即摘要"（方案 A）压缩上下文
**Day 5（可选）**：加 scratchpad 工具（方案 B）

## 九、Deep Research 类产品的护城河

技术架构层面，做到"能跑"其实门槛不高——**你现在的 Agent Loop + fetch_url 就是雏形**。真正的护城河在：

1. **搜索质量**：Perplexity 有自己训练的**重排模型**，OpenAI Deep Research 有 Bing 深度集成
2. **上下文压缩**：多 Agent 架构（研究员 Agent + 编辑 Agent 交替工作）
3. **引用忠实性**：确保输出每一句话都能追溯到具体 URL 的具体段落
4. **UI 呈现**：把研究过程可视化（正在读什么、发现了什么），是**产品体验**层面的事

**架构层面，你已经到了。剩下的都是产品化的深度。**

## 十、决策点

在开工之前需要拍板：

1. **搜索后端**：Serper vs Brave vs Mock
2. **上下文压缩**：现在做（方案 A）还是等瓶颈出现再做
3. **Mock 支持**：要不要做（推荐不做，价值有限）
4. **报告输出**：只写 md 文件？还是加个简单的 HTML 预览（复用 start_preview）？

这些决策会影响实施节奏——不是所有点都要现在做，先跑通再迭代。
