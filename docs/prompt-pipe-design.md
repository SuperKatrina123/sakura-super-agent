# Prompt Pipe：模块化 SYSTEM 组装

> 配套 [../README.md](../README.md) 的拓展阅读。前面几篇讲 Agent 的能力（Loop / 工具 / MCP / ToolSearch / Session），这篇讲 Agent 的"人设"是怎么组装出来的——为什么 SYSTEM 字符串会变成屎山、Pipe 模式怎么拆解、`segment.order` 为什么决定 cache 命中率、以及每个默认 segment 的设计取舍。

## 目录

- [0. 字符串屎山：所有真实项目都会撞的墙](#0-字符串屎山所有真实项目都会撞的墙)
- [1. 核心抽象：PipeFn + PromptContext](#1-核心抽象pipefn--promptcontext)
- [2. 顺序即 Cache 策略](#2-顺序即-cache-策略)
- [3. 四个默认 segment 的设计](#3-四个默认-segment-的设计)
- [4. 职责分离：registry 提供数据，segment 负责格式化](#4-职责分离registry-提供数据segment-负责格式化)
- [5. Debug 输出：让隐性行为可见](#5-debug-输出让隐性行为可见)
- [6. 已知的坑与后续方向](#6-已知的坑与后续方向)

## 0. 字符串屎山：所有真实项目都会撞的墙

看这个项目的**演化轨迹**——SYSTEM 字符串的变化：

**第一版**（[history/](../history/) 里的早期快照）：

```ts
const SYSTEM = '你是一个 AI 助手。';
```

**第二版**（加了 Vibe Coding）：

```ts
const SYSTEM = `你是一个 Agent，一个专注于软件开发的 AI 助手。

## Vibe Coding 模式（当用户要求"做一个 XX 网页/应用/小程序"时启用）
项目里有一个预置的 app/ 目录...
（20+ 行技术约束）
`;
```

**第三版**（加了 ToolSearch defer 目录）：

```ts
const SYSTEM = `你是 Super Agent...`;

// ask() 里每轮拼接：
const dynamicSystem = SYSTEM + registry.getDeferredToolSummary();
```

到第三版已经有味道了——`SYSTEM` 是静态的、defer 目录是动态的，两段用 `+` 拼在一起。**再往下加**会发生什么？

生产环境要加的 prompt 可不止这些。随着功能越来越复杂，会需要加入：

- **环境信息**：当前工作目录、git 分支、时间
- **用户偏好**：从 memory 里读的"我喜欢简洁输出"
- **会话上下文**：当前会话已进行 6 轮、累计消耗 5879 tokens
- **权限约束**：这个会话不允许 `bash` 执行 `rm`
- **条件性 segment**：Vibe Coding 只在"做应用"时启用

每加一个功能就往字符串里塞一段，而且有些 prompt 片段是**按需添加**的。这就会变成：

```ts
const SYSTEM = `你是 Super Agent。
${isVibeCoding ? vibeCodingRules : ''}
${hasMemory ? memoryText : ''}
${discoveredTools.size > 0 ? deferredSummary : ''}
${gitBranch ? `当前 git 分支: ${gitBranch}` : ''}
${sessionMessageCount > 0 ? `已有 ${sessionMessageCount} 条历史` : ''}
${bashRestricted ? '禁止调用 bash 执行 rm 命令' : ''}
`;
```

**几个月后这里会变成 AI 都改不动的巨型屎山代码**。

修改一个 segment 的呈现方式，得在字符串中间找到那一行；加一个新 segment，得决定"塞在哪一行之间"；调试"某个条件为什么没生效"，得肉眼扫描三元表达式。

## 1. 核心抽象：PipeFn + PromptContext

Prompt Pipe 模式的核心：**把 system prompt 拆成独立的模块，每个模块是一个纯函数**——接收运行时上下文，自己决定要不要出现在最终 prompt 中。

### 1.1 类型定义

[`src/context/prompt-builder.ts`](../src/context/prompt-builder.ts)：

```ts
export interface PromptContext {
  toolCount: number;
  deferredTools: Array<{ name: string; hint?: string }>;
  sessionMessageCount: number;
  sessionId: string;
}

type PipeFn = (ctx: PromptContext) => string | null;
```

**一个函数决定两件事**：
- 返回 `null` = 这个 segment 本轮不出现（disabled）
- 返回 `string` = 这个 segment 的内容

比"`enabled(ctx)` + `render(ctx)` 双方法"更简洁——少一次求值、少一处不一致的可能（`enabled=true` 但 `render=""`）。

### 1.2 声明式 API

```ts
const promptBuilder = new PromptBuilder()
  .pipe('coreRules', coreRules())
  .pipe('toolGuide', toolGuide())
  .pipe('deferredTools', deferredTools())
  .pipe('sessionContext', sessionContext());

const dynamicSystem = promptBuilder.build(ctx);
```

fluent API——加新 segment 就是加一行 `.pipe()`。不用改 `build()` 内部、不用维护"顺序数组"、不用改字符串模板。

### 1.3 三个非显然的收益

**a. 纯函数 = 可测试**

任何 segment 都能单独 `render(mockCtx)` 断言输出：

```ts
expect(sessionContext()({ sessionMessageCount: 0, ... })).toBe(null);
expect(sessionContext()({ sessionMessageCount: 6, ... })).toContain('6 条');
```

**b. 条件语义变成结构**

对比字符串屎山里的三元表达式：

```ts
// ❌ 字符串屎山：条件散落在插值里
`${sessionMessageCount > 0 ? sessionText : ''}`

// ✅ Pipe：条件在 segment 内部
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;   // ← 条件在这里
    return `[会话信息] ...`;
  };
}
```

**条件逻辑和内容在同一个模块里，加新 section 零摩擦**——这是 Pipe 模式的核心红利。

**c. 空字符串也当 disabled**

看 `build()` 的实现：

```ts
if (result !== null && result !== '') {
  sections.push(result);
}
```

空串 (`""`) 也跳过——避免最终 prompt 里出现连续的 `\n\n\n`。segment 内部不用手动检查"要不要 return null"，返回空串也是正确表达。

## 2. 顺序即 Cache 策略

Prompt Cache 让重复的 prompt 前缀命中缓存、只按 10% 成本计费。**Pipe 模式下，segment 的顺序直接决定 cache 命中率**。

### 2.1 Cache 的前缀匹配特性

```
prompt = [ segment_1, segment_2, segment_3, ..., segment_N ]
                            ↑
                    如果这一段变化
                            ↓
        前面的 cache 命中，从这里开始失效
```

**关键**：cache 前缀匹配**只到"第一个变化的字节"就停**。所以把不变的挤到前面，能让 cache 前缀最大化。

### 2.2 变化频率的四个层次

按"多久变一次"给 segment 分档：

| 频率 | 例子 | 位置 |
|---|---|---|
| **永远不变** | `coreRules`（身份声明）、`toolGuide`（工具数量提示） | **最前** |
| **会话级不变** | 工具目录（`deferredTools`）、`cwd`、用户偏好 | **中间** |
| **每轮可能变** | 会话上下文（`sessionContext`：消息数递增）、token 剩余 | **中后** |
| **每步可能变** | 步骤 hint、动态错误反馈 | **最后** |

### 2.3 我们的顺序

看 [`src/index.ts`](../src/index.ts) 里的最终顺序：

```ts
const promptBuilder = new PromptBuilder()
  .pipe('coreRules', coreRules())            // 永远不变——cache 稳稳命中
  .pipe('toolGuide', toolGuide())            // 工具数量基本固定，变化很少
  .pipe('deferredTools', deferredTools())    // 所有工具列表基本固定，放中间
  .pipe('sessionContext', sessionContext()); // 每次启动都不同（历史消息数），放最后
```

### 2.4 一个初版踩过的顺序错误

第一版写的顺序：

```ts
.pipe('coreRules', ...)
.pipe('toolGuide', ...)
.pipe('sessionContext', ...)   // ← 放错了：每次启动都不同的东西放中间
.pipe('deferredTools', ...)    // ← 放错了：基本固定的东西放最后
```

看似"逻辑分组更整齐"（会话相关 vs 工具相关），但**破坏了 cache**：

- `sessionContext` 每次启动 messageCount 都不同 → 每次启动这一段都变化
- **变化点在中间** → 后面的 `deferredTools`（3840 chars 的大段）也失效
- 净损失：每次启动多消耗几千 tokens 的 cache miss

**正确的直觉**：把变化频率高的往后放，让变化频率低的（尤其是内容长的）尽量落在 cache 命中区。**`deferredTools` 内容大且相对稳定，必须尽量往前**。

## 3. 四个默认 segment 的设计

[`src/context/segments.ts`](../src/context/segments.ts) 定义了四个默认 segment，都是**工厂函数返回 PipeFn**——将来给 segment 传参数（比如 `coreRules(persona)` 定制人格）时不用改 API。

### 3.1 coreRules：身份 + 工具搜索引导

```ts
export function coreRules(): PipeFn {
  return () => `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。
如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。`;
}
```

**三个决策**：

- **不加"说话风格"约束**（简洁、代码示例、倾向询问）——模型默认行为够用，加了反而占 token
- **必须保留 tool_search 引导**——否则模型永远不会主动搜工具，defer 机制就废了（见 [tool-search-design.md](tool-search-design.md)）
- **完全静态**——最前面，cache 稳定

### 3.2 toolGuide：工具数量提示

```ts
export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null;
    return `当前 registry 里有 ${ctx.toolCount} 个工具可用。`;
  };
}
```

**微妙的决策**：为什么工具数为 0 时不出现？

- 工具数为 0 是**极端情况**（MCP 全失败、内置全没注册）——这时候告诉模型"你有 0 个工具可用"是误导
- 直接不出现，模型自己会从空的 tools 参数里得到正确信号

**"缺失即信号"**——不是所有信息都要说出口。

### 3.3 deferredTools：延迟工具目录

```ts
export function deferredTools(): PipeFn {
  return (ctx) => {
    if (ctx.deferredTools.length === 0) return null;
    const lines = ctx.deferredTools.map(t => {
      const hint = t.hint ? ` — ${t.hint}` : '';
      return `  - ${t.name}${hint}`;
    });
    return `以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`;
  };
}
```

**这是最大的一段**——40 个 defer 工具的目录大约 3840 chars。放在**倒数第二位**（`sessionContext` 之前）——因为它相对稳定（工具列表不变、只有 `discoveredTools` 增长会让它缩短），比 `sessionContext` 变化频率低。

**跟 ToolSearch 章节的隐性契约**：`ctx.deferredTools` 由 `registry.getDeferredTools()` 提供，返回的是**已过滤掉已发现工具的列表**。模型看到的目录随着对话进行会**缩短**——这跟 [tool-search-design.md §5](tool-search-design.md#5-prompt-cache-的隐性权衡最重要的一节) 讨论的 cache 权衡直接相关。

### 3.4 sessionContext：会话上下文

```ts
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 会话 ${ctx.sessionId} 已有 ${ctx.sessionMessageCount} 条历史消息。`;
  };
}
```

**这个 segment 只在恢复历史会话时才会出现**（`sessionMessageCount > 0`）。新会话时它返回 `null`，不占任何 prompt 空间。

这就是 Pipe 模式的好处——**条件逻辑和内容在同一个模块里**，加新 section 零摩擦。跟前一版比：

```ts
// ❌ 字符串屎山
`...${sessionMessageCount > 0 ? `[会话信息] 已有 ${sessionMessageCount} 条` : ''}`

// ✅ Pipe
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 会话 ${ctx.sessionId} 已有 ${ctx.sessionMessageCount} 条历史消息。`;
  };
}
```

**为什么放最后**：`sessionMessageCount` 是最容易变的字段——每加一条消息就 +1。放最后能让前面所有 segment 的 cache 命中率不受它影响。

## 4. 职责分离：registry 提供数据，segment 负责格式化

有一个初版设计写错了——把已经格式化好的字符串塞进 Context：

```ts
// ❌ 初版：Context 里直接放格式化好的字符串
export interface PromptContext {
  deferredToolSummary: string;   // ← registry.getDeferredToolSummary() 拼好的整段
}

// segment 极简
export function deferredTools(): PipeFn {
  return (ctx) => ctx.deferredToolSummary || null;
}
```

看起来更省事——segment 一行代码。但**职责混淆**：
- **想改 defer 目录的格式**（表格 / 分组 / top-N），得改 `registry.getDeferredToolSummary()`
- **registry 变成了"prompt 格式化器"**——本来是"工具管理器"的它，多了一个跟工具管理无关的职责

改正后：

```ts
// ✅ Context 里放原始数据
export interface PromptContext {
  deferredTools: Array<{ name: string; hint?: string }>;
}

// segment 负责格式化
export function deferredTools(): PipeFn {
  return (ctx) => {
    if (ctx.deferredTools.length === 0) return null;
    const lines = ctx.deferredTools.map(t => { ... });
    return `以下工具...\n${lines.join('\n')}`;
  };
}
```

**职责边界**：
- **registry** 提供**数据**（`getDeferredTools(): {name, hint}[]`）
- **segment** 负责**格式化**（这些数据长啥样进 prompt）

将来想改格式——只动 segment 不动 registry。将来 registry 有多个消费方（除了 prompt 还有 UI 展示）——数据结构复用、格式化各自定制。

**这是"数据 vs 视图"的经典分离**——在 prompt 领域体现为"registry 是数据源、segment 是视图"。

## 5. Debug 输出：让隐性行为可见

Prompt Pipe 的一个非显然价值——**让"哪些 segment 出现了、多长"变得可见**。

### 5.1 debug 方法

[`prompt-builder.ts`](../src/context/prompt-builder.ts) 里的 `debug()`：

```ts
debug(ctx: PromptContext): void {
  console.log('\n=== Prompt Pipe Debug ===');
  let total = 0;
  for (const { name, fn } of this.pipes) {
    const result = fn(ctx);
    if (result !== null && result !== '') {
      console.log(`  [ON]  ${name}: ${result.length} chars`);
      total += result.length;
    } else {
      console.log(`  [OFF] ${name}`);
    }
  }
  console.log(`  ────────────────────────`);
  console.log(`  Total: ${total} chars`);
  console.log('========================\n');
}
```

### 5.2 三种关键输出对比

**新会话**（`npm start`）：

```
=== Prompt Pipe Debug ===
  [ON]  coreRules: 87 chars
  [ON]  toolGuide: 24 chars
  [ON]  deferredTools: 3840 chars
  [OFF] sessionContext                   ← 新会话，跳过
  ────────────────────────
  Total: 3951 chars
========================
```

**恢复会话**（`npm run start -- --continue`）：

```
=== Prompt Pipe Debug ===
  [ON]  coreRules: 87 chars
  [ON]  toolGuide: 24 chars
  [ON]  deferredTools: 3840 chars
  [ON]  sessionContext: 30 chars       ← 恢复历史，出现
  ────────────────────────
  Total: 3981 chars
========================
```

**Total 差 30 chars 恰好等于 sessionContext 那段的长度**——说明 pipe 里没有隐性开销、每段是独立叠加的。

### 5.3 `[OFF]` 也列出来的意义

初版 debug 只列 `[ON]`——把 disabled 的 segment 藏起来。**改正后**保留 `[OFF]`：

- 帮 debug"为什么这个 segment 没出现"（一眼看到"哦，sessionContext 是 disabled"）
- 让"注册的 segment 数"和"当前生效的 segment 数"分开可见——**看到什么是可能出现的 vs 什么真的出现了**

### 5.4 启动时打一次 vs 每轮打

现在只在启动时打一次。三个选项的取舍：

| 时机 | 优点 | 缺点 |
|---|---|---|
| **启动一次** | 干净、能验证 pipe 装对了 | 看不到 defer 目录随 discoveredTools 收缩 |
| **每轮打** | 能看到实时变化 | 输出吵、影响读日志 |
| **env 变量控制** | 灵活 | 多一个开关要记 |

我们选**启动一次**——够验证配置正确、每轮的动态变化可以在 `ask()` 里手动加一行 `promptBuilder.debug(ctx)` 观察。

## 6. 已知的坑与后续方向

**1. Segment 无参数**

现在 `coreRules()` / `toolGuide()` 等都是无参工厂。如果想"给不同角色配不同 coreRules"（比如 code agent vs research agent），需要改成 `coreRules(persona: 'coder' | 'researcher')`。当前 API 支持，只是没用上。

**2. 没有 memory segment**

用户偏好（"我喜欢简洁输出"、"回复用中文"）目前只能靠用户每次说。想做的话需要：
- SessionStore 加 meta 存偏好
- 加一个 `userPreferences()` segment，从 store 读

跟 [session-persistence.md §6](session-persistence.md#6-已知的坑与后续方向) 的"budget/discoveredTools 不持久化"是同一个坑——meta 层缺失。

**3. 没有条件启用的 vibeCoding segment**

上一版 SYSTEM 里的 Vibe Coding 约束被删掉了。想加回来的正确方式是做成 segment：

```ts
export function vibeCoding(): PipeFn {
  return (ctx) => {
    if (!ctx.userIntent?.includes('vibe coding')) return null;   // ← 条件启用
    return vibeCodingRules;
  };
}
```

需要 Context 加 `userIntent` 字段——目前没做。

**4. Segment 之间的顺序是硬编码**

`.pipe()` 的调用顺序决定 segment 顺序。如果想让 segment 声明"我应该在 X 之前"——需要引入依赖排序或 priority 字段。当前 4 个 segment 硬编码顺序够用，规模上去后可能要改。

**5. Debug 只在启动打**

见 §5.4。每轮的实时变化目前看不到。生产上应该加 env 变量控制"每轮打不打"。

**6. 没有 pipe 单元测试**

`segments.ts` 里的每个 segment 都是纯函数，理论上极易测试。但项目目前没有测试框架——留作后续。加测试的价值：改 segment 时能立即知道有没有回归。

---

## 相关文档

- [session-persistence.md](session-persistence.md) — `sessionContext` segment 的数据源
- [tool-search-design.md](tool-search-design.md) — `deferredTools` segment 的来源；也讲了动态改 tools 参数的 cache 副作用（跟本篇的 cache 讨论互补）
- [mcp-integration-practice.md](mcp-integration-practice.md) — MCP 工具是 defer 工具的主力来源
- [agent-loop-protections.md](agent-loop-protections.md) — Agent Loop 三道防线，跟 prompt 组装正交
