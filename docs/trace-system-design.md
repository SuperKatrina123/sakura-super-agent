# Trace 系统：复盘一次执行为什么得到这个结果

> 配套 [../README.md](../README.md) 的拓展阅读。前面装的所有能力让 Agent 越来越强、但**能力越强、出错时越难查**——**它当时是在什么信息条件下做的决定？**这一篇讲本地 JSONL Trace 的最小方案：为什么普通日志不够、"输入上下文快照"是核心价值、跟 Session 的边界、以及 REPL + CLI 双入口如何复用同一份摘要逻辑。

## 目录

- [0. 为什么普通日志不够](#0-为什么普通日志不够)
- [1. Trace ≠ Session：两个完全不同的东西](#1-trace--session两个完全不同的东西)
- [2. 最容易漏的字段：Step 开始前的上下文快照](#2-最容易漏的字段step-开始前的上下文快照)
- [3. 事件类型：两类 step event + 边界事件](#3-事件类型两类-step-event--边界事件)
- [4. Recorder 设计的四个细节](#4-recorder-设计的四个细节)
- [5. 接线：agentLoop 里两处 emit](#5-接线agentloop-里两处-emit)
- [6. 双入口：REPL /trace + CLI inspect](#6-双入口repl-trace--cli-inspect)
- [7. 已知的坑与后续方向](#7-已知的坑与后续方向)

## 0. 为什么普通日志不够

前面很多层都在打 log——防线打 log、Cache 命中率打 log、每个 tool call 都能打 log。**但 log 解决不了这个问题**：

> Step 4 的回答错了、真正的原因是什么？

**log 通常记的是"发生了什么"**：
- `[Cache] hit 43% · $0.0021`
- `[Token] 24539/600000 · tracker ~7971`
- `[bash-security] ⚠️  moderate 放行: rm ...`

**看得到结果、看不到"当时它是怎么想的"**——Step 4 拿到的输入 messages 里可能：
- 早期工具结果已经被 [微压缩](context-compression.md) 掉了
- 一条错误信息被当成可靠事实带下来了
- [TTL 修剪](instant-defenses.md) 悄悄清理了关键消息
- Summarize 把两轮对话压缩成一句话丢了细节

**没有 Step 前的输入快照、你只能看到"结果错了"、却看不到"它是在什么信息条件下做的决定"**——**这就是 log 解决不了的问题**。

**Trace 是为"复盘"设计的**——不是"发生了什么"、是"当时它看到了什么"。

## 1. Trace ≠ Session：两个完全不同的东西

两者都存到 `.jsonl` 文件里、但**服务对象和内容完全不同**：

| 对比 | Session | Trace |
|---|---|---|
| **服务对象** | 用户继续对话 | 开发者排查复盘 |
| **核心内容** | user / assistant / tool 消息 | 每个 Step 的**完整输入 + 输出 + 耗时 + usage + 错误** |
| **组织方式** | 一个会话持续追加 | 一次 Agent 任务一个文件 |
| **生命周期** | 可以长期存在 | 通常按天数清理或归档 |
| **触发** | 每次 `--continue` 加载 | 只在 debug 时被读 |

**别混淆**——**Session 是"对话本体"、Trace 是"对话背后的机制快照"**。

- Session 里有 messages、看到的是"用户说了什么、Agent 答了什么"
- Trace 里有 messages + SYSTEM + usage + duration + attempt failures、看到的是"Agent 每一步收到什么、想了多久、烧了多少钱、失败重试了几次"

**教学场景里一个直观区分**：**你切到用户视角看的是 Session、切到开发者视角看的是 Trace**。

## 2. 最容易漏的字段：Step 开始前的上下文快照

**大多数 Trace 系统的第一版都会漏这个字段**——只记 Agent 输出、不记 Agent 输入。

**为什么会漏**：直觉上"输入不是我传的吗、干嘛记"——**但输入在 loop 里会变**：

```ts
// 简化的 agentLoop 内部
while (step < MAX_STEPS) {
  step++;
  
  applyDefense(messages);       // ← TTL 修剪、截断——messages 变了
  microcompact(messages);       // ← 工具结果压缩——messages 又变了
  await summarize(messages);    // ← 摘要——messages 再变
  
  streamText({ messages, ... });   // ← 传给模型的、跟你 push 进去的不一样了
}
```

**Step 4 看到的 messages ≠ Step 1 看到的 messages**——中间被无数次"隐性修改"。**Trace 必须记 Step 前的最终版本**、也就是**真正给模型的那个 messages**。

**Recorder 里的核心事件**：

```ts
// step_started —— 模型调用前的最终快照
{
  type: 'step_started',
  step: 1,
  context: {
    system: '...',          // 完整 SYSTEM（可能带 cache-off nonce 等）
    messages: [...]         // 完整 messages（防线 / 压缩之后的最终版）
  }
}

// step_completed —— 模型调用后
{
  type: 'step_completed',
  step: 1,
  durationMs: 1523,
  output: {
    text: '...',            // assistant 文本输出
    messages: [...]         // 本 step 新增的消息（tool call + tool result 都在里面）
  },
  usage: { ... }            // 四类 token 归一化
}
```

**两条事件配对**——**输入 + 输出**、才能复盘"Step X 在收到 Y 后返回了 Z"。**只有一半都不够**。

## 3. 事件类型：两类 step event + 边界事件

最终事件集只有 **5 种**——刻意保持最小：

```ts
type TraceEvent =
  | { type: 'trace_started'; traceId; sessionId; model; timestamp }
  | { type: 'step_started'; step; context: { system, messages } }
  | { type: 'step_attempt_failed'; step; attempt; error }
  | { type: 'step_completed'; step; durationMs; output; usage }
  | { type: 'trace_finished'; status; durationMs; error? };
```

**几个刻意的取舍**：

**① 不记 tool call / tool result 单独事件**

**因为它们已经在 step_completed 的 `output.messages` 里**——`stepResponse.messages` 包含了本 step 的完整 tool 交互序列。**再单独记一遍是冗余**、还增加了两个 event type 的维护负担。

**② step_attempt_failed 单独一类**

对齐 loop 里的重试机制——**每次 attempt 失败都记**、但 step_started 只在 attempt=1 记一次（避免重试污染 trace 形状）。查 trace 时能看到"这个 step 试了几次、哪几次抛错、错误是啥"。

**③ trace_started / trace_finished 是"任务边界"**

一个 trace 文件对应一次 agentLoop 调用——**start 是入口、finish 是出口**。finish 带 status（`completed` / `failed` / `cancelled`）——**看 trace 尾部就知道结果**、不用扫全文件。

## 4. Recorder 设计的四个细节

`src/trace/recorder.ts` 里几个刻意的选择：

### 4.1 敏感字段自动 REDACT

```ts
const SECRET_KEY = /api[-_]?key|token|secret|password|authorization/i;

function sanitize(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [k, sanitize(v, k)]),
    );
  }
  return value;
}
```

**递归 + 大小写不敏感**——tool 参数里带 `apiKey` / `authorization` / `secret` 的字段自动脱敏。**trace 文件不能变成 credential leak 通道**——一旦被 share 或提交、后果很严重。

### 4.2 写盘失败降级：writeFailed flag

```ts
private writeFailed = false;

private async write(event: Record<string, unknown>): Promise<void> {
  if (this.writeFailed) return;
  try {
    await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf8');
  } catch (error) {
    this.writeFailed = true;
    console.warn(`  [Trace] 写入失败，已停止记录: ${errorMessage(error)}`);
  }
}
```

**第一次写失败之后就静默降级**——**避免一个坏磁盘把 REPL 淹在错误日志里**。**打一次 warning 就够了**、后续继续跑但不再尝试写。**Trace 是辅助设施、不应该拖累主流程**。

### 4.3 append JSONL 而不是 write full JSON

**跟 Session / Cron 日志一致**——**append-only 三大好处**：

- **崩溃安全**：进程中间挂了、已经 append 的行完好无损
- **流式处理友好**：readline 逐行读、`jq -c` / `grep` 都能用
- **零并发冲突**：不用锁、每行独立

一个 trace 文件通常几十 KB 到几 MB——**append 开销可忽略**、比全量 rewrite 快得多。

### 4.4 时间戳内 stepStartedAt Map

```ts
private readonly stepStartedAt = new Map<number, number>();

async recordStepStarted(input: StepStartedInput): Promise<void> {
  this.stepStartedAt.set(input.step, Date.now());
  // ...
}

async recordStepCompleted(input: StepCompletedInput): Promise<void> {
  const startedAt = this.stepStartedAt.get(input.step) ?? Date.now();
  await this.write({
    // ...
    durationMs: Date.now() - startedAt,
  });
}
```

**start 记时间、complete 时算差值**——**内部维护一个小 Map**、外部拿到的 `durationMs` 是真实值。**别指望 emitter 传时间**、内部记账更可靠。

## 5. 接线:agentLoop 里两处 emit

Recorder 建好、接进 agentLoop 只有两处：

```ts
// src/agent/loop.ts (简化)
export async function agentLoop(
  model, registry, messages, system, budget,
  opts?: {
    // ...
    trace?: LocalTraceRecorder;   // 可选、不传就零开销
  },
) {
  const trace = opts?.trace;
  
  while (step < MAX_STEPS) {
    step++;
    // ... 防线、压缩、摘要 ...
    
    for (let attempt = 1; ; attempt++) {
      try {
        const effectiveSystem = /* cache-off nonce or system */;
        
        // ★ step_started —— 只在 attempt=1 emit
        //   effectiveSystem 是"真给模型的" SYSTEM（可能有 nonce 前缀）
        //   messages 是"防线 / 压缩之后"的最终版
        if (trace && attempt === 1) {
          await trace.recordStepStarted({ step, system: effectiveSystem, messages });
        }
        
        const result = streamText({ ... });
        // ... 消费 stream ...
        break;
      } catch (error) {
        // ★ step_attempt_failed —— 每次 attempt 失败都记
        if (trace) await trace.recordAttemptError(step, attempt, error);
        if (attempt > MAX_RETRIES || !isRetryable(error)) throw error;
        // 退避重试
      }
    }
    
    // ... token 计费 / cache 可视化 / budget ...
    
    // ★ step_completed —— 拿到 normalized usage 之后
    if (trace) {
      await trace.recordStepCompleted({
        step, text: fullText, outputMessages: stepResponse.messages,
        usage: normalizedUsage,
      });
    }
  }
}
```

**接线的三个哲学**：

**① 可选 opt-in**——`trace` 是 `opts?.trace`、**不传就零开销**、跟已有 opts 风格一致（tracker / usageTracker / modelInfo 都是这个模式）。

**② step_started 只在 attempt=1 emit**——重试不重复记 step_started、避免 trace 形状变形。**step 边界跟 step_started 一一对应**、清晰。

**③ Recorder 层的 fire-and-await**——每次 emit 都 `await`——**保证顺序 + 保证不丢**。教学场景写盘开销可忽略、生产可以考虑 fire-and-forget、但那也是"tracer 内部维护 queue"、不是 caller 的事。

**入口处的接线**（REPL / cron / 未来的 channel / subagent）：

```ts
// src/main.ts (REPL ask 循环)
const tracer = config.trace.enabled
  ? await LocalTraceRecorder.start({
      directory: config.trace.dir,
      sessionId: config.session.id,
      model: modelInfo.modelName,
    })
  : null;

try {
  await agentLoop(model, registry, messages, dynamicSystem, budget, {
    usageTracker, modelInfo, cacheDisabled: cacheState.disabled,
    trace: tracer ?? undefined,
  });
  await tracer?.finish('completed');
  if (tracer) console.log(`  [Trace] ${tracer.filePath}`);
} catch (error) {
  await tracer?.finish('failed', error);
  console.error(`  [Agent] ${error instanceof Error ? error.message : String(error)}`);
  if (tracer) console.log(`  [Trace] ${tracer.filePath}`);
  ask();
  return;
}
```

**几个要点**：

- **一次 agentLoop = 一个 tracer** —— REPL 每次输入、cron 每次 fire、都独立
- **失败不 throw** —— **catch 里 finish('failed', error)、log 错误、log trace 路径、ask() 继续**——**Trace 记好、REPL 不挂**
- **打印 trace 文件路径** —— 用户能立刻 `cat` 或 `pnpm trace:inspect` 查看

**当前只接了 REPL + Cron**——channel / subagent 的接口需要额外改造、留 TODO。

## 6. 双入口:REPL /trace + CLI inspect

同一份摘要逻辑、两个入口共用——`inspectTrace()` 纯函数在 recorder.ts 里：

```ts
// src/trace/recorder.ts
export async function inspectTrace(filePath: string): Promise<string> {
  const raw = await readFile(filePath, 'utf-8');
  const events = raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  // ... 逐个 event 生成一行摘要 ...
}
```

**两个入口调它**：

**① REPL 里 `/trace` 命令族**：
```
/trace              列出最近 10 个 trace
/trace list [N]     列出最近 N 个
/trace show <id>    完整时间线摘要 ← 调 inspectTrace
/trace path <id>    只打关键路径（跳过 messages 细节）
```

**② CLI 独立入口**：
```bash
pnpm trace:inspect .traces/default-2026-08-31T08-52-07-548Z.jsonl
```

**输出一模一样**：

```
[trace .traces/default-xxx.jsonl] 5 个事件
  14:23:01 [start] default · deepseek-v4-flash
  14:23:01 [step 1 开始] SYSTEM 15234 字符 · messages 1 条
  14:23:03 [step 1 完成] 1523ms · +2 消息 · "帮我查..."
  14:23:03 [end] completed · 1523ms
```

**"给人看的摘要"是必要的**——**原文可以直接 cat**、但每行都是 JSON、几百字节的 messages 数组塞进一行、肉眼没法读。**摘要提供"骨架视角"**、想看细节再去看原文。

**双入口的价值**：
- **REPL 入口**——正在调试的时候顺手看
- **CLI 入口**——不用启动 Agent 就能查、跟其他脚本组合方便（`ls .traces/*.jsonl | xargs -n1 pnpm trace:inspect`）

**共用同一份逻辑**——**不会漂移**。抽出来的成本极低、收益是"两个入口永远一致"。

## 7. 已知的坑与后续方向

### 7.1 只覆盖了 REPL 和 Cron

**Channel / SubAgent 没接**——它们内部封装了 agentLoop 调用、要传 tracer 得改 Gateway / spawnAgent 的接口。留了 TODO。

改起来其实简单——给 Gateway / SpawnContext 加 `createTracer?: () => Promise<LocalTraceRecorder>` 字段、每次 handleIncoming / spawnAgent 时调一次拿新 tracer 传给 agentLoop。

### 7.2 messages 快照没深拷贝

```ts
context: sanitize({ system: input.system, messages: input.messages }),
```

**`sanitize` 在序列化前遍历一次、但没主动 structuredClone**——**依赖 `JSON.stringify` 天然的深拷贝**。绝大多数场景够用、但如果 messages 里有 Date / Map / Set / typed array 会丢或转字符串。

**修法**：在 `recordStepStarted` 里 `structuredClone(input.messages)`——绝对安全。**教学项目当前留着**、messages 都是 plain object、没踩坑。

### 7.3 attempt failed 记的是 error.message、丢了 stack

```ts
async recordAttemptError(step, attempt, error): Promise<void> {
  await this.write({ /* ... */ error: errorMessage(error) });
}
```

**只存字符串 message**——**stack trace 丢了**。生产要排查 tricky 的重试失败、可能想看 stack。

**修法**：加个 `stack: err.stack` 字段——**教学项目当前不做**、错误信息够用。

### 7.4 没有自动清理

`.traces/` 会**无限增长**——一天 20 个任务、一年 7000 多个文件、上百 MB。

生产要加：
- **retention 策略**（保留 7 天、超过删）—— config 里加 `trace.retentionDays`
- **按大小 rotation**（`.traces/` 超 100MB 就清最老的）
- **归档**（30 天前的打包压缩转到 `.traces/archive/`）

**当前留给用户手动 `rm -rf .traces/`**——教学项目节流上限暂缓。

### 7.5 单个 trace 文件可能很大

step_started 里存了**完整 messages**——RAG 场景一个大 tool result 就几 KB、几个 step 累积几十 KB。一次长任务 trace 文件可能几 MB。

**如果打开慢**、有几种改法：
- **对超大字段做 truncation + 存单独文件**（`messages: '@ref:msg-xxx.json'`）——引用式
- **压缩存储**（`.jsonl.gz`）——读的时候解压
- **只存 diff**（step_started 只记跟上一 step 的差异）——存储 -90%、但读取复杂度上升

**当前完整存**——**能重现是核心价值、不能为了省空间牺牲**。

### 7.6 没有 Trace 之间的 correlation

**SubAgent 的 trace 现在是独立文件**——**看不到"父任务是谁"**。

**修法**：trace_started 加 `parentTraceId?: string` 字段——SubAgent spawn 时传父 tracer 的 id 进来。**查询时能重建树**、`inspectTrace` 也能显示"这是 default-xxx 的子任务"。

### 7.7 REPL /trace 命令族还不够强

现在只有 list / show / path。**排障时想要的还有**：
- `/trace grep <keyword>` —— 全文搜哪些 trace 提到过某个词
- `/trace diff <id1> <id2>` —— 两次 trace 逐 step 对比
- `/trace export <id>` —— 导出成 HTML 报告

**这些都是"分析型"操作**——不接 UI 层做起来有限、生产要么接第三方（Langfuse / Helicone）要么自己造 dashboard。**这一节的定位是"本地最小"**、够 debug 就行。

### 7.8 敏感字段规则可能漏

`SECRET_KEY = /api[-_]?key|token|secret|password|authorization/i` 只覆盖 4 种模式——**如果 tool 参数里叫 `credentials` / `bearer` / `x-auth`** 就漏了。

**修法**：让 `SECRET_KEY` 可配置——config schema 里加 `trace.sanitizeKeys?: string[]` 允许用户扩展。当前教学项目留着、够用。

---

## 回顾:Trace 的核心价值是"能重现"

**这一篇的核心洞察**：

普通日志答的问题是**"发生了什么"**——好用、但答不了"为什么发生"。

**Trace 答的问题是"当时的信息条件下、Agent 为什么做这个决定"**——**核心是快照 Agent 每 step 的完整输入上下文**：
- 完整 SYSTEM（含各种压缩 / TTL / 摘要之后的最终版）
- 完整 messages（同上）
- + 完整输出 + usage + 耗时 + 重试失败历史

**能不能重现是"排障工具好不好用"的分水岭**——只有 Trace 记的信息足够、你才能在跟用户复盘时说"哦、当时 Step 4 拿到的 messages 里第 12 条被 microcompact 清了、所以它忘了之前的对话"、而不是"啊呀不知道为啥啊我再看看"。

**几个可迁移的原则**：

1. **Trace ≠ Log** —— 服务对象不同（开发者复盘 vs 运行时观察）、组织方式不同（一任务一文件 vs 全局流）
2. **最容易漏的字段是"输入快照"** —— 只记输出等于没记
3. **敏感字段自动 REDACT** —— Trace 文件不能变成 credential leak 通道
4. **写盘失败静默降级** —— 辅助设施不该拖累主流程
5. **纯函数摘要 + 多入口共用** —— REPL 命令和 CLI 工具共享一份 inspectTrace

**这些原则跟"是不是 Agent"无关**——**任何"决策 based on 隐式状态"的系统都需要 Trace**：workflow 引擎、微服务链路、reactive UI、编译器 optimization pass——**都会遇到"结果错了、但错在哪一步的输入上"这个问题**。

Trace 是给未来的自己留的求救信号——**做的时候麻烦一点、出事的时候救命一次就够本了**。
