# sakura-super-agent

从零构建 Agent 的学习项目：把一个只会聊天的 ChatBot，一步步演化成能自主调用工具、多步推理的 **Agent Loop**，并给它装上三道"保险丝"。

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

- **预算由调用方持有**：`src/index.ts` 里的 `{ used: 0, limit: 15000 }` 跨轮持续累计，`agentLoop` 只负责消费它
- 每步把 `input + output` token 累加进 `budget.used`，实时打印 `used/limit (pct%)`
- 超过 `limit` → 打印提示并**强制停止**

**测试**：输入 `测试预算`，mock 模型每步上报 4500 token，几轮内就能看到预算耗尽被强制停止。

> 最后还有一道闸：`MAX_STEPS = 15`，无论模型怎么绕，最多跑 15 步。

## 快速开始

```bash
npm install
npm run dev      # 开发模式（tsx watch）
# 或
npm start        # 直接运行
```

- 默认使用 **mock 模型**（[`src/mock-model.ts`](src/mock-model.ts)），完整模拟工具调用、死循环、429、超预算，无需任何配置即可体验三层防护
- 想连真实模型：在 `.env` 里填 `DEEPSEEK_API_KEY` 即可——[`src/index.ts`](src/index.ts) 会根据环境变量自动切换（有 key 用真实模型，没有则退回 mock）

启动后有三个测试口令，分别打三道防护：

| 输入 | 触发 |
|---|---|
| `测试死循环` | 循环检测（短路保护） |
| `测试重试` | API 容错（过载保护） |
| `测试预算` | Token 预算（漏电保护） |

## 目录结构

```
src/
├── index.ts                 # 入口：readline REPL，持有 messages 与 budget
├── agent/
│   └── loop.ts              # Agent Loop：while 循环 + 步骤级重试 + 防护接入
├── loop-detection.ts        # 循环检测：指纹 + 滑动窗口 + 三个检测器
├── retry.ts                 # API 容错：错误分类 + 指数退避 + 抖动
├── mock-model.ts            # Mock 模型：模拟工具调用 / 死循环 / 429 / 超预算
└── tool/
    └── utility-tools.ts     # 内置工具：get_weather（假数据）+ calculator
```

## 核心设计

- **Provider 模式**：无论后端是 mock 还是真实 API，`streamText({ model, ... })` 的调用方式完全一致，模型可插拔，核心业务逻辑与具体模型解耦
- **全量上下文传递**：对话上下文就是 `messages: ModelMessage[]`，每轮把整个数组传给模型，不做压缩、截断或缓存
- **防护旁路接入**：检测器、重试、预算都在 `agentLoop` 内部编排，模型对防护毫无感知
- **预算归属清晰**：`budget` 由调用方持有并跨轮累计，`agentLoop` 只读改写它——想换预算策略，不需要动循环本身
