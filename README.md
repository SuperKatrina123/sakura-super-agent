# sakura-super-agent

从零构建 Agent 的学习项目：把一个只会聊天的 ChatBot，一步步演化成能自主调用工具、多步推理的 **Agent Loop**，并给它装上三道"保险丝"、一套带并发控制的工具系统、可挂载真实 MCP Server、应对工具膨胀的 ToolSearch 延迟加载、跨进程续对话的 Session 持久化、模块化 SYSTEM 的 Prompt Pipe、长会话压缩的 Microcompact + Summarization、零 LLM 即时防线（Token 追踪 + TTL 修剪 + 动态截断），以及成本可视化（Cache 感知 + `/context` / `/usage` 快捷命令）。

## 从 ChatBot 到 Agent Loop

演化路径在 [`history/`](history/) 里逐版保留（参考快照，非可运行代码）：

1. **`generateText`** —— 单次调用，一次性拿回结果
2. **`streamText`** —— 流式输出，逐字打印
3. **`ask`** —— 递归 readline 交互，有了"对话"
4. **`stopWhen`** —— 定义工具，改用 `fullStream` 处理工具调用事件
5. **`loop`** —— Agent Loop 本体：`while` 循环让模型"思考 → 行动 → 观察 → 再思考"
6. **防护系统** —— 为循环加三道保险：循环检测、API 容错、Token 预算

### Agent Loop 的心脏

这个 `while` 循环就是 Agent 的心脏，结构上很像 CPU 的主循环：

|  | CPU | Agent Loop |
|---|---|---|
| 取指 | 从内存取下一条指令 | 从模型拿下一轮输出 |
| 执行 | ALU 计算、访问内存 | 执行工具调用 |
| 写回 | 结果写回寄存器 | 结果写回 `messages` |
| 退出 | 收到关机指令 | 模型决定"信息够了，可以回复了" |

行为上的质变：AI 从**"只会说"**变成了**"能做"**。每轮模型都可以选择"继续调工具"还是"直接回复"。

## Agent Loop 的三道防护

> 📖 本节只是速览。想复习实现细节（指纹怎么算、滑动窗口怎么维护、三个检测器怎么计数、退避公式、在 loop 里怎么接线），见 [docs/agent-loop-protections.md](docs/agent-loop-protections.md)。

把循环想象成家里的配电箱，三种保护各管一摊、互不干扰：

- **循环检测** = 短路保护（防止电流乱窜）
- **API 容错** = 过载保护（防止设备过热）
- **Token 预算** = 漏电保护（防止资源泄露）

### 🔄 循环检测：短路保护

**问题**：模型反复做同样的事且没有进展，白白烧 token。

**实现**：[`src/loop-detection.ts`](src/loop-detection.ts)

核心思路是 **指纹 + 滑动窗口**：

- 每次工具调用算一个**指纹**（工具名 + 参数稳定序列化后的 SHA-256）
- 维护最近 **30 条**调用的滑动窗口
- 三个检测器，覆盖三种卡死模式：

| 检测器 | 检测什么 | 阈值 |
|---|---|---|
| `generic_repeat` | 同一工具 + 相同参数反复调用 | ≥5 警告 / ≥8 熔断 |
| `ping_pong` | 两个工具来回交替、无进展 | ≥5 警告 / ≥8 熔断 |
| `global_circuit_breaker` | 相同调用且结果逐次不变（无进展） | ≥10 直接熔断 |

（阈值是演示值，生产环境通常会调大）

- **分级响应**：
  - **警告**：向 `messages` 注入一条系统提醒，引导模型换思路，循环继续
  - **熔断**：直接 `break`，强制停止 Agent

**测试**：输入 `测试死循环`，mock 模型会不断调用同一个 `get_weather`，观察"警告 → 熔断 → 停止"。

### 🛡️ API 容错：过载保护

**问题**：API 限流、超时、断网，直接抛错整个进程就崩了。

**实现**：[`src/retry.ts`](src/retry.ts) + [`src/agent/loop.ts`](src/agent/loop.ts)

- **错误分类**（`isRetryable`）：
  - 可重试：`429` / `529` / `408`、`5xx`、网络错误（`ECONNRESET`、`ETIMEDOUT`、`fetch failed`…）、`NoOutputGeneratedError`
  - 不可重试：其他 `4xx`（说明是请求本身的问题，重试也没用）
- **指数退避 + 随机抖动**（`calculateDelay`）：base 500ms、上限 30s，失败一次延迟翻倍，并叠加 ±25% 抖动，避免重试风暴
- **步骤级重试**：把 SDK 的 `maxRetries` 设为 0，由 `agentLoop` 自己接管——重试包裹**整个 stream 消费过程**，最多 3 次

**测试**：输入 `测试重试`，mock 模型会先连抛两次 `429` 再成功，观察自动重试而非崩溃。

### 💰 Token 预算：漏电保护

**问题**：长对话 token 消耗不可控，预算烧完了模型还在跑。

**实现**：[`src/agent/loop.ts`](src/agent/loop.ts)

- **预算由调用方持有**：`src/index.ts` 里的 `{ used: 0, limit: 600000 }` 跨轮持续累计，`agentLoop` 只负责消费它
- 每步把 `input + output` token 累加进 `budget.used`，实时打印 `used/limit (pct%)`
- 超过 `limit` → 打印提示并**强制停止**

**测试**：输入 `测试预算`，mock 模型每步上报 4500 token，几轮内就能看到预算耗尽被强制停止。

> 最后还有一道闸：`MAX_STEPS = 15`，无论模型怎么绕，最多跑 15 步。

## 🧰 工具系统

> 📖 本节只是速览。想复习实现细节（读写锁的三个状态变量怎么工作、结果截断为什么必要、每个工具声明了哪些并发属性、工具执行层与三道防线的分工），见 [docs/tool-call-concurrency.md](docs/tool-call-concurrency.md)。

三道防线防的是**循环层面**的故障；工具系统管的是**工具执行层**。目前已注册 12 个内置工具（[`src/tool/index.ts`](src/tool/index.ts)）：

| 工具 | 说明 | 并发属性 | 加载 |
|---|---|---|---|
| `get_weather` | 查城市天气（假数据） | 可并发 · 只读 | 立即 |
| `calculator` | 计算数学表达式 | 串行（未声明，走保守默认） | 立即 |
| `read_file` | 读文件 | 可并发 · 只读 | 立即 |
| `write_file` | 写文件 | 串行 · 读写 | 立即 |
| `list_directory` | 列目录 | 可并发 · 只读 | 立即 |
| `edit_file` | 精确替换文件片段（非全量覆写） | 串行 · 读写 | 立即 |
| `bash` | 执行 shell 命令 | 串行 · 读写 | 立即 |
| `grep` | 按正则搜文件内容 | 可并发 · 只读 | 立即 |
| `glob` | 按通配符搜文件 | 可并发 · 只读 | 立即 |
| `web_search` | 联网搜索（Tavily / Serper） | 可并发 · 只读 | **延迟** |
| `web_fetch` | 抓网页并转 Markdown | 可并发 · 只读 | **延迟** |
| `start_preview` | 启动 app/ 目录预览服务器 | 串行 · 读写 | **延迟** |

外加一个元工具 `tool_search`（详见下面的 ToolSearch 章节）。

- **读写锁**（[`src/tool-registry.ts`](src/tool-registry.ts)）：只读工具并行执行，有副作用的工具串行执行——独占锁必须等所有共享锁释放。用三个状态变量手写，约 40 行，零依赖。
- **结果截断**：工具返回值超过 `maxResultChars` 时保留头尾、丢弃中间并提示，防止长网页/日志把上下文撑爆。
- **声明即纪律**：每个工具用 `isConcurrencySafe` / `isReadOnly` 声明并发属性，`ToolRegistry` 据此决定拿共享锁还是独占锁。保守默认：不声明就按串行走——宁可慢，不可错。
- **延迟加载**：`shouldDefer: true` 的工具默认不进 system prompt，由 `tool_search` 元工具按需激活——见下节。

## 🔌 MCP 集成

> 📖 本节只是速览。完整实现（stdio 传输、JSON-RPC id-map、握手时序、三层降级、手写 vs 官方 SDK 对比），见 [docs/mcp-integration-practice.md](docs/mcp-integration-practice.md)。

工具集有天花板——真正的能力扩张来自 **MCP (Model Context Protocol)**：任何工具提供方按协议实现一个 server，任何 client 都能直接接入。项目里挂上一个 GitHub MCP server 就能获得 26 个真实 GitHub 工具。

**核心决策**：抽象出 `MCPClientLike` 结构接口，让所有 MCP client 实现（手写 stdio / 官方 SDK / Mock 降级）在 `ToolRegistry` 眼里都长一个样——**换实现零改动**。

三种 MCP client 并存：

| 实现 | 位置 | 用途 |
|---|---|---|
| **手写 stdio 版** | [`src/mcp/client.ts`](src/mcp/client.ts) | 教学载体：110 行看清 JSON-RPC + stdio + id-map 全流程 |
| **官方 SDK 版** | [`src/mcp/sdk-client.ts`](src/mcp/sdk-client.ts) | 生产推荐：`@modelcontextprotocol/sdk` 帮你处理握手 / 超时 / 版本协商 |
| **Mock 降级版** | [`src/mcp/mock-client.ts`](src/mcp/mock-client.ts) | 三层降级兜底：真实 server 起不来时不阻塞主流程 |

env switch 二选一：

```bash
MCP_CLIENT_KIND=sdk npm start          # 默认，生产推荐
MCP_CLIENT_KIND=handwritten npm start  # 教学版
```

两种模式下**注册的工具数、Agent Loop 的行为、工具调用结果完全一致**——26 个 GitHub 工具、38 个总工具。这就是 `MCPClientLike` 抽象成立的证据：`ToolRegistry.registerMCPServer` 一行不用改。

**工具名前缀**：`mcp__<serverName>__<toolName>`（跟 Claude Code 一致），避免多 server 同名冲突。执行时闭包脱前缀，发给 server 的是原始 name。

## 🔍 ToolSearch 延迟加载

> 📖 本节只是速览。想复习完整设计（Profile vs Lazy Loading、判定标准、Prompt Cache 权衡矩阵），见 [docs/tool-search-design.md](docs/tool-search-design.md)。

**问题**：接了 MCP 后工具数轻松破 40。全部 schema 塞进 system prompt 有两个痛：
- **显性痛**：token 成本（50 个工具 ≈ 5500 tokens 常驻）
- **隐性痛**：模型面对几十个语义相邻的工具选错概率显著上升

**类比**：把工具集加一层搜索引擎——不需要把所有商品摆在货架上，顾客要什么搜一下就行。

### 三个字段搭起来的机制

在 `ToolDefinition` 上加两个字段：

```ts
shouldDefer?: boolean;    // 是否延迟加载
searchHint?: string;       // 检索关键词（不进 prompt，只喂给 searchTools）
```

加一个元工具 `tool_search`（[`src/tool/tool-search.ts`](src/tool/tool-search.ts)）：

```
system prompt 尾巴挂 defer 目录（工具名 + hint 列表）
                ↓
模型看到 → 判断需要 mcp__github__list_issues → 调 tool_search
                ↓
registry.searchTools() 精确名字匹配 → 加入 discoveredTools
                ↓
下一轮 tools 参数里出现该工具 → 模型直接调用
```

**一步式激活**（搜索即激活）而非两步式（search + load）——省一次 round-trip，接近 Claude Code 的做法。

### 实测效果

启动时自动统计：

```
=== 工具统计 ===
  全部工具: 50 个
  活跃工具: 10 个（直接进 system prompt）
  延迟工具: 40 个（走 tool_search 按需激活）
  Token 估算: ~654 (活跃) + ~4881 (延迟，不占 prompt)
  节省比例: ~88%
```

单轮账：naive 全量 ≈ 5535 tokens，ToolSearch ≈ 1654 tokens（含 defer 目录 + 元工具调用），**净省 ~70%/轮**。

### 一个诚实的 tradeoff

动态改 `tools` 参数会让 Prompt Cache 前几轮失效——但工具发现集中在对话前几轮，属于**一次性折损**而非持续损失。Claude Code 用 Anthropic 的 `defer_loading` beta 完全避开 cache 问题，但那是 Anthropic 独有，模型无关的项目用不了。生产推荐我们这个做法：**用原生 tools 列表做延迟加载，稳定性更有保障**。

## 💾 Session 持久化

> 📖 本节只是速览。完整设计（JSONL 选型、崩溃安全语义、恢复 vs 重放、`--continue` npm 参数踩坑），见 [docs/session-persistence.md](docs/session-persistence.md)。

**问题**：REPL 里 `messages` 数组是**进程内内存**——Ctrl+C 一按全没了，下次启动是白纸一张。

**方案**：JSONL append-only 存储 + `--continue` 显式恢复。

三个选型理由：

- **Append-only 天然崩溃安全**——`O_APPEND` 原子写入，最多丢正在写的那一行，历史完好
- **可 grep / cat / jq**——所有你已经熟悉的 Unix 工具直接用，SQLite 得学它的 CLI
- **零依赖**——只用 `node:fs`，Node 内置

用法：

```bash
npm start                          # 新会话
npm run start -- --continue        # 恢复上次的会话（注意 -- 必须加，否则 npm 吃掉 flag）
```

启动时会打印 session debug——文件路径、大小、消息分布、时间跨度，避免"文件建哪了""历史多大了"这类问题。

**关键设计**：恢复不等于重放。工具已经跑过了、副作用已经落地——不能再执行一次。`store.load()` 只把 messages 塞回数组，模型看到完整历史、**继续对话**。

## 🧩 Prompt Pipe

> 📖 本节只是速览。完整设计（PipeFn / PromptContext / 顺序即 cache 策略 / 4 个默认 segment 的取舍），见 [docs/prompt-pipe-design.md](docs/prompt-pipe-design.md)。

**问题**：SYSTEM 字符串会随着功能增加变成屎山：

```ts
const SYSTEM = `你是 Super Agent。
${isVibeCoding ? vibeCodingRules : ''}
${hasMemory ? memoryText : ''}
${discoveredTools.size > 0 ? deferredSummary : ''}
${gitBranch ? `分支: ${gitBranch}` : ''}
...`;   // ← 几个月后 AI 都改不动
```

**方案**：把 SYSTEM 拆成独立 segment，每个是一个纯函数——`(ctx) => string | null`。

```ts
const promptBuilder = new PromptBuilder()
  .pipe('coreRules', coreRules())            // 永远不变——cache 稳稳命中
  .pipe('toolGuide', toolGuide())            // 工具数量基本固定
  .pipe('deferredTools', deferredTools())    // 所有工具列表基本固定，放中间
  .pipe('sessionContext', sessionContext()); // 每次启动都不同，放最后
```

**核心洞见**：**顺序即 cache 策略**——变化频率低的靠前、高的靠后。让 prompt cache 前缀匹配到"第一个变化的字节"才停，最大化命中率。

启动时打印 pipe debug：

```
=== Prompt Pipe Debug ===
  [ON]  coreRules: 87 chars
  [ON]  toolGuide: 24 chars
  [ON]  deferredTools: 3840 chars
  [OFF] sessionContext                   ← 新会话时不占位置
  ────────────────────────
  Total: 3951 chars
========================
```

`[OFF]` 显式列出——**Pipe 模式的按需出现**变得可见。加新 segment 就是加一行 `.pipe()`，条件逻辑内嵌在 segment 里、零字符串屎山。

## 🗜️ 上下文压缩

> 📖 本节只是速览。完整设计（三类内容的可压缩性、表格化 prompt 的关键、级联压缩、user 边界对齐），见 [docs/context-compression.md](docs/context-compression.md)。

**问题**：长会话里 `messages` 数组无限增长。工具密集任务里 100 轮就顶到模型 context 窗（128k）——**API 直接 400 拒绝**，不是性能问题是能不能工作的问题。

**核心洞察**：`messages` 里三类内容可压缩性完全不同——

| 类别 | 大小占比 | 可压缩性 |
|---|---|---|
| SYSTEM prompt（Prompt Pipe 拼出来的） | 5-15% | **不能压** |
| 对话历史（user + assistant text） | 15-25% | 难压 |
| **工具调用记录**（tool_call + tool_result） | **60-80%** | **好压** |

**分层策略**：先便宜后贵、能保结构不摘要。

**Layer 1：Microcompact** — 零 LLM 调用，把旧的**查询类**工具结果（`read_file` / `list_issues` / ...）替换成 `[tool result cleared]`。保留消息结构、工具名、assistant 结论。副作用类工具（`create_issue` / `write_file` / ...）永不清——它们的返回值可能是未来操作的锚点。

**Layer 2：Summarization** — Microcompact 之后 context 仍超阈值（默认 6k tokens，生产建议 60k），调 LLM 把老对话压成一段**结构化摘要**：

```
## 用户意图
## 已完成的操作
## 关键发现
## 当前状态
## 需要保留的细节
```

**关键洞见**：**给模型一个表格让它填，而不是让它自由写作**。表格越具体，压缩结果越稳定——次次结构一致、下游可稳定利用。这是 Manus 分享过的最佳实践。

**级联压缩**：每次压缩把上一次的摘要一起再压——任何时刻 messages[0] 只有一段摘要，摘要是"滚动更新的历史"、不是"堆积的段落"。caller 只传 messages 即可、无需管状态——`summarize()` 内部自动从 messages[0] 提取上次摘要。

日志：

```
--- Step 5 ---
  [Microcompact] 清理了 3 个旧工具结果             ← 零成本、每轮跑
  [Summarize] 压缩了 12 条老对话为摘要（684 字符）  ← 超阈值才跑
```

## 🛡️ 零 LLM 即时防线

> 📖 本节只是速览。完整设计（TokenTracker 精确基准+粗估增量、TTL 两档修剪、双 Pass 截断、两条铁律、WeakMap 存 timestamp），见 [docs/instant-defenses.md](docs/instant-defenses.md)。

**问题**：Microcompact 和 Summarization 之间有一大片空间没利用——**大部分上下文膨胀不需要动用 LLM**：
- 读了个 5 万字符的文件 → 截断到 5000 就够了
- 10 分钟前的 grep 结果 → 直接清掉

**方案**：在 Summarization 之前插三层**零 LLM 的即时防线**——纯字符串操作、毫秒级完成。

### 三层防线

**Layer 1: TokenTracker** — 精确基准 + 粗估增量
- 每次 API 返回时用 `usage.inputTokens` 作为**精确基准**
- 中间新增的 message 用字符/4 粗估补上
- 关键性质：**偏差不累积**——每次 API 校准都重置增量

**Layer 2: 动态截断** — 双 Pass 大小控制
- Pass 1: 单条 tool_result > 50% 窗口 → Head/Tail 60/40 分割
- Pass 2: 总量 > 75% 窗口 → 从最老 tool_result 开始整体清空

**Layer 3: TTL 修剪** — 两档时间衰减
- 5 min 软修剪：保留头 1500 + 尾 1500 字符
- 10 min 硬清除：只留 `[tool result expired: {toolName}]`

### 两条铁律

1. **只修剪 tool 消息**——user / assistant 永不修剪（对话结构必须完整）
2. **错误经验保留**——含 `error / 失败 / denied / timeout` 等关键词的 tool_result 永不修剪，避免模型重复走死路

### REPL 快捷命令验证

```
You: sim       ← 注入 20 条模拟历史（一半 12 min 前 / 一半 7 min 前）
You: status    ← [Status] 20 条消息, ~12000 tokens
You: defend    ← 手动触发三层防线

--- 执行三层防线 ---
  [Layer 2] 截断: 0 条, 预算清理: 0 条
  [Layer 3] 软修剪: 5, 硬清除: 5
  [结果] ~12000 → ~4500 tokens (节省 7500)
```

**四层协同顺序**（在 agentLoop 每轮开头）：TTL → 截断 → Microcompact → Summarization。**便宜的先跑、贵的最后兜底**——每一层都可能让下一层"没事做"。

## 💰 成本可视化

> 📖 本节只是速览。完整设计（Cache 三种模式对比、各家 provider 定价矩阵、UsageTracker 的四类 token 归一化、31% 命中率背后的架构分析），见 [docs/cost-visualization.md](docs/cost-visualization.md)。

**核心洞察**：**上下文小 ≠ 花钱少**。同样 20k tokens 聊 50 轮 = 1M tokens 计费——SYSTEM prompt、工具描述、历史消息**每轮都要重新付费**。

**方案**：Prompt Cache——服务端缓存前缀、下次相同前缀直接复用、只花 10-25% 价格。

### Prompt Cache 三种模式

| 模式 | 代表 provider | 命中折扣 |
|---|---|---|
| **隐式** | OpenAI GPT-5、**DeepSeek V4**、GLM、MiniMax | 75-99% off |
| **显式标记** | Claude Sonnet/Haiku/Opus、Qwen explicit | 90% off |
| **显式创建** | Gemini 3、豆包 | 80% off + 存储费 |

我们跑 **DeepSeek V4 Flash**（99% off、隐式模式、零代码改动、TTL 数小时到数天）—— **命中的 tokens 几乎不花钱**。

### UsageTracker：四类 token 分开算

```ts
interface StepUsage {
  inputTokens: number;       // 真正 cache miss（miss 价）
  outputTokens: number;      // 生成（output 价）
  cacheReadTokens: number;   // 命中（read 价，10-25% off）
  cacheWriteTokens: number;  // 首次写入（Anthropic 特有，比 input 贵 25%）
}
```

**Provider 特化**：OpenAI 的 `inputTokens` 包含 cached 部分——必须减去避免重复算钱。**"用别人的数据前必须知道它的规则"**。

### 两个快捷命令

**`/context`** —— 16×16 网格看**空间**分布：

```
● ● ◐ ◒ ◒ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    deepseek/deepseek-v4-flash
○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    2.6k/128.0k tokens (2.0%)
                                    ● System prompt    1.0k (0.79%)
                                    ◐ System tools      650 (0.51%)
                                    ◉ Messages           48 (0.04%)
                                    ○ Free space     119.0k (92.9%)
                                    ▢ Buffer           6.4k (5.0%)
```

**`/usage`** —— cache 效果看**成本**分布：

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

### 实测洞察：31% 命中率背后

**理想的 DeepSeek Agent 应该能到 70-85%**——我们实测 31% 说明架构有优化空间。四个破 cache 点：

1. **`sessionContext` segment 每轮变**（`sessionMessageCount` 每 +1、SYSTEM 就变）
2. **`deferredTools` 目录被 tool_search 命中后变短**
3. **ToolSearch 激活工具、`tools` 参数变化**
4. **Compaction/Summarization 修改 messages 前缀**

**"架构设计和 cache 命中率是耦合的"**——每个动态点都在扣命中率的分。**优化的性价比顺序**：`sessionContext` 稳定化（3 行代码）→ defer 目录不动态过滤 → 延迟 Summarization 触发。

### Cache 的回报模式：前期投入、后期省心

```
第 1 轮:  hit  0% —— cache 冷启动
第 2 轮:  hit 34% —— 开始被读
第 3 轮:  hit 49% —— 稳定升温
```

**单次调用不适合开显式 cache**（写入比不写还贵）、但 **Agent 动辄几十轮的多步对话是 cache 的最佳应用场景**。

## 快速开始

```bash
npm install
npm run dev      # 开发模式（tsx watch）
# 或
npm start        # 直接运行
```

- 默认使用 **mock 模型**（[`src/mock-model.ts`](src/mock-model.ts)），完整模拟工具调用、死循环、429、超预算、并发与编辑测试，无需任何配置即可体验三层防护和读写锁
- 想连真实模型：在 `.env` 里填 `DEEPSEEK_API_KEY` 即可——[`src/index.ts`](src/index.ts) 会根据环境变量自动切换（有 key 用真实模型，没有则退回 mock）。注意：真实模型会真的调用 `bash`、`fetch_url` 等工具，它拿到的权限就是它执行的权限

启动后有几个测试口令，分别打三道防护和工具系统（每个口令也支持对应英文，如 `test dead loop`）：

| 输入 | 触发 |
|---|---|
| `测试死循环` | 循环检测（短路保护） |
| `测试重试` | API 容错（过载保护） |
| `测试预算` | Token 预算（漏电保护） |
| `测试并发` | 读写锁：一步连发 5 个工具调用，观察共享锁并行、独占锁等待 |
| `测试编辑` / `测试编辑未找到` / `测试编辑多匹配` | edit_file 三分支（成功替换 / 未匹配 / 多匹配，操作 /tmp/edit-demo.txt） |

## 目录结构

```
src/
├── index.ts                 # 入口：readline REPL，持有 messages 与 budget，挂 MCP + 元工具 + Pipe
├── agent/
│   └── loop.ts              # Agent Loop：while 循环 + 步骤级重试 + 防护接入
├── loop-detection.ts        # 循环检测：指纹 + 滑动窗口 + 三个检测器
├── retry.ts                 # API 容错：错误分类 + 指数退避 + 抖动
├── mock-model.ts            # Mock 模型:模拟工具调用 / 死循环 / 429 / 超预算 / 并发 / 编辑
├── tools/
│   ├── tool-registry.ts     # 工具注册表：读写锁 + 结果截断 + MCP 挂载 + 延迟加载状态
│   ├── index.ts             # 12 个内置工具（天气/计算/文件/bash/grep/glob/搜索/抓网页/预览）
│   ├── tool-search.ts       # 元工具 tool_search：按名字激活延迟工具
│   └── simulated-mcp.ts     # 模拟 MCP 工具（Notion/Browser/Supabase，演示工具膨胀）
├── mcp/
│   ├── client.ts            # 手写 stdio MCP client（教学载体）
│   ├── sdk-client.ts        # 官方 SDK 版本（生产推荐）
│   └── mock-client.ts       # Mock 降级实现
├── session/
│   ├── store.ts             # JSONL append-only 存储 + load / stats
│   ├── tool-result-output.ts # AI SDK 5 判别联合的工具结果编解码
│   ├── token-count.ts       # 计数基础工具（compressor 和 defense 共用）
│   ├── compressor.ts        # 两层压缩：microcompact + summarize
│   ├── defense.ts           # 零 LLM 三层防线：TokenTracker + truncate + TTL
│   └── usage-tracker.ts     # Cache 可视化：四类 token 归一化 + 成本 breakdown
└── context/
    ├── prompt-builder.ts    # Prompt Pipe 核心：PipeFn + build + debug
    ├── segments.ts          # 4 个默认 segment
    └── view.ts              # 上下文 / usage 可视化（/context / /usage 快捷命令）

docs/
├── agent-loop-protections.md    # 三道防护的完整实现细节
├── tool-call-concurrency.md     # 工具调用并发控制详解
├── mcp-integration-practice.md  # MCP 集成实践（stdio / SDK / 三层降级）
├── tool-search-design.md        # ToolSearch 延迟加载（含 Prompt Cache 权衡）
├── session-persistence.md       # Session 持久化（JSONL、崩溃安全、恢复语义）
├── prompt-pipe-design.md        # Prompt Pipe（模块化 SYSTEM、顺序即 cache 策略）
├── context-compression.md      # 上下文压缩（Microcompact + Summarization 分层策略）
├── instant-defenses.md          # 零 LLM 防线（TokenTracker + TTL + Truncate 三层协同）
└── cost-visualization.md        # 成本可视化（Cache 三模式 + /context + /usage + 31% 命中率分析）
```

## 核心设计

- **Provider 模式**：无论后端是 mock 还是真实 API，`streamText({ model, ... })` 的调用方式完全一致，模型可插拔，核心业务逻辑与具体模型解耦
- **全量上下文传递**：对话上下文就是 `messages: ModelMessage[]`，每轮把整个数组传给模型，不做压缩、截断或缓存
- **防护旁路接入**：检测器、重试、预算都在 `agentLoop` 内部编排，模型对防护毫无感知
- **预算归属清晰**:`budget` 由调用方持有并跨轮累计，`agentLoop` 只读改写它——想换预算策略，不需要动循环本身
- **工具层并发控制**：读写锁由 `ToolRegistry` 持有，`agentLoop` 对锁毫无感知——循环管"要不要调"（三道防线），工具层管"怎么安全地调"（读写锁）
- **工具来源解耦**：`MCPClientLike` 结构接口把 MCP client 的实现（手写 / SDK / Mock）藏在 `ToolRegistry` 后面——`agentLoop.ts` 从头到尾看不到 "MCP" 这个词，加一种新来源不用改循环
- **工具可见性动态化**：`shouldDefer` + `discoveredTools` 让工具集从"静态注册"变成"按需暴露"——registry 决定当下哪些工具进 prompt，`agentLoop` 只消费 `toAISDKFormat()` 的输出，同样毫无感知
- **状态持久化用 append-only**：`SessionStore` 用 JSONL append，崩溃时最多丢正在写的那一行——比"覆写整个文件"的一致性窗口小几个数量级
- **SYSTEM 是 pipeline，不是字符串**：`PromptBuilder` 把 SYSTEM 拆成 segment，每个 segment 是纯函数、独立决定要不要出现——加新功能是加 `.pipe()`，不是拼字符串
- **上下文压缩分层，先便宜后贵**：Microcompact（零 LLM、无损结构）永远先于 Summarization（一次 LLM 调用、结构塌陷）——能不丢结构就不丢。压缩逻辑挂在 `agentLoop` 里，caller 无感、幂等可反复触发
- **Token 感知用"精确基准 + 粗估增量"**：`TokenTracker` 用 API 返回的 `usage.inputTokens` 作为精确基准、中间粗估补上——**偏差不累积**，每轮 API 校准都重置增量。既不用 tokenizer 依赖、又能保证长会话下估算准确
- **修剪的两条铁律**：**只修剪 tool 消息**（user/assistant 永不修剪，对话结构必须完整）+ **错误经验保留**（含 error/失败/denied 等关键词的 tool_result 永不修剪，避免模型重复走死路）
- **成本可见比省成本更重要**：`UsageTracker` 把四类 token（miss / write / read / output）分开算、`/context` 看空间、`/usage` 看成本。**看不到就没办法优化**——`saved = baseline - actual` 那一行数字比任何优化建议更能推动改进
- **架构设计和 cache 命中率是耦合的**：每个"每轮变化"的设计决策（`sessionContext` 递增、`deferredTools` 动态过滤、`tools` 参数被 ToolSearch 修改、Summarization 重写 messages）都在扣命中率的分。教学项目实测 31% —— 生产化时必须重新审视每个动态点
