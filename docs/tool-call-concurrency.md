# 工具调用并发控制详解

> 配套 [../README.md](../README.md) 的拓展阅读。README 讲的是 Agent Loop 的三道防护；这篇展开讲**工具执行层的并发控制**——为什么工具不是都能并行、读写锁怎么用三个状态变量实现、每个工具在哪里声明自己的并发属性。

## 目录

- [0. 总览：为什么需要并发控制](#0-总览为什么需要并发控制)
- [1. 声明：isConcurrencySafe 与 isReadOnly](#1-声明isconcurrencysafe-与-isreadonly)
- [2. 核心机制：一把手写的读写锁](#2-核心机制一把手写的读写锁)
- [3. 锁的四个方法怎么配合](#3-锁的四个方法怎么配合)
- [4. 与 execute 的接线：try/finally 兜底](#4-与-execute-的接线tryfinally-兜底)
- [5. 一个完整时序](#5-一个完整时序)
- [6. 设计取舍与边界](#6-设计取舍与边界)

## 0. 总览：为什么需要并发控制

三道防线防的是**循环层面的故障**（循环重复、请求失败、token 超支），它们都住在 `agentLoop` 内部。但循环最终要落地到**执行工具**——这一层还有一类故障没被覆盖：**并发竞态**。

Agent 的一步里，模型可能同时发起多个工具调用（比如"查北京天气 + 读 README + 写日志"），这些 `execute` 会被相继触发。如果两个**有副作用**的工具（比如两个 `write_file`）同时执行，就可能互相覆盖、读到半截状态。反过来，**只读**工具（查天气、读文件）并行跑完全没风险，串行反而白白浪费等待时间。

所以需要一把**读写锁**，规则就一句话：

- **只读的可以并行** —— 多个共享锁同时持有
- **有副作用的必须串行** —— 独占锁同一时刻只有一个持有者
- **独占锁必须等所有共享锁释放才能拿到**

这把锁在 [`src/tool-registry.ts`](../src/tool-registry.ts)，三个状态变量、六个方法，没有依赖任何第三方库。

## 1. 声明：isConcurrencySafe 与 isReadOnly

每个工具在 [`src/tool/index.ts`](../src/tool/index.ts) 里用两个布尔字段声明自己的并发属性：

| 字段 | 含义 | 示例 |
|---|---|---|
| `isConcurrencySafe` | 能否与其他工具安全并行 | `weatherTool: true`、`writeFileTool: false` |
| `isReadOnly` | 是否只读、无副作用 | `weatherTool: true`、`writeFileTool: false` |

代码里实际生效的只有 `isConcurrencySafe`（[`tool-registry.ts`](../src/tool-registry.ts) 第 74 行 `tool.isConcurrencySafe === true`），`isReadOnly` 目前只是文档化标签——打印在启动日志里，不参与锁的判定。真正决定拿哪把锁的是前者。

当前五个工具的分工：

| 工具 | isConcurrencySafe | 拿的锁 | 理由 |
|---|---|---|---|
| `get_weather` | ✅ true | 共享 | 只读查表 |
| `read_file` | ✅ true | 共享 | 只读文件 |
| `list_directory` | ✅ true | 共享 | 只读目录 |
| `calculator` | 未声明（默认 false） | **独占** | 没标，走保守默认 |
| `write_file` | ❌ false | 独占 | 写文件，必须串行 |

注意 `calculator`：它其实是纯函数，可以安全并发，但因为**没声明** `isConcurrencySafe`，`=== true` 不成立，被归到独占档。这是有意为之的保守默认——**宁可慢，不可错**。把一个写操作误标成并发，代价是数据竞态；把一个只读操作漏标，代价只是少了点并行。

## 2. 核心机制：一把手写的读写锁

锁就是 [`tool-registry.ts`](../src/tool-registry.ts) 里的三个状态变量（第 18-21 行）：

```ts
private exclusiveLock = false;          // 当前是否有独占锁持有者
private concurrentCount = 0;            // 当前共享锁持有数
private waitQueue: Array<() => void> = [];  // 阻塞等待中的 resolve 函数
```

- `exclusiveLock`：布尔，此刻有没有独占锁
- `concurrentCount`：数字，此刻有多少个共享锁
- `waitQueue`：一个"闹钟列表"，存的是抢锁失败者的 `resolve` 函数

`waitQueue` 里为什么存函数而不是回调对象？看获取共享锁的写法（第 38-43 行）：

```ts
private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
        await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.concurrentCount++;
}
```

`new Promise(r => ...)` 创建了一个 Promise，并把它的 `resolve`（参数 `r`）推进队列；`await` 这个 Promise 就让当前 `execute` 挂起。将来某人的 `resolve()` 被调用，`await` 就返回，循环回到 `while` 条件再判断一次。**用一个 Promise 当一次"闹钟"：入队 = 挂起，出队 = 唤醒**——这是纯 JS 手写锁最常用的套路。

## 3. 锁的四个方法怎么配合

四个方法分两组：两个 acquire（取锁）、两个 release（放锁），外加一个 `drainQueue`（叫醒所有人）。

### 取共享锁 vs 取独占锁：放行条件不同

| 方法 | 放行条件 | 通过后做什么 |
|---|---|---|
| `acquireConcurrent` | `!exclusiveLock` | `concurrentCount++` |
| `acquireExclusive` | `!exclusiveLock && concurrentCount === 0` | `exclusiveLock = true` |

关键差异：共享锁**只被独占锁挡**，多个共享锁互不阻塞；独占锁**同时被独占锁和共享锁挡**，必须等场地完全干净。

### 放锁 vs 唤醒：为什么共享锁要"计数归零才唤醒"

```ts
private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
}

private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
}
```

`releaseConcurrent` 只有在计数归零时才 `drainQueue`。为什么？因为独占锁在等"所有共享锁都结束"。如果第 2 个共享锁释放时就去唤醒排队的独占锁，独占锁醒来一看 `concurrentCount` 还是 1，只能又睡回去——白忙一趟。**最后一个共享锁释放的那一刻，才是唯一值得叫醒排队的时机**。

`releaseExclusive` 则无条件唤醒：独占锁一放，条件立刻可能满足，谁抢到算谁的。

### drainQueue：惊群唤醒，二次校验

```ts
private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
}
```

`drainQueue` 把队列**全部**取出、逐个 resolve——不是"只叫醒排在最前面的那个"。这就是经典的**惊群唤醒（thundering herd）**：所有人都醒了，各自回到 `while` 条件重新抢锁，抢不到的再入队。

这套写法能保证正确，靠的不是队列顺序（这不是公平调度），而是 `while` 循环的**二次校验**：被唤醒 ≠ 拿到锁，醒了还要再确认条件成立。好处是逻辑简单、不容易死锁；代价是可能有无效唤醒（醒来又睡回去），但在工具调用这个规模下完全可以忽略。

## 4. 与 execute 的接线：try/finally 兜底

锁不会自己跑，它在 [`toAISDKFormat`](../src/tool-registry.ts) 里被包进每个工具的 `execute`（第 79-99 行）：

```ts
execute: async (input: any) => {
    if (isSafe) {
        await registry.acquireConcurrent();
        console.log(`  [并发] ${name} 获取共享锁`);
    } else {
        await registry.acquireExclusive();
        console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
    }
    try {
        const raw = await executeFn(input);
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        return truncateResult(text, maxChars);
    } finally {
        if (isSafe) registry.releaseConcurrent();
        else registry.releaseExclusive();
    }
},
```

三个细节值得单独拎出来：

**① `try/finally` 是生死线。** 锁必须在 `finally` 里释放——工具抛异常、超时、返回 reject，`finally` 都会执行。如果漏掉它，一次失败的调用会让 `exclusiveLock` 永远停在 `true`，之后**所有**工具都卡死在 `while` 上，比不用锁更糟。锁的释放是无条件的、与业务无关的，这正是放 `finally` 的典型场景。

**② `registry = this` 这行是必需的。** 外层 `for` 循环里 `this` 是 `ToolRegistry` 实例；但 `execute` 是一个独立对象字面量里的函数，调用时 `this` 会被 AI SDK 重绑定。所以先 `const registry = this;` 把实例快照下来，闭包里永远引用正确的 registry。

**③ `isSafe` 在构建期快照。** `tool.isConcurrencySafe === true` 在 `toAISDKFormat()` 时就算好了，闭包用的是这个快照。工具注册后改标志不会影响已构建的格式——在本项目里这没问题，因为注册一次就不再变。

## 5. 一个完整时序

把三个工具几乎同时触发走一遍（`get_weather`、`read_file` 拿共享锁，`write_file` 拿独占锁）：

```
时间轴            状态                     说明
──────────       ───────────────────     ─────────────────────────────
get_weather      独占=false 共享=0        acquireConcurrent → 共享=1 ✅
read_file        独占=false 共享=1        acquireConcurrent → 共享=2 ✅
write_file       独占=false 共享=2        acquireExclusive: 共享>0 → 入队 ⏸
get_weather 结束  releaseConcurrent       共享=1（没归零，不唤醒）
read_file 结束    releaseConcurrent       共享=0 → drainQueue 叫醒 write_file
write_file 醒来   独占=false 共享=0       重新检查 while → 条件满足
write_file 执行   exclusiveLock=true     独占=1 ✅
write_file 结束   releaseExclusive       独占=false → drainQueue
```

可以清楚看到读写锁的核心纪律：**两个只读工具并行跑完了，写工具才进场**；而写工具执行期间，场地是干净的，不会被任何共享锁插进来。

## 6. 设计取舍与边界

这套锁实现约 40 行，换来的是工具层的"多读单写"不变量。有几个边界值得知道：

**① 非公平：共享锁可能饿死独占锁（写者饥饿）。** `acquireConcurrent` 只检查 `exclusiveLock`，不检查等待队列里有没有排队的独占请求。如果共享锁请求持续到达，每次都能直接进场，排在队列里的独占工具可能一直等不到。本项目里工具调用频度低、不会长时间持续涌入，所以无碍；生产级读写锁通常会**给独占优先**（把新到的共享锁挡在排队独占之后），或直接按 FIFO 出队。

**② 不可重入。** 如果某个工具在执行过程中，内部又去调同一个 registry 里需要拿锁的工具（嵌套调用），会死锁——因为锁是 `async` 挂起而不是可重入计数。当前工具实现都是原子的，不会发生；但如果未来加"工具 A 内部调用工具 B"的编排，就要改成可重入锁或显式传"已持锁"上下文。

**③ 锁粒度 = registry 实例。** 锁状态存在 `ToolRegistry` 实例上，**所有注册的工具共享同一把锁**。`src/index.ts` 只创建一个 registry（第 25-26 行），所以全局互斥是对的。但如果以后创建第二个 registry 实例，两个实例之间互相不知情——这是预期的，不是 bug。

**④ 与三道防线的分工。** 并发控制不在 `agentLoop` 里，它住在工具执行层，防护对象也不同：

| 机制 | 住在哪 | 防什么 |
|---|---|---|
| 三道防线 | `agent/loop.ts` | 循环层面的故障（重复 / 失败 / 超支） |
| 读写锁 | `tool-registry.ts` | 工具执行层的竞态（并发安全） |

`agentLoop` 对锁毫无感知——[`loop.ts`](../src/agent/loop.ts) 只是把 `registry.toAISDKFormat()` 传进 `streamText`，锁是工具层自己加的防护。这保持了循环逻辑的干净：**循环管"要不要调"（三道防线），工具层管"怎么安全地调"（读写锁）**。

> 三道防线本身的实现细节（指纹怎么算、滑动窗口怎么维护、三个检测器、退避公式、在 loop 里怎么接线），见姊妹篇 [agent-loop-protections.md](agent-loop-protections.md)。
