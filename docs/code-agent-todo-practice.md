# Code Agent 实践：找出项目里所有 TODO

一次完整的 Code Agent 端到端实践——从"埋 TODO"到"跑通 Agent Loop"再到"切真实模型看差距"。目的不是产出一个 TODO 扫描器，而是**用一个具体场景把 Agent Loop、通用工具、三道防线、并发控制、Mock 与真实模型的差距**都跑一遍。

> 前置阅读：[agent-loop-protections.md](agent-loop-protections.md)（三道防线）· [tool-call-concurrency.md](tool-call-concurrency.md)（工具读写锁）

## 实践目标

用户输入一句"帮我找出项目里所有 TODO"，Agent 应该：

1. **自己规划**执行步骤——先探索、再定位、再补细节
2. **并发调用**只读工具，砍掉串行等待
3. **归纳总结**而不是复述——按类别/优先级分层
4. **在预算内完成**，超了就 break

## 场景步骤

### Step 0：准备靶场（sample-project/）

在 `sample-project/` 下埋 4 个虚构文件，故意混合五类注释关键词，覆盖真实项目里的常见问题：

| 文件 | 埋了什么 |
|---|---|
| `user-service.ts` | 明文密码、O(n) 扫描、后门账号（安全灾难）、时序攻击、CSV 未转义 |
| `payment.ts` | 支付网关未接、幂等性缺失、浮点金额、汇率写死 |
| `logger.ts` | 结构化日志缺失、全局单例、JSON.stringify 循环引用 |
| `config.ts` | 环境变量静默默认值、jwtSecret 泄露、缺少 schema 校验 |

关键词分布：`TODO / FIXME / HACK / XXX / NOTE` 各有若干，共 ~40 处。

**为什么要"故意埋灾难"**：靶场必须**分层**——只放 TODO 太单一，模型总结出来就是一份代办列表；混入 FIXME / HACK 才能让模型有"优先级判断"的空间；再埋一个"后门账号"这种明显的安全灾难，才能考验模型能不能**主动标红**。**靶场设计的丰富度决定了实践的上限**。

### Step 1：Mock 层加"意图识别"（脚本模拟）

在 [src/mock-model.ts](../src/mock-model.ts) 里加三个 detector，**按优先级串行判断**：

```
detectConcurrencyIntent   ← 首轮 + 关键词"测试并发"
  ↓ 未命中
detectTodoInitial         ← 首轮 + 用户问 TODO
  ↓ 未命中
detectTodoFollowup        ← 上一轮工具消息里有 grep 结果
  ↓ 未命中
detectToolIntent          ← 单工具兜底
  ↓ 未命中
pickTextResponse          ← 生成文本
```

每个 detector 从 `prompt`（消息历史）里判断当前该做什么：
- **detectTodoInitial**：首轮直接返回 `[list_directory, grep]` 两个工具意图（数组 → SDK 会并发）
- **detectTodoFollowup**：从上一轮工具消息里找 `toolName === 'grep'` 的输出，抽出唯一文件名，返回 N 个 `read_file` 意图
- **pickTextResponse** 里加 TODO 归类分支：多个 `read_file` 结果拼起来，按关键词 buckets 计数、生成总结

### Step 2：验证 Mock 场景

```bash
npm run dev
# 输入: 帮我找出项目里所有TODO
```

预期输出（分 3 步）：

```
Step 1 (并发 ×2)：
  [调用: list_directory] + [调用: grep]
  [并发] list_directory 获取共享锁
  [并发] grep 获取共享锁

Step 2 (并发 ×N)：
  [调用: read_file × 4]
  [并发] read_file 获取共享锁 × 4

Step 3：文本归类总结 → hasToolCall=false → 退出循环
```

**观察点**：
- 首轮和第二轮都能看到多条 `[并发]` 标记 → 读写锁在工作
- 每份 `read_file` 结果被截断为 `... [省略 N 字符] ...` → maxResultChars 在工作
- Token 累计 500 → 1000 → 1500，远低于预算上限

### Step 3：切真实模型对比

配置 `.env`：

```
DEEPSEEK_API_KEY=sk-xxx
```

`index.ts` 里模型名确认可用（如 `deepseek-chat`）。重启 `npm run dev`，同样输入。

真实模型能观察到的差异：

| 观察点 | Mock | 真实模型（DeepSeek） |
|---|---|---|
| 意图识别 | 关键词 `text.includes('todo')` | 理解语义，任何说法都能懂 |
| 步骤规划 | 硬编码"探索→读文件→总结"三步 | 自己规划，可能更聪明（见下） |
| 归类质量 | 关键词计数 | 精确到行号 + 优先级建议 |
| 泛化能力 | 换个说法就懵 | 通用工具组合覆盖任意代码任务 |

**真实模型才会出现的行为**：
- 看到 `[省略 N 字符]` 主动切 `bash cat -n` 绕过工具截断
- 发现 cat 结果里还有省略，用 `sed -n '54,70p'` **精准补读缺失的行**
- 输出里主动区分"这是 sample-project 里的真实 TODO"和"src/mock-model.ts 里只是演示代码"

### Step 4：真实模型完整推理链路复盘

同一句"帮我查找项目中所有 TODO"，真实 DeepSeek 用了 5 步：

| Step | 动作 | 关键行为 |
|---|---|---|
| 1 | 并发 `list_directory` + `grep 'TODO\|FIXME\|HACK\|XXX'` | **规划层面**：一次性发多个工具，主动扩展了 grep 的 pattern |
| 2 | 并发 `read_file × 4` | **计划变更**：说"看起来这是 demo 项目，我把相关文件完整读一遍" |
| 3 | 发现 read_file 结果被截断 → 并发 `bash cat -n × 2` | **元认知**：识别到工具限制，主动换工具绕过 |
| 4 | 发现 cat 结果里 user-service.ts 中间还有省略 → `sed -n '54,70p'` | **精准补读**：算出缺哪几行、只补那部分 |
| 5 | 输出按文件汇总的完整表格 + 优先级建议（🔴🟡🟢） | **归纳** + **元认知诚实**：主动排除了 mock-model.ts 里的"假 TODO" |

**Step 3 的关键观察**：模型发了 2 个 `bash` 调用希望并发，但 bashTool 声明 `isConcurrencySafe: false`，Registry 强制串行——你会看到：

```
[串行] bash 获取独占锁，等待其他工具完成
[串行] bash 获取独占锁，等待其他工具完成
```

**这就是"模型意图"和"工具约束"的分工**：模型可以想并发，registry 必须兜底。bash 有副作用（可能改文件、可能调外部服务），串行是**正确决策**——不能让模型的判断错误导致数据竞争。

**Step 5 的关键观察**：模型输出里主动写了这句：

> `src/mock-model.ts` 里的"TODO"只是演示脚本的注释，不是真实待办

这是**语义级判断**——不是"grep 到了就报"，而是"读懂内容后判断这个 TODO 是不是真的 TODO"。Mock 完全模拟不了这层能力。

## 注意事项

### ⚠️ 1. Mock ≠ 智能，Mock 验证的是**架构接线**

Mock 里所有"决策"都是脚本硬编码：`detectTodoInitial` 命中关键词就返回工具意图，不是"理解意图后规划"。**这是特性不是缺陷**——Mock 的价值是让你不花钱、不联网就能验证：

- Agent Loop 的 while 循环工作正常
- 工具注册、读写锁放行、结果截断的机制都对
- 三道防线在预期时机触发

架构接线跑通后再切真实模型，问题范围就缩到"模型智能度"和"预算规划"两类。

### ⚠️ 2. 三个 detector 的优先级不能乱

```ts
const multi = detectConcurrencyIntent(prompt) 
           || detectTodoInitial(prompt) 
           || detectTodoFollowup(prompt);
```

`||` 短路顺序即触发优先级。`detectTodoFollowup` 里必须有**幂等保护**：

```ts
if (allParts.some((p: any) => p.toolName === 'read_file')) return null;
```

否则每一轮都会检测到 grep 结果、又发一次 read_file，陷入无限循环——**真实模型不会犯这错，Mock 会**。

### ⚠️ 3. 并发是三层配合的结果，不是模型的功劳

看到 `[并发] × 4` 别以为是模型聪明——它需要：

1. **模型层**一次性返回多个 tool-call（不是拆成多次对话）
2. **AI SDK 层**看到多 tool-call 用 `Promise.all` 并发调 execute
3. **Registry 层**工具声明 `isConcurrencySafe: true`

任何一层不配合就退化为串行。反例：Step 3 真实模型发了 2 个 `bash` 调用，registry 强制串行，`[串行] bash 获取独占锁，等待其他工具完成` × 2。**bash 是有副作用的，串行是正确决策**。

### ⚠️ 4. 工具截断是双刃剑

`read_file.maxResultChars = 500` 是演示值，生产环境通常 50000+。**截太狠的代价**：

- Step 3 真实模型看到省略后切 bash → 一步烧 4000 tokens
- Step 4 又发 sed 补漏 → 又 6000 tokens
- 最终 Step 5 输出完就 22881/15000 (153%) 撞停

如果 `read_file` 支持 `offset + limit`，Step 3/4 能合并成一步，省一半 token。**工具的输出边界比工具本身更影响用户体验**。

### ⚠️ 5. Token 预算是"跨轮累积"的

[src/index.ts](../src/index.ts) 里：

```ts
const budget: BudgetState = { used: 0, limit: 15000 };
```

`budget` 在 while 循环**外面**，跨对话累积——用户"分多次问"不会绕过预算。撞停后再问一句会立刻超预算再 break。**演示时 limit 建议 100000+**，别让预算刚好卡在"完整输出后就没法追问"的位置。

### ⚠️ 6. `.env` 不生效的坑

- `dotenv/config` 读的是**当前工作目录**的 `.env`——从项目根启动才对
- `tsx watch` 只重跑代码，**不重读环境变量**——改完 `.env` 要手动重启
- `deepseek-v4-flash` 这类模型名不确定的话，先查 DeepSeek 官方文档，跑起来 404 是常见坑

### ⚠️ 7. `MAX_STEPS` 和 `budget.limit` 是两条不同的防线

看代码 [src/agent/loop.ts:6](../src/agent/loop.ts#L6) 和 [src/index.ts](../src/index.ts) 分别配置：

|防线| 防什么 | 撞了说明 |
|---|---|---|
| `MAX_STEPS` | 模型钻牛角尖无限调工具（逻辑失控）| 规划失控，该 break |
| `budget.limit` | Token 消耗超预期（成本失控）| 单次对话太贵，该 break |

**两条都要留**，不要因为撞了其中一条就无限调大。真实场景下：
- MAX_STEPS：演示 30 / 中等 50 / 生产 100+
- budget.limit：演示 60000 / 中等 200000 / 生产 500000+

调到多少取决于场景。这个 TODO 场景 Mock 3 步 1500 token 够，真实模型 5 步 22881 token（撞穿 15000）——**真实模型 token 消耗大约是 mock 的 5-10 倍**。

### ⚠️ 8. Mock 与真实模型的"意图识别"完全不同

Mock 里 `wasAskingTodo()` 靠 `text.includes('todo') && text.includes('找')`——用户换个说法（"帮我列一下所有待办事项"）立刻失效。

真实模型不需要这些规则——它理解**语义**。所以 Mock 层写死的 `detectTodoInitial` / `detectTodoFollowup` 在真实模型下**完全无效**（真实模型不走 mock，走 provider）。

**这意味着 Mock 里的所有 detector 都是"演示脚手架"**：验证接线用完就该拆掉。生产项目里不应该有 detector 这层逻辑。

## 关键代码路径

| 关注点 | 文件 |
|---|---|
| REPL 入口、budget 声明 | [src/index.ts](../src/index.ts) |
| Agent Loop while 循环 | [src/agent/loop.ts](../src/agent/loop.ts) |
| Mock 层意图路由 | [src/mock-model.ts](../src/mock-model.ts) |
| 读写锁、结果截断 | [src/tools/tool-registry.ts](../src/tools/tool-registry.ts) |
| 通用工具实现 | [src/tools/index.ts](../src/tools/index.ts) |
| 靶场代码 | [sample-project/](../sample-project/) |

## 收获清单

- Agent Loop 的 while 循环是"取指→执行→写回→判退出"，跟 CPU 主循环同构
- 通用工具（list_directory + grep + read_file + bash）组合能覆盖任意代码探索任务，专用工具反而是反模式
- 并发是模型、SDK、Registry 三层配合的结果，Registry 是最后一道防线
- Mock 验证接线、真实模型验证智能，两者服务不同目的
- 三道防线里 Token 预算最常触发——真实模型的 token 消耗比 mock 高 5-10 倍
- 工具的输出边界（`maxResultChars`）比工具本身更影响 token 效率
- 真实模型的**元认知能力**是最大惊喜：看到工具限制会主动换工具、看到 mock 数据会主动质疑、看到重复调用会主动换策略
- **靶场设计的丰富度决定实践的上限**——只有 TODO 得不到优先级判断，混合 FIXME/HACK 才能考验模型语义能力

## 下一步实践

- **Research Agent** ✅：一句话让 Agent 抓取 URL、并发多抓、综合摘要 —— 已完成，见 [research-agent-practice.md](research-agent-practice.md)
- **Vibe Coding** ✅：一句话让 Agent 生成能在浏览器直接跑的多文件 React 应用 —— 已完成，见 [vibe-coding-practice.md](vibe-coding-practice.md)
- **Deep Research Agent**（延伸）：从"给 URL"演化到"只给主题词" —— 设计方案见 [deep-research-design.md](deep-research-design.md)
