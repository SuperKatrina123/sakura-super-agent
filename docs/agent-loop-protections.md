# Agent Loop 三道防护详解

> 配套 [../README.md](../README.md) 的拓展阅读。README 里讲的是"三道防线各管什么"，这篇展开讲**每道防线是怎么实现的、为什么这么设计、在哪里接线**。

## 目录

- [0. 总览：一个 step 里的完整流水线](#0-总览一个-step-里的完整流水线)
- [1. 循环检测（短路保护）](#1-循环检测短路保护)
- [2. API 容错（过载保护）](#2-api-容错过载保护)
- [3. Token 预算（漏电保护）](#3-token-预算漏电保护)
- [4. 三道防线怎么协同](#4-三道防线怎么协同)
- [5. 用 mock 模型验证](#5-用-mock-模型验证)

## 0. 总览：一个 step 里的完整流水线

`agentLoop` 的每一轮循环（step）里，防线出现在 5 个位置：

```
┌────────────────────────────────────────────────────────────────┐
│ Step 开始                                                         │
│   for attempt = 1..3  ─────────────────┐  步骤级重试（⑤ API 容错）│
│   ├─ streamText(...)                   │                          │
│   ├─ 消费 fullStream 事件：             │                          │
│   │   tool-call   → ① detect() 判定 + ② recordCall() 取证        │
│   │   tool-result → ③ recordResult()（回填结果指纹）              │
│   │   text-delta  → 累积回复文本                                 │
│   ├─ stepResponse / stepUsage          │                          │
│   ├─ 失败？→ isRetryable？→ 退避后重试 ─┘                          │
│   └─ 成功 → break                                                 │
│ ④ budget.used += input + output，超限 → 强制停止                   │
│ 无工具调用？→ 回复完成，退出循环                                   │
│ 否则 → 进入下一步（≤ MAX_STEPS = 15）                             │
└────────────────────────────────────────────────────────────────┘
```

| 编号 | 防线 | 位置 | 触发条件 |
|---|---|---|---|
| ① | 循环检测（判定） | 每次 `tool-call` 事件 | `detect()` 返回 stuck |
| ② | 循环检测（取证） | 每次 `tool-call` 事件 | 记录本次调用指纹 |
| ③ | 循环检测（取证） | 每次 `tool-result` 事件 | 给对应调用回填结果指纹 |
| ④ | Token 预算 | 每步 stream 消费完之后 | `budget.used > budget.limit` |
| ⑤ | API 容错 | 整个 stream 消费过程 | 抛错且 `isRetryable` |

## 1. 循环检测（短路保护）

### 防的是什么

模型陷入"原地打转"：反复调用同一工具、同样参数，结果也一样，没有任何进展，但 token 一直在烧。这种状态模型自己意识不到，必须由外部检测并打断。

### 核心机制：指纹 + 滑动窗口

核心只有两件事：**给每次调用算一个指纹**，再在**滑动窗口**里找重复模式。

#### 1.1 指纹：怎么判断"两次调用是同一件事"

直接比较参数对象不可靠——JSON key 顺序、嵌套结构都会影响比较。所以先做**稳定序列化**，再哈希：

```ts
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();           // key 排序 → {b:2,a:1} 和 {a:1,b:2} 是同一件事
  return `{${keys.map(k => `${JSON.stringify(k)}: ${stableStringify(value[k])}`).join(',')}}`;
}
```

关键点：

- **对象 key 排序**：`{a:1,b:2}` 和 `{b:2,a:1}` 序列化结果一致 → 指纹相同
- **数组保序**：`[1,2]` ≠ `[2,1]`
- 指纹 = `工具名 : SHA-256(稳定序列化参数)[:16]`（截前 16 位十六进制，够用且省空间）

#### 1.2 滑动窗口：怎么维护"最近发生的事"

```ts
const history: ToolCallRecord[] = [];
export function recordCall(toolName, params) {
  history.push({ toolName, argsHash: hashToolCall(toolName, params), timestamp: Date.now() });
  if (history.length > HISTORY_SIZE) history.shift();   // 超过 30 条，丢最老的
}
```

- 窗口大小 `HISTORY_SIZE = 30`，超了就把最老的 `shift` 掉
- 每条记录先只有 `argsHash`（调用时写入），`resultHash` 留空，等工具返回后再回填：

```ts
export function recordResult(toolName, params, result) {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  // 从最新往前找第一条"同工具、同参数、还没回填结果"的记录，补上结果指纹
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash && !history[i].resultHash) {
      history[i].resultHash = resultH;
      break;
    }
  }
}
```

有了"调用指纹 + 结果指纹"，就能区分两种病：

- **参数重复**：调用指纹相同（同一件事反复做）
- **无进展**：调用指纹 + 结果指纹都相同（做了，但结果一模一样）

#### 1.3 三个检测器

| 检测器 | 怎么计数 | 信号 |
|---|---|---|
| `generic_repeat` | `history.filter(同工具 && 同参数).length`，窗口内累计次数 | 同一件事反复做 |
| `ping_pong` | 找最近一次不同参数（`otherHash`），倒着数两者"交替"了几次 | 在两个操作间来回横跳 |
| `global_circuit_breaker` | 倒着数"同工具 + 同参数 + 结果逐次完全一致"的 streak | 不仅重复，且毫无进展 |

`detect()` 在每次 `tool-call` 时调用，按严重度**从高到低短路**：

```ts
export function detect(toolName, params): DetectionResult {
  const argsHash = hashToolCall(toolName, params);

  const noProgress = getNoProgressStreak(toolName, argsHash);
  if (noProgress >= BREAKER_THRESHOLD)      // 10 → 无进展 streak 最严重，优先判
    return critical('global_circuit_breaker');

  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) return critical('ping_pong');   // 8
  if (pingPong >= WARNING_THRESHOLD)  return warning('ping_pong');     // 5

  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;
  if (recentCount >= CRITICAL_THRESHOLD) return critical('generic_repeat'); // 8
  if (recentCount >= WARNING_THRESHOLD)  return warning('generic_repeat');  // 5

  return { stuck: false };
}
```

`getNoProgressStreak` 的"倒着数"很关键：从窗口末尾往前，只要结果指纹和最近一次完全一致就累计，一旦结果变了就 `break`。这样只惩罚"真没进展"，结果有变化就不算卡死。

#### 1.4 分级响应：警告 / 熔断

| 级别 | 阈值 | 动作 |
|---|---|---|
| warning | ≥5 | 往 `messages` 注入一条 user 消息（`[系统提醒] ...请换一个思路解决问题`），引导模型换路，循环继续 |
| critical | ≥8（breaker ≥10） | 置 `shouldBreak = true`，当前 step 结束后直接 `break` 整个循环 |

设计取舍：**warning 不打断**，只"喂话"给模型；**critical 才熔断**。因为有些重复是暂时的、能救回来的，一上来就打断反而误伤。

### 接线点：在 loop.ts 里的两个事件

```ts
case 'tool-call': {
  hasToolCall = true;
  lastToolCall = { name: part.toolName, input: part.input };
  const detection = detect(part.toolName, part.input);   // ① 判定
  if (detection.stuck) {
    if (detection.level === 'critical') {
      shouldBreak = true;                                // 熔断
    } else {
      messages.push({ role: 'user', content: `[系统提醒] ...请换一个思路解决问题` }); // 警告：喂话
    }
  }
  recordCall(part.toolName, part.input);                  // ② 取证
  break;
}
case 'tool-result':
  if (lastToolCall) recordResult(lastToolCall.name, lastToolCall.input, part.output); // ③ 回填结果
  break;
```

注意 `detect()` 在 `recordCall()` **之前**调用——这样"本次"还没进窗口，检测的是**此前的累计行为**，避免自证。

> 阈值（5 / 8 / 10）都是演示值，生产环境通常要调大（如 10 / 20 / 30），并建议做成可配置参数。

## 2. API 容错（过载保护）

### 防的是什么

模型/网关不稳定：限流（429）、超时（408）、服务端抖动（5xx）、网络断开（ECONNRESET…）。任一个直接抛错，整个对话就崩了。正确的做法是**区分错误类型**：该重试的重试，不该重试的（其他 4xx，说明请求本身有问题）赶紧失败。

### 核心机制：错误分类 + 指数退避

#### 2.1 isRetryable：哪些错误值得重试

| 类别 | 例子 | 重试？ | 直觉 |
|---|---|---|---|
| 限流 | 429 Too Many Requests | ✅ | 等等就好 |
| 超时 | 408 / ETIMEDOUT / timeout | ✅ | 网络瞬时抖动 |
| 服务端 | 5xx（含 529） | ✅ | 对方抽风，一般会恢复 |
| 连接断开 | ECONNRESET / EPIPE / fetch failed | ✅ | 重建连接即可 |
| 空输出 | `No output generated`（AI SDK 包装流式空响应） | ✅ | 流式传输中断，重试整步 |
| 请求问题 | 其他 4xx | ❌ | 重试一万次结果一样 |

#### 2.2 calculateDelay：指数退避 + 随机抖动

```ts
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);        // 500, 1000, 2000, 4000...
  const capped = Math.min(exponential, maxMs);                  // 上限 30s
  const jitterRange = capped * 0.25;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;  // ±25% 抖动
  return Math.max(0, Math.round(jittered));
}
```

为什么要抖动？如果所有客户端都按同一曲线退避，限流一恢复，大家会**同时**撞上来（惊群效应）。±25% 的随机偏移让重试时间点散开。

### 接线点：步骤级重试，包裹整个 stream 消费

最容易做错的地方：重试不能只包"发起请求"，得包**整个消费过程**——流式响应可能在读的过程中断：

```ts
for (let attempt = 1; ; attempt++) {
  try {
    const result = streamText({ model, system, tools, messages, maxRetries: 0, onError: () => {} });
    for await (const part of result.fullStream) { /* 消费事件 */ }
    stepResponse = await result.response;
    stepUsage = await result.usage;
    break;
  } catch (error) {
    if (attempt > MAX_RETRIES || !isRetryable(error)) throw error;  // 该放弃就放弃
    await sleep(calculateDelay(attempt));
    // 重置本轮状态，防止上一次的残留指纹/文本污染重试轮
    hasToolCall = false; fullText = ''; shouldBreak = false; lastToolCall = null;
  }
}
```

几个关键点：

- **SDK 级 `maxRetries: 0`**：把重试权完全收回到自己手里，避免 SDK 自带的指数重试和自研重试叠加
- **最多重试 3 次**（`MAX_RETRIES`），超过直接抛错放弃
- **失败即重置局部状态**：`hasToolCall / fullText / shouldBreak / lastToolCall` 都要清掉，否则上一次读到一半的文本、半截指纹会污染重试轮
- **重试和熔断不冲突**：重试处理的是"这步没跑完"；熔断处理的是"这步跑完了但没进展"

## 3. Token 预算（漏电保护）

### 防的是什么

一次 `agentLoop` 可以跑很多步，每次 `streamText` 都消耗 input + output token。没有预算意识，一个失控的 loop 或一段长会话会把预算烧穿。预算要防的是**累计失控**，而不是单次超标。

### 核心机制：budget 由调用方持有

```ts
// index.ts —— 调用方持有，跨轮持续累计
const budget: BudgetState = { used: 0, limit: 15000 };
await agentLoop(model, tools, messages, SYSTEM, budget);
```

设计意图：

- **`agentLoop` 不持有预算，只消费它**（`budget.used += ...`）。想换预算策略、换持久化方式，不需要动循环本身
- 一次 `agentLoop` 只是"处理一个用户输入"，但 `used` 从程序启动开始累计——**跨 step、跨用户轮次**是同一个计数器，这才防得住长会话

### 接线点：统计时机在每步 stream 消费完之后

```ts
// 兼容 inputTokens 是 number 或 {total} 两种形态
const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : (stepUsage?.inputTokens?.total ?? 0);
const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : (stepUsage?.outputTokens?.total ?? 0);
budget.used += inp + out;
const pct = Math.round((budget.used / budget.limit) * 100);
console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`);
if (budget.used > budget.limit) {
  console.log('\n[Token 预算耗尽，强制停止]');
  break;
}
```

- 统计时机选在"本步已完整消费"之后——**输入 + 输出都算**，比只算输出更接近真实开销
- 超限不是抛错，而是 `break`：体面地停止循环，把已经生成的回复保留下来

## 4. 三道防线怎么协同

三道防线各有各的触发条件，互不替代：

| 防线 | 防的失败 | 触发点 | 结果 |
|---|---|---|---|
| 循环检测 | 原地打转、无进展 | 工具调用事件 | 警告喂话 / 熔断停止 |
| API 容错 | 请求失败、断流 | stream 消费过程 | 退避重试 / 放弃 |
| Token 预算 | 累计消耗失控 | 每步结束 | 强制停止 |

两个容易混淆的边界：

- **重试 vs 熔断**：重试发生在"这步根本没跑完"；熔断发生在"这步跑完了，但模型在重复"。两者处理完全不同的失败。
- **预算 vs 熔断**：预算看"总量花了多少"（长期视角）；熔断看"最近在重复什么"（短期视角）。

另外还有一道兜底闸：`MAX_STEPS = 15`。三道防线都是"检测到异常才停"，步数上限是"**无论有无异常，最多跑 15 步**"，防止模型在一个良性但冗长的任务里无限继续。

## 5. 用 mock 模型验证

[`src/mock-model.ts`](../src/mock-model.ts) 内置了三个故障注入开关，分别触发三道防线：

| 输入口令 | mock 行为 | 触发防线 |
|---|---|---|
| `测试死循环` | 每次都返回 `get_weather(北京)` | 循环检测 |
| `测试重试` | 前两次抛 `429`，第三次成功 | API 容错 |
| `测试预算` | 每步上报 4500 token（正常 500） | Token 预算 |

mock 的价值：**不用真实 API 也能稳定复现故障**。真实环境里撞一次 429 和死循环靠运气，mock 让三道防线在开发期就能被反复检验。
