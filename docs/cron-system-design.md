# Cron 系统：让 Agent 从被动响应到主动执行

> 配套 [../README.md](../README.md) 的拓展阅读。前面几篇让 Agent **能被叫醒**——REPL / channel 都是"消息进来 → loop 触发"。这一篇让 Agent **能自己醒**——按时间表主动执行任务：为什么调度和执行必须分离、执行器为什么用接口注入、任务定义为什么 JSON 而日志为什么 JSONL、以及跟三层安全防线怎么协同。

## 目录

- [0. 为什么需要 Cron](#0-为什么需要-cron)
- [1. Cron ≠ Channel ≠ REPL：主动 vs 被动的正交维度](#1-cron--channel--repl主动-vs-被动的正交维度)
- [2. 四个架构关键决策](#2-四个架构关键决策)
- [3. 决策一：调度解析与执行分离](#3-决策一调度解析与执行分离)
- [4. 决策二：执行器接口注入](#4-决策二执行器接口注入)
- [5. 决策三：JSON + JSONL 的分工](#5-决策三json--jsonl-的分工)
- [6. 决策四：三层安全防护](#6-决策四三层安全防护)
- [7. 完整生命周期：从 fire 到 log](#7-完整生命周期从-fire-到-log)
- [8. 停机顺序：cron → channel → plugin → MCP](#8-停机顺序cron--channel--plugin--mcp)
- [9. 已知的坑与后续方向](#9-已知的坑与后续方向)

## 0. 为什么需要 Cron

前面几篇里 Agent 的**所有触发都是被动的**：

- **REPL**：你打字才触发
- **Channel**：飞书用户发消息才触发
- **Hook / Tool**：模型主动调才触发

**但真实需求里有一大类是主动的**：

- **定时提醒**：每天早上 9 点提醒当天日程
- **周期性检查**：每 5 分钟看看 CI 状态、有失败就通知
- **周期任务**：每周一 10 点整理上周的活动日志、生成周报
- **一次性延迟**：3 小时后 ping 我"记得关空调"

**核心区别**：**主动执行需要一个"时钟"**——Agent 不能靠"等消息进来"、要能"到点自己走"。

这就是 Cron 系统的价值——**给 Agent 装一个内嵌调度器**、让它从"消息响应引擎"升级成"能自主行动的助手"。

## 1. Cron ≠ Channel ≠ REPL：主动 vs 被动的正交维度

前面 [Channel 那节](channel-system-design.md#1-channel--tool--plugin三个扩展维度的区分) 我们引入了三个扩展维度——**能力 / 知识 / 通道**。Cron 是**第四个维度**——**触发时机**：

| 维度 | 抽象 | 触发方式 | 例子 |
|---|---|---|---|
| 能力 | Tool / Skill / Plugin | 被动被调用 | supabase 集成 |
| 知识 | Memory / RAG | 被动被查询 | 项目文档 |
| 通道 | Channel | **被动**接收消息 | REPL / 飞书 |
| **时机** | **Cron** | **主动**按时间触发 | 每 30 秒 / 每天 9 点 |

**四个维度正交**：给一个 cron 任务里可以用任意工具（能力）、可以查记忆（知识）、可以把结果发到任意 channel（通道）——**触发时机跟"发生什么"完全解耦**。

**跟 Channel 的对偶关系**：

```
Channel:  外部消息 → Gateway.handleIncoming → agentLoop → 回复
Cron:     内部定时 → Service.fire        → agentLoop → notify
```

两者都是"某个事件 → 走 agentLoop → 产出结果"、**唯一区别是事件来源**——外部推 vs 内部拉。这个对偶关系是理解 Cron 系统的最重要钥匙。

## 2. 四个架构关键决策

Cron 系统的架构可以拆成四个正交的决策：

| 决策 | 解决什么 | 落点 |
|---|---|---|
| **① 调度解析与执行分离** | 时间表达式复杂、执行逻辑复杂——耦合 = 灾难 | `parser.ts` vs `service.ts` |
| **② 执行器接口注入** | Service 不能直接依赖 agentLoop（循环依赖 + 难测试） | `CronExecutor` 接口 |
| **③ JSON + JSONL 双存储** | 定义要**原子更新**、日志要**只追加** | `jobs.json` vs `logs.jsonl` |
| **④ 三层安全防护** | 定时任务是无人值守的、错了没人拦 | 失败禁用 + source + 权限联动 |

**共同的洞察**：**Cron 是个高危系统**——你不看着它、它在半夜自己跑、错了没人知道。所以每个决策都在**为"无人值守"做防御**：分离降低故障传染面、接口注入让测试能覆盖、JSONL 让审计可追溯、安全防护让崩溃能自愈。

## 3. 决策一：调度解析与执行分离

**痛点**：如果调度和执行写在一起——

```ts
// 反面教材
class BadCronService {
  async run(jobConfig) {
    if (jobConfig.schedule.startsWith('every')) {
      // 解析 interval...
      setInterval(async () => {
        // 执行 agent loop...
      }, ms);
    } else if (/^\d{4}-/.test(jobConfig.schedule)) {
      // 解析 ISO 时间...
      setTimeout(async () => { /* ... */ }, delay);
    } else {
      // 解析 cron 表达式...
    }
  }
}
```

**问题**：
- **难测试**——测调度就得起真定时器
- **改一处动全身**——加个新调度语法（比如"weekdays at 9"）要动执行逻辑周围
- **难 debug**——"任务没跑"到底是解析错了还是执行错了？

**方案**——两层完全分开：

```ts
// src/cron/parser.ts —— 只干"翻译"这一件事
export interface ParsedSchedule {
  type: ScheduleType;
  intervalMs?: number;       // "every 30s" → 30000
  cronInstance?: Cron;       // "0 9 * * *" → croner 实例、算下次时间
  onceAt?: Date;             // "2026-05-11T09:00:00Z" → Date
}

export function parseSchedule(expr: string): ParsedSchedule { /* ... */ }
export function getNextCronTime(instance: Cron): Date { /* ... */ }
```

```ts
// src/cron/service.ts —— 只干"调度和执行"
class CronService {
  private scheduleJob(state: CronJobState) {
    const parsed = parseSchedule(state.config.schedule);
    // parser 已经把时间语义算清楚了——service 只 setTimeout
    const delay = computeDelay(parsed);
    state.timerId = setTimeout(() => this.fire(state), delay);
  }
}
```

**三种调度类型统一到一个 `ParsedSchedule`**：

- `interval` —— 固定间隔（`every 30s` / `every 5m` / `every 1h`）
- `cron` —— cron 五字段表达式（`0 9 * * *` = 每天 9 点、用 [croner](https://github.com/hexagon/croner) 计算下次时间）
- `once` —— 一次性延迟（`2026-05-11T09:00:00Z` ISO 时间戳）

**Service 拿到 `ParsedSchedule` 后不管你原本是什么语法**——都是 `setTimeout` 到目标毫秒。

**好处**：
- **加新语法只改 parser**——比如加"weekdays at 9"、service 完全不动
- **单元测试各测各的**——parser 用 `expect(parseSchedule('every 30s').intervalMs).toBe(30000)`、service 用 mock executor 测调度节奏
- **故障定位清晰**——parser 返回 `throw new Error` 就是解析错、setTimeout 没触发就是调度错

## 4. 决策二：执行器接口注入

**痛点**：Cron 系统需要触发 Agent Loop——**但 CronService 不能直接 import agentLoop**：

```ts
// 反面教材
import { agentLoop } from '../agent/loop.js';   // ← 循环依赖警报
class CronService {
  async fire(state) {
    await agentLoop(this.model, this.registry, [...], ...);
  }
}
```

**问题**：
- **循环依赖**：Agent 会想调 cron 相关工具（`cron_add` 什么的）→ agent → registry → cron → agentLoop → 循环
- **难测试**：测 CronService 必须 mock 整个 agentLoop 依赖树
- **紧耦合**：CronService 假定"执行 = 跑 agentLoop"——**换个执行方式（比如直接发 HTTP 请求）就没法用**

**方案**——**定义一个最小接口、外部注入**：

```ts
// src/cron/service.ts
export interface CronExecutor {
  runAgentPrompt: (prompt: string, timeout?: number) => Promise<string>;
  notify?: (message: string) => void;
}

class CronService {
  private executor?: CronExecutor;

  setExecutor(executor: CronExecutor): void {
    this.executor = executor;
  }

  private async runPayload(payload: JobPayload): Promise<string> {
    if (payload.type === 'agent') {
      return this.executor!.runAgentPrompt(payload.prompt);
    }
    // handler 分支——从注册表里取纯函数、跟 agentLoop 完全解耦
    return this.runHandler(payload.handler);
  }
}
```

**接线在 index.ts**——把 agentLoop 包装成 `CronExecutor`：

```ts
// src/index.ts
const cronExecutor: CronExecutor = {
  runAgentPrompt: async (prompt, timeout = 60000) => {
    // 独立 messages + 独立 budget——跟 channel session 隔离原则一致
    // 每次 fire 都开新对话、不污染主线
    const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
    const cronBudget: BudgetState = { used: 0, limit: 600000 };
    const dynamicSystem = promptBuilder.build({ /* ... */ });

    // Promise.race 实现超时——超时不 kill loop、只放弃等待
    const loopPromise = agentLoop(model, registry, cronMessages, dynamicSystem, cronBudget, { /* ... */ })
      .then(() => extractLastAssistantText(cronMessages));
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`cron timeout after ${timeout}ms`)), timeout));
    return Promise.race([loopPromise, timeoutPromise]);
  },
  notify: (msg) => console.log(`  [cron notify] ${msg}`),
};

const cronService = new CronService('.');
cronService.setExecutor(cronExecutor);
```

**这个 pattern 是 SOLID 里的 D（依赖倒置原则）活生生的落地**——高层模块（CronService）不依赖低层模块（agentLoop）、两者都依赖抽象（CronExecutor）。

**好处**：
- **测试友好**：`cronService.setExecutor({ runAgentPrompt: async () => 'mocked' })` 一行搞定
- **可替换**：想用 curl / webhook / 甚至写死"打印时间"都行
- **两个 payload 类型对应两条执行路径**：
  - `agent` —— 走 executor 到 agentLoop（用于"帮我做点复杂的事"）
  - `handler` —— 走内置注册表的纯函数（用于"每 30 秒输出一句名言"这种简单副作用）

**Handler 分支的价值**：**不是所有定时任务都需要 LLM**——一句"输出名言"用 100 行随机字符串就能实现、烧个 agentLoop 是浪费。**给"轻量任务"留一条不走 LLM 的路径**、既省钱又快。

## 5. 决策三：JSON + JSONL 的分工

**同一个 Cron 系统里两种存储**：

```
.cron/
├── jobs.json      任务定义（JSON、原子读写）
└── logs.jsonl     执行日志（JSONL、只追加）
```

**为什么两种不同的选择**——**因为它们的更新模式完全不同**：

### jobs.json —— 需要原子更新

**语义**：任务定义会被增删改——`add` / `remove` / `enable` / `disable`——**每次改动都要把整个数组重新写回**。

**为什么用 JSON**：
- **一次读全 / 一次写全**——任务数量小（一般 <100 个）、整体读写没性能问题
- **原子性**：`fs.writeFileSync(path, JSON.stringify(all))` 是原子操作（POSIX rename 语义）——**要么全成功要么全失败、不会写到一半留半破损文件**
- **人类可读**：出问题打开 jobs.json 一看就明白

**代价**：小改动也要全量写盘——但任务定义变更本来就低频、这个代价可以忽略。

### logs.jsonl —— 只追加

**语义**：执行日志是**只增不改**的——每次 fire 完 append 一行、永远不回去改历史记录。

**为什么用 JSONL**（一行一个 JSON 对象）：
- **append-only 高效**：`fs.appendFileSync(path, line)` 只碰文件末尾、不重写全文——**日志几万条也不慢**
- **崩溃安全**：进程中间挂了、已经 append 的行完好无损（跟 [Session JSONL](session-persistence.md) 一样的选择、一样的理由）
- **流式处理友好**：`readline` 逐行读、大文件不用一次性加载到内存
- **分析工具原生支持**：`jq -c '.status == "success"' logs.jsonl` 直接筛

**共同哲学**：**存储格式跟数据的更新模式匹配**——**definitions 变更频率低 + 需要原子性 → JSON**、**events 变更频率高 + 只追加 → JSONL**。这个选择跟 [Session 持久化](session-persistence.md) / [Memory 索引 + markdown](memory-system-design.md) 是同一个原则的不同应用。

## 6. 决策四：三层安全防护

**Cron 是无人值守系统**——你睡了它还在跑、错了没人立刻发现。所以要有**自动的自愈能力**：

### 6.1 连续失败自动禁用

```ts
// src/cron/service.ts (简化)
if (log.status === 'error' || log.status === 'timeout') {
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= (state.config.maxRetries ?? 3)) {
    state.config.enabled = false;
    this.store.saveJobs(...);
    console.error(`  [cron] ${state.config.id} 连续失败 ${state.consecutiveFailures} 次、自动禁用`);
  }
} else {
  state.consecutiveFailures = 0;  // 一次成功就重置计数
}
```

**为什么必要**：一个"每 30 秒 fire 一次"的坏任务会一晚上跑 2880 次、每次都失败、烧几万 tokens。**熔断机制是无人值守场景的必备**——跟 [Agent Loop 的循环检测](agent-loop-protections.md) 是同一个哲学。

**为什么是"连续失败"而不是"失败率"**：因为**间歇性失败（比如网络抖动）不该禁用任务**——只有"从上次成功后一直失败"才说明真的坏了。

### 6.2 source: 'config' vs 'runtime'

```ts
// src/cron/types.ts
export interface CronJobConfig {
  // ...
  source: 'config' | 'runtime'; // 来源：config 不可删、runtime 可增删
}
```

**语义**：
- `config` —— 从 `.cron/jobs.json` 加载的、**代码库里定义好的**任务；**用户或 Agent 不能删**——只能 disable
- `runtime` —— 运行时通过 REPL 或工具动态添加的、**临时性任务**；可以自由增删

**为什么区分**：**"任务的所有权"不同**——config 任务是产品设计的一部分（比如"每天早上 9 点发日报"、这是产品行为）、runtime 任务是用户临时创建的（比如"3 小时后提醒我关空调"）。**混一起管理会出事**——用户/Agent 意外删了 config 任务、下次部署又装回来、状态漂移。

### 6.3 权限系统联动

Cron 触发的 `agentLoop` 也走 [三层安全防线](security-design.md)：

- **角色权限**：cron session 走同一个 `registry.getActiveTools()`、能不能调 bash 由角色决定
- **Bash Classifier**：cron 里 Agent 想跑 `rm -rf` 一样被 `bashSecurityHook` 拦
- **Hook 管线**：`auditLogHook` 一样对 cron 触发的调用生效

**这不是"cron 系统单独做了安全"**——是**cron 复用了 agentLoop 的所有安全能力**、通过 executor 接口自然继承。**这是"分层设计"的复利效应**——每一层的能力都能被其他层复用、不用重复造。

**MVP 的坑**：当前 cron 用的是全局 role（跟 REPL 同一个）——**这意味着 REPL 里切到 guest、cron 里的 Agent 也会失去 bash 能力**。生产要按每个 job 独立配 role：

```ts
// 未来的形态
interface CronJobConfig {
  runAs?: Role;  // 默认 owner、可以设 collaborator / guest
}
```

## 7. 完整生命周期：从 fire 到 log

一个 cron 任务从加载到执行的完整链路：

```
1. 启动: cronService.load()
   ↓ 读 .cron/jobs.json
   ↓ 每个 enabled 任务建 CronJobState
   
2. 调度: cronService.start()
   ↓ 每个 job 走 scheduleJob():
     - parser.parseSchedule(expr) → ParsedSchedule
     - 算 delay 到下次触发时间
     - setTimeout(() => fire(), delay)
     - 存 timerId 到 state
   
3. 到点 fire:
   ↓ state.running = true
   ↓ runPayload(config.payload):
     - type='agent' → executor.runAgentPrompt(prompt) → agentLoop
     - type='handler' → this.runHandler(name) → 纯函数
   ↓ output (或 error)
   
4. 记录:
   ↓ 构造 RunLog { jobId, startedAt, finishedAt, status, output/error }
   ↓ store.appendLog(log) → append 到 logs.jsonl
   ↓ 更新 state.lastRun
   ↓ 更新 consecutiveFailures
   
5. 熔断检查:
   ↓ 连续失败 >= maxRetries?
     - 是 → state.config.enabled = false + saveJobs() + 停 timerId
     - 否 → 继续步骤 6
   
6. 循环调度:
   ↓ type='interval' → scheduleJob() 排下一次
   ↓ type='cron' → getNextCronTime() 算下次、scheduleJob()
   ↓ type='once' → 结束、不再调度
   
7. state.running = false
```

**关键：一次 fire 完就重新排下一次**——不是"一开始 setInterval 每 30 秒来一次"、而是"每次 fire 完根据 parsed schedule 排下一次"。这样**执行超时不会"错开累积"**——上一次跑了 5 分钟、下一次不是"5 分钟前就该 fire 的补跑"、而是从"这次结束"再计算 30 秒。**符合直觉**。

## 8. 停机顺序：cron → channel → plugin → MCP

现在有四种长生命周期资源要清：

```ts
// src/index.ts
const shutdown = async () => {
  cronService.stop();               // ① 先停调度器（不再 fire）
  await gateway.stopAll();          // ② 再停 channel（不再接收新消息）
  await pluginManager.unloadAll();  // ③ 再卸 plugin（清 DB 连接等资源）
  await registry.closeAllMCP();     // ④ 最后关 MCP 子进程
  process.exit(0);
};
```

**cron 为什么放最前**：

**Cron 和 Channel 都是 "loop 触发方"**——它们决定 agentLoop 什么时候跑。**两者都可能在 shutdown 瞬间正好触发一次 loop**、如果先清 plugin/MCP、loop 里调用工具就会崩。

**cron 又比 channel 更靠前**：因为 **cron 的 timer 是同步 clear 的、瞬间生效**（`clearTimeout` 立即返回）、而 channel 的 stop 需要等 WebSocket 关闭、HTTP 服务器 close 完成——**先停最快的、再等最慢的**、总时间最短。

**这个顺序体现"依赖清理"通用原则**：**上游先停、下游后停**——上游是"触发方"、下游是"被触发方"。

## 9. 已知的坑与后续方向

### 9.1 权限没跟 job 挂钩

当前 cron 复用全局 role——**REPL 切到 guest、所有 cron 也失能**。生产必须每个 job 独立 `runAs: Role`、fire 时把 role 传进 executor。

### 9.2 executor 是单例

`CronService.setExecutor(...)` 只能装一个 executor——**所有 cron 用同一个 model + budget**。生产可能要"这个 job 走便宜模型、那个 job 走 GPT-4"——需要 per-job executor 或 executor 支持模型选择。

### 9.3 没有分布式支持

`setTimeout` 是**进程内**的——同一个 cron 部署两个实例、两个都会 fire、任务跑两次。生产要么：
- **单实例部署**（简单、但不高可用）
- **加分布式锁**（Redis SETNX / K8s Lease）保证只有一个实例 fire

当前教学项目只做单进程。

### 9.4 timezone 硬编码 UTC

`getNextCronTime` 走 croner 默认时区——**如果部署在 UTC 服务器、"9 点"是 UTC 9 点、不是用户所在时区**。要支持 per-job timezone：`schedule: "0 9 * * *", timezone: "Asia/Shanghai"`。

### 9.5 没有并发限制

一个 job 上次没跑完、下次又 fire——**当前用 `state.running` 挡住**（跳过这次）。但**没有队列语义**——错过的调度就是错过了、不会补跑。真实需求可能要：
- **重叠时跳过**（当前行为）
- **重叠时排队**（下次等上次跑完）
- **重叠时并发**（允许多个实例同时跑）——需要显式配置

### 9.6 handler 不能带参数

`type: 'handler'` 目前只支持 `{ handler: 'name' }`——handler 是纯函数、拿不到"这次调用的额外参数"。生产可能要 `{ handler: 'name', args: { threshold: 100 } }`。

### 9.7 日志会无限增长

`.cron/logs.jsonl` 没有轮转——跑一年就几百 MB。真实场景要：
- **按大小轮转**（超过 10MB 切一个新文件）
- **按时间轮转**（每月一个）
- **过期清理**（保留 90 天）

跟应用日志同一套规则、当前教学项目不做。

### 9.8 没有可视化 dashboard

跟 [Channel Dashboard](channel-system-design.md#6-内置样本feishuchannel--dashboard) 一样、cron 可以做一个 web 面板：查看下次 fire 时间、成功率、最近失败原因。**REPL 里的 `/cron` 和 `/cron logs` 是纯文本替代**——生产可以升级。

---

## 回顾：为什么"主动执行"是 Agent 能力的分水岭

**这一篇的核心洞察**：

**前面所有的系统都在扩展 Agent 的"响应能力"**——你问什么它能答什么、能调什么工具、能记什么事、能进什么通道。但归根结底、**它是被动的**——**你不叫它、它不动**。

**Cron 让 Agent 变成"能主动做事的实体"**——

- **每天早上 9 点、它自己整理你的日程**、不用你提醒
- **每 5 分钟看 CI、有失败自己通知**、不用你盯着
- **发现你三天没提交代码、主动问你是不是遇到问题了**——**这才叫"助手"、不是"客服"**

**跟前面几个抽象的层次关系**：

- **Tool / Skill / Plugin** —— Agent 能做什么
- **Memory / RAG** —— Agent 知道什么
- **Channel** —— Agent 从哪里被叫
- **Cron** —— **Agent 什么时候自己动**

**四个维度合起来才是一个完整 Agent**——缺了任何一个都是残的：没工具是聊天机器人、没记忆是金鱼、没通道是本地玩具、**没定时是永远等着你说话的仆人**。

**这四个维度都做完了、你就有了一个可以独立生活的 Agent。**
