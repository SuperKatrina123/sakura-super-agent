# SubAgent 系统：从"一个 Agent"到"能派活的 Agent"

> 配套 [../README.md](../README.md) 的拓展阅读。前面几篇讲的是**给一个 Agent 装能力**——工具、记忆、通道、定时。这一篇讲**让一个 Agent 变成一群 Agent 的调度者**：为什么需要子 Agent、隔离的本质是什么、执行隔离的六个关键设计、两道保护机制、结果回传的三种业界做法、以及"模型不一定会主动用 spawn_agent"这个真实问题怎么解。

## 目录

- [0. 为什么需要 subAgent](#0-为什么需要-subagent)
- [1. subAgent ≠ 前面任何维度](#1-subagent--前面任何维度)
- [2. 隔离的本质：同进程 + 独立上下文](#2-隔离的本质同进程--独立上下文)
- [3. spawnAgent 执行隔离的六个设计点](#3-spawnagent-执行隔离的六个设计点)
- [4. 两道保护：maxSpawnDepth + maxConcurrent](#4-两道保护maxspawndepth--maxconcurrent)
- [5. 结果回传：三种业界做法对比](#5-结果回传三种业界做法对比)
- [6. 用户看得见的两个接口](#6-用户看得见的两个接口)
- [7. 模型不一定会主动用 spawn_agent](#7-模型不一定会主动用-spawn_agent)
- [8. 关键设计回顾](#8-关键设计回顾)
- [9. 已知的坑与后续方向](#9-已知的坑与后续方向)

## 0. 为什么需要 subAgent

前面几篇让 Agent 变得越来越强——能装工具、能记事、能被叫醒、能自己动。**但归根结底、还是一个 Agent 在跑**：

- 一份 messages 数组、装所有对话历史
- 一份 budget、烧同一个池子
- 一条 loop 线程、串行推进

**三个真实问题**这个"单 Agent 架构"扛不住：

**① 上下文装不下**

要调研 React / Vue / Solid 三个大项目——每个仓库读几十个文件、几万 tokens。**一个 Agent 累积三个项目的探索历史** = 十几万 tokens 后 loop 就开始 [压缩 / 截断](context-compression.md)、丢失早期细节。

**② 需要并行提效**

三个独立任务——**单 Agent 只能串行**："先调研 React、完了再调研 Vue、最后 Solid"。哪怕三个任务完全独立、也只能挨个来。

**③ 需要隔离**

Agent 要做**实验性重构**——改坏了怎么办？主对话里改动被写入了、想撤都难撤。

**subAgent 的三个价值分别对应这三个问题**：

- **独立上下文** → 装不下的问题解决
- **并行调度** → 效率问题解决
- **独立执行环境** → 隔离问题解决（**当前实现只做前两个、隔离用同进程 + 独立 messages 兜底**、见下面章节 2）

## 1. subAgent ≠ 前面任何维度

前面的抽象都在扩展 Agent 的**某个属性**：

| 抽象 | 扩展什么 |
|---|---|
| Tool / Skill / Plugin | 能做什么（能力） |
| Memory / RAG | 知道什么（知识） |
| Channel | 从哪被叫（通道） |
| Cron | 什么时候动（时机） |

**subAgent 不扩展任何属性——它扩展的是 Agent 之间的关系**。

**Agent 之间从"一个"变成"多个"**——一个主 Agent 可以派若干子 Agent、子 Agent 有独立 context 但共享工具集、完成后把结果压缩回主。**这是"数量"上的跃迁**、不是"能力"上的加法。

**跟 Cron 的对比**看得最清楚：

- **Cron**：给一个 Agent 装"到点自己动"的能力——**改变触发时机**、Agent 还是那个 Agent
- **subAgent**：让一个 Agent 能变成多个 Agent 协作——**改变 Agent 的数量和关系**

**这也是为什么 subAgent 是全项目最后一篇**——前面所有抽象都在打造"一个更强的 Agent"、这一篇开始才是"从一个到一群"。

## 2. 隔离的本质：同进程 + 独立上下文

subAgent 系统的第一个核心问题是**隔离怎么做**——**独立上下文这个语义、落在什么级别的隔离上**？

### 我们的选择：同进程 + 独立 messages

**最简单的隔离方式**——子 Agent 跟父 Agent 在**同一个 Node.js 进程**里、区别只在于**独立的 messages 数组**。

```ts
// src/agents/spawn.ts (核心一行)
const messages: ModelMessage[] = [
  { role: 'user', content: request.task },
];
```

**这一行就是隔离的全部**——子 Agent 拿到一个**全新的、空的 messages 数组**、里面只有一条 user 消息（任务描述）。父 Agent 之前的对话历史、工具调用记录、subAgent 一概看不到。

**同进程隔离的优势**：
- **零 IPC 开销**——不用序列化 / 反序列化传数据
- **启动快**——不 fork 新进程、不加载新的运行时
- **共享工具集**——sub 复用父的 ToolRegistry、hooks、memory、RAG——**能力零成本继承**

**Claude Code 也是这个模式**——它用 `AsyncLocalStorage` 做上下文隔离、子 Agent 在同进程里跑、不需要 fork 新进程。

### 业界的两种备选（了解即可）

**git worktree 隔离**——用于**代码破坏性操作**（大规模重构 / 实验性改动）。给 sub 一个独立的 git worktree、改坏了不影响主分支。Claude Code 的 `isolation: 'worktree'` 就是这个——创建临时 git worktree、sub 在里面随便改、完成后有改动就保留、没改动就自动清理。

**进程级隔离**——**独立进程独立内存空间**。通过 tmux / iTerm2 启动独立进程。Claude Code 的 **Swarm 模式**（多 Agent 组成团队协作）用的就是这种。适合**长时间运行**的 Agent、或者需要各自独立**文件系统操作**的场景。

### 为什么我们够用

**教学项目的 subAgent 场景是"并行调研 / 信息搜集 / 分而治之"**——这些场景**不需要文件系统隔离、也不需要独立进程**、同进程 + 独立 messages 就覆盖了。

**判断标准**：
- 只需要 context 隔离？→ **同进程 + 独立 messages** 够
- 需要文件系统隔离（防止破坏性改动）？→ **git worktree**
- 需要 CPU / 内存 / 长运行隔离？→ **独立进程**

**渐进升级**——先做最简单的、真实需求出现再升。

## 3. spawnAgent 执行隔离的六个设计点

`src/agents/spawn.ts` 的 100 多行代码里、藏着 6 个值得展开的设计决策：

### 3.1 独立 messages 数组 = 独立上下文窗口

**已经在第 2 节讲了、这是核心**——一行代码搞定隔离：

```ts
const messages: ModelMessage[] = [{ role: 'user', content: request.task }];
```

**副作用**：sub 有时会做主 Agent 觉得"多余"的事——比如已经 read_file 成功了、又调一次 bash cat 确认。**这是隔离的代价、也是它的价值**——sub 独立判断、不受主判断影响。

### 3.2 EXCLUDED_TOOLS：sub 不能再派 sub

```ts
const EXCLUDED_TOOLS = new Set(['spawn_agent']);
// ...
const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS);
```

**为什么**：sub 里再派 sub 会引发**递归 fan-out**——理论上 `maxSpawnDepth` 能兜底、**但从源头排除更干净**——sub 拿到的工具列表里根本没有 spawn_agent、连"我可以试试派"都没有。

**"深度防御"思路**：能在多个层面挡的、就多挡几层。SYSTEM 里过滤 + tool schema 排除 + registry 里 canSpawn 检查——**三层保护、坏一层还有下一层**。

### 3.3 toAISDKFormatUnlocked：不能复用 agentLoop 的锁

**这是最容易踩的坑**——**子 Agent 不能直接复用 agentLoop**。

**为什么**：agentLoop 内部调 `registry.toAISDKFormat()`、这个方法会走[读写锁](tool-call-concurrency.md)。**但 spawn_agent 本身就是一个工具**——sub 执行时**父 Agent 的锁还没释放**——sub 里再调工具就会**死锁**。

**解决**：sub 走 `toAISDKFormatUnlocked()`——**不加锁 + 支持排除清单**：

```ts
// src/tools/tool-registry.ts
toAISDKFormatUnlocked(excluded: Set<string> = new Set()): Record<string, any> {
  const result: Record<string, any> = {};
  for (const tool of this.getActiveTools()) {
    if (excluded.has(tool.name)) continue;
    result[tool.name] = {
      /* execute 直接调、不 acquireLock、不 releaseLock */
      execute: async (input: any) => {
        // hooks 仍然走——安全防线不能因为 sub 就跳过
        const pre = await registry.hooks.runPre(name, input);
        if (pre.action === 'block') return `[security] ${pre.reason}`;
        const raw = await executeFn(finalInput);
        const modified = await registry.hooks.runPost(name, finalInput, raw);
        return truncateResult(text, maxChars);
      },
    };
  }
  return result;
}
```

**关键**：**hooks 依然走**——[三层安全防线](security-design.md)在 sub 里同样生效、bashSecurityHook 该拦还是拦、auditLogHook 该 log 还是 log。**只跳过了锁、没跳过安全**。

### 3.4 最后一步强制文字：toolChoice + prompt 双保险

**问题**：sub 跑到第 30 步还在调工具怎么办？无限 loop 或超预算。

**方案**：**双重保障**：

```ts
const isLastStep = step === maxSteps;
if (isLastStep) {
  messages.push({ role: 'user', content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。' });
}
const result = streamText({
  toolChoice: isLastStep ? 'none' : 'auto',   // ① API 层禁止工具调用
  // ...
});
```

- **API 层 (`toolChoice: 'none'`)**——**硬阻止**、模型物理上没法 tool call
- **Prompt 层 (注入 user 消息)**——**软引导**、告诉模型该总结了

**为什么两层都要**：`toolChoice: 'none'` 只是禁止调用、不代表模型知道"该总结了"——**可能模型只是硬生生停下、输出空文字**。加一句 prompt 让它有明确方向。

**这个 pattern 通用**——**硬约束 + 软引导** 组合、可用于任何"限制模型行为"的场景。

### 3.5 彩色 tag：让并行日志可读

三个 sub 并行 fire、终端输出会**严重交错**——**不加区分完全看不懂**。

```ts
const AGENT_COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m'];
const RESET = '\x1b[0m';

function agentTag(index: number, runId: string): string {
  const color = AGENT_COLORS[index % AGENT_COLORS.length];
  return `${color}[Agent-${index + 1}:${runId}]${RESET}`;
}
```

**Agent-1 cyan、Agent-2 yellow、Agent-3 magenta**——终端里一眼可辨。这是**可观测性投资**——**并发系统必须有的、debug 时救命**。

### 3.6 AbortController 超时 + 部分结果回传

**子 Agent 调网络 API 可能 hang 住** —— 60 秒超时是最后保底：

```ts
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), timeout);
try {
  // streamText 里传 abortSignal: ac.signal
  // 超时后能中断正在进行的 API 请求
} finally {
  clearTimeout(timer);
}
```

**关键细节**：超时时**尝试提取已有的部分结果**、不至于完全白跑：

```ts
if (isAbort) {
  const partial = [...messages].reverse().find(m => m.role === 'assistant');
  if (partial) {
    // 提取部分文本
    return `[部分结果] ${text}`;
  }
}
```

**心态**：**部分成功 > 完全失败**——sub 跑了 55 秒、拿到 80% 的信息、第 56 秒超时——**这 80% 应该回传给主 Agent、别丢**。

## 4. 两道保护：maxSpawnDepth + maxConcurrent

**subAgent 是资源放大器**——一个主 Agent 触发 3 个 sub、每个 sub 又能触发 3 个 sub...**指数增长几步就能把系统压垮**。

**两道独立保护**：

```ts
// src/agents/types.ts
export interface SubAgentConfig {
  maxSpawnDepth: number;       // 最大嵌套深度，默认 1
  maxConcurrent: number;       // 最大并发子 agent 数，默认 3
  defaultTimeout: number;      // 默认执行超时 ms，默认 60000
}
```

**maxSpawnDepth = 1（默认）**——**只允许主 Agent 派 sub、sub 不能再派 sub**。防止指数 fan-out：

```
主 → sub × 3    (depth = 0 → 1、canSpawn 检查 depth < maxSpawnDepth)
sub → sub × 3   (depth = 1 → 2、canSpawn 拒绝)
```

**maxConcurrent = 3**——**同时最多 3 个 sub 在跑**。防止一次派太多：
- API rate limit
- 内存占用
- 网络带宽

```ts
canSpawn(currentDepth: number): { ok: boolean; reason?: string } {
  if (currentDepth >= this.config.maxSpawnDepth) {
    return { ok: false, reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}` };
  }
  const activeCount = this.getActiveRuns().length;
  if (activeCount >= this.config.maxConcurrent) {
    return { ok: false, reason: `已达最大并发数 ${this.config.maxConcurrent}` };
  }
  return { ok: true };
}
```

**两道保护是独立的**：
- 深度限制防"垂直爆炸"（一条链无限深）
- 并发限制防"水平爆炸"（一层无限宽）
- **各挡一维、组合起来是完整的资源边界**

## 5. 结果回传：三种业界做法对比

子 Agent 干完活、结果怎么传回给父 Agent？**这一步不同产品选了不同的做法**——展示三种、我们选最简单的。

### 我们的做法：同步直接注入

```ts
// src/tools/spawn-tools.ts
execute: async ({ task, tasks }) => {
  if (tasks) {
    const results = await spawnParallel(tasks.map(t => ({ task: t })), ctx);
    return results.map((r, i) => `## 子 Agent ${i + 1}: ${r.task}\n\n${r.result}`).join('\n\n---\n\n');
  }
  if (task) return spawnAgent({ task }, ctx);
}
```

**子 Agent 的输出作为 spawn_agent 工具的返回值**——直接注入父 Agent 的 messages。

**特点**：
- **同步**——父 Agent 等 sub 全部完成才继续
- **单向**——sub 没法主动通知父、只能通过返回值
- **零延迟**——sub 完成的瞬间父就拿到

**Claude Code 内部也是这个模式**——最直接、最简单、够用。

### OpenClaw 的 Announce Queue

**多做一层缓冲**：
- sub 完成后结果**先进队列**
- **1 秒防抖间隔**——同一时段完成的多个 sub、通知合并成一次
- **指数退避重试**——通知失败自动重试

**好处**：父 Agent **不会被频繁打断**——多个 sub 差不多同时完成时、防抖把 N 次通知合并成 1 次。

**适用场景**：sub 数量多（10+）、完成时间不齐、父 Agent 需要"稳定推进"而不是"每完成一个就打断"。

### OpenCode 的分阶段编排

**先散后收**：
- **阶段 1**：最多派 3 个 **Explore Agent 并行**搜集信息
- **阶段 2**：切回**串行**、逐步推进

**跟带团队一样**：先让几个人各自去调研、等结果都回来了、再坐下来推进。

**适用场景**：**任务本身有阶段性**——探索阶段可以并行、决策阶段必须串行。

### 三者对比

| 做法 | 复杂度 | 打断父 Agent | 适用场景 |
|---|---|---|---|
| **同步注入（我们 / Claude Code）** | 最低 | 每 sub 完成打断一次 | 少量 sub、同步等待 OK |
| **Announce Queue（OpenClaw）** | 中 | 防抖后合并打断 | 多 sub 异步、避免频繁打断 |
| **分阶段编排（OpenCode）** | 最高 | 阶段切换时才推进 | 有明确探索 / 决策阶段 |

**我们选最简单的**——够用、直观。**如果以后场景需要异步通知**（比如 sub 跑好几分钟才完成、父 Agent 期间要处理别的事）、可以接入 Announce Queue 模式——**架构上留了空间**、`spawnParallel` 返回 Promise.all 结果、要改成"每完成一个塞进队列"只需要改这一处。

## 6. 用户看得见的两个接口

### spawn_agent 元工具：LLM 主动派

```ts
// src/tools/spawn-tools.ts
export function createSpawnTool(agentRegistry, getSpawnCtx): ToolDefinition {
  return {
    name: 'spawn_agent',
    description: '派一个子 Agent 去执行任务。子 Agent 有独立的上下文，完成后返回结果摘要。支持同时派多个子 Agent 并行执行。',
    parameters: {
      properties: {
        task: { type: 'string', description: '单个任务描述（与 tasks 二选一）' },
        tasks: { type: 'array', items: { type: 'string' }, description: '多个任务描述、并行执行（与 task 二选一）' },
      },
    },
    execute: async ({ task, tasks }) => { /* ... */ },
  };
}
```

**关键设计**：**task 和 tasks 二选一**——单任务走 spawnAgent、多任务走 spawnParallel、**LLM 自己决定并行度**。

### /agents REPL 命令：人查看

```
子 Agent 记录 (3):
    ✓ sub-1-elon (depth=1) — 用 read_file 读 CLAUDE.md...
      CLAUDE.md 是 Sakura Super Agent 项目的**约束清单**...
    ✓ sub-2-elov (depth=1) — 用 list_directory 看 src/...
      ...
    ✓ sub-3-elox (depth=1) — 用 read_file 读 package.json...
      ...

  活跃: 0/3 | 完成: 3 | 失败: 0
  最大深度: 1 | 最大并发: 3
```

**运维视角**——**跑完了什么、卡了什么、成功率多少**、一眼可见。

### /test-spawn：跳过模型的验证入口

**问题**：真实模型不一定会主动用 spawn_agent（下一节展开）——**"接线通不通"这个验证目标需要独立于模型的判断**。

**解决**：加一条 REPL 命令、**直调 spawnParallel** 路径：

```
/test-spawn         → 并行派 3 个 sub（读 CLAUDE.md / list src/ / read package.json）
/test-spawn single  → 只派 1 个 sub
```

**跳过模型选择工具的不确定性**——**直接验证架构**：彩色 tag 交错、独立 Step 编号、独立结果字符数、Promise.all 时序、compression ratio。

**开发时的价值极大**——修改 spawn.ts 或 registry 之后跑一遍 `/test-spawn`、立刻确认没搞坏。

## 7. 模型不一定会主动用 spawn_agent

**接线通了、跑 `/test-spawn` 全绿——但用户跟真实模型对话时、模型可能压根不用 spawn_agent**。

**测试实录**：让 Agent "并行查 React / Vue / Solid 三个框架的最新版本"——模型**没走 spawn_agent**、而是**在同一个 loop 里并行调了 3 次 web_search**、直接返回汇总。

**为什么**：
- 模型看到 web_search 和 spawn_agent 都能用
- 判断"三次搜索就够了、不用 fan-out"
- **单 Agent 也能完成、只是效率低**——模型倾向于**心智负担更低的路径**

**这不是 bug、是自然行为**——`spawn_agent` 是复杂概念、`web_search` 是简单动作、模型选简单的。

### 核心洞察：function calling 就是意图检测

**很多产品做"路由分类器"是白花力气的**——先跑 intent classifier、再 route 到 handler。

**实际上 function calling 本身就是最自然的意图检测机制**——**模型看到工具描述后自行决定调哪个**、这和"意图检测"是一回事、**只不过检测器是模型自身的推理能力**。

**所以最有效的做法**是把工具描述写清楚：

**层一：工具 description 加"何时用"**

原来的 spawn_agent description：
```
派一个子 Agent 去执行任务。子 Agent 有独立的上下文，完成后返回结果摘要。
```

**够短、但没说清"什么时候该用"**。改进版：

```
派子 Agent 执行独立子任务。**何时用**：任务包含 3+ 个独立的深度调研 / 需要读大量文件 / 每个子任务会烧 5k+ tokens 时——子 Agent 独立上下文、返回摘要给主 Agent、压缩比 10-20x。**何时不用**：简单查询（一次搜索能搞定）、任务之间有依赖。
```

**画清边界**是关键——写清"什么时候不用"、避免跟 web_search 抢占同一个决策槽。

**层二：SYSTEM 里加引导**

```
[Multi-Agent 引导]
涉及多个独立目标的调研 / 对比任务时、优先用 spawn_agent 并行执行。
```

**跟 skills / role 一样、都是"给模型的默认习惯"**。**放靠后位置**（sessionContext 前面）——SYSTEM 后面的指令模型注意力权重更高。

**两层加起来**——工具级 + 全局级双重钩子、主流模型的命中率大幅上升。

### 这是"新提示工程"

传统 prompt engineering 是**写好 prompt 让模型输出对的答案**——纯文本战场。

Function calling 时代是**写好工具描述让模型挑对的工具**——**description 就是 mini-prompt**。**你的 tools 列表就是模型的"选择菜单"**、菜名写不清、模型就点错菜。

## 8. 关键设计回顾

课程走到这里、subAgent 五个设计要点值得单独列出来：

- **① 隔离就是一个空的 messages 数组** —— 子 Agent 从零开始、不继承父 Agent 的对话历史
- **② 结果只取最后一条 assistant 消息** —— 几万 token 的探索过程压缩成几百 token 的结论
- **③ Promise.all 做并行** —— 多个子 Agent 同时执行、总耗时等于最慢的那个
- **④ 两道保护机制** —— 深度限制防递归、并发限制防资源耗尽
- **⑤ 同进程隔离** —— 零开销、启动快、覆盖大部分场景

**这五点合起来就是 SubAgent 系统的核心**——**独立上下文执行 + 结果压缩并回传 + 并行调度**。

## 9. 已知的坑与后续方向

### 9.1 timeout status 定义了但没用

```ts
// types.ts
export type SubAgentRun = { status: 'running' | 'completed' | 'error' | 'timeout'; ... };

// registry.ts fail()
run.status = 'error';   // ← 超时也归到 error、没设置 'timeout'
```

**修法**：`SubAgentRegistry.fail(id, error, kind?)`、超时时传 `kind = 'timeout'`。**当前教学项目未做**、`/agents` 展示时超时和普通错都是 ✗。

### 9.2 spawn_agent 的 description 太朴素

见第 7 节——**没写"何时用 / 何时不用"**、模型倾向于自己解决。**改进方向**是把 description 写成 mini-prompt。

### 9.3 SYSTEM 里没有 spawn 引导

**没有专门的 spawnGuide pipe**——需要在 prompt-pipes 里加一条、位置放靠后（cache 命中损失小 + 注意力权重高）。

### 9.4 没有 per-sub role / budget

sub 复用主的 role（当前全局 owner）——**sub 里 Agent 想跑什么都行**。生产要 per-sub role（比如"这个 sub 只有 guest 权限、不能 bash"）。

sub 的 budget 也是复用父 Agent 的——**理论上 sub 应该有独立预算**、否则一个坏 sub 能烧完整个池子。当前隐性防线是 `maxSteps = 30`——够用但不精确。

### 9.5 完全共享 hooks——sub 也走 auditLog

**当前 sub 里所有 tool 调用也过 auditLogHook**——**日志会翻倍**。生产可能要 per-sub hook 白名单、或者按 depth 过滤审计。

### 9.6 没有 worktree 隔离

见第 2 节——**只做了同进程隔离**、破坏性操作场景（大规模重构）没覆盖。方向明确、真实需求出现再做。

### 9.7 没有 Announce Queue

见第 5 节——**同步注入够用**、异步通知场景（长跑 sub、多 sub 完成时间不齐）没覆盖。改起来不难、`spawnParallel` 里替换成队列 push 就行。

### 9.8 fan-out 缩放天花板

**maxConcurrent = 3** 是硬编码的——**真实需求可能要 10 甚至 50**（比如"给这 100 个文件都加类型注释"）。生产要按任务类型 / 模型 rate limit / 部署环境动态调、当前教学项目一刀切。

---

## 回顾：从"一个 Agent"到"能派活的 Agent"

**这一篇的核心洞察**：

前面所有系统都在打造**"一个更强的 Agent"**——工具更多、记忆更长、通道更广、时机更准。**但归根结底、还是"一个"**。

**subAgent 是从"一个"到"一群"的分水岭**——一个主 Agent 可以变成协调者、把工作分派给多个 sub、每个 sub 独立跑、结果汇总回来。**这不是能力的加法、是数量和关系的跃迁**。

**几个可迁移的原则**：

1. **隔离先做最简单的**——同进程 + 独立数据结构、够用就行；worktree / 进程级隔离等真实需求出现再上
2. **深度防御 + 硬软双重约束**——EXCLUDED_TOOLS（源头挡）+ canSpawn（运行时挡）+ toolChoice: 'none'（API 层挡）+ prompt 引导（软引导）
3. **可观测性投资是并发系统的必需**——彩色 tag / 独立 Step 编号 / `/agents` 命令、debug 时救命
4. **function calling 就是意图检测——投资 description、别造分类器**
5. **部分成功 > 完全失败**——超时时提取已有结果、别整体 abandon

**subAgent 是这个项目最后一个能力扩展**——**加上它，你手上的 Agent 就从"能干活的助手"、变成了"能带团队的团队 leader"**。
