# Session 持久化：让易失的对话变成可恢复的资产

> 配套 [../README.md](../README.md) 的拓展阅读。前几篇讲 Agent 怎么"想清楚"（Loop / 工具 / MCP / ToolSearch），这篇讲 Agent 怎么"记得住"——为什么 REPL 里的 messages 数组是易失的、为什么选 JSONL 而不是 SQLite/JSON、崩溃安全的追加语义、以及"恢复不等于重放"的关键设计。

## 目录

- [0. 为什么需要 Session 持久化](#0-为什么需要-session-持久化)
- [1. 技术选型：为什么是 JSONL](#1-技术选型为什么是-jsonl)
- [2. SessionStore 的职责边界](#2-sessionstore-的职责边界)
- [3. 落盘时机：三种策略的取舍](#3-落盘时机三种策略的取舍)
- [4. 恢复的正确姿势：不是重放，是加载](#4-恢复的正确姿势不是重放是加载)
- [5. 一个真实的踩坑：`--continue` 传不进去](#5-一个真实的踩坑--continue-传不进去)
- [6. 已知的坑与后续方向](#6-已知的坑与后续方向)

## 0. 为什么需要 Session 持久化

看 [`src/index.ts`](../src/index.ts) 里的三个运行时状态：

```ts
let messages: ModelMessage[] = [];              // 对话历史
const budget: BudgetState = { used: 0, limit: 600000 };  // 预算
// registry.discoveredTools = new Set<string>();          // 已发现的 defer 工具
```

**都是进程内内存**。Ctrl+C 一按全没了，下次启动是白纸一张。

这在两个场景下会痛：

**场景一：中断即重来**

用户跟 Agent 讨论半天调试思路、Agent 已经调了几十次工具、终端不小心关了——**全丢**。重新启动要从头讲一遍。

**场景二：跨天延续**

昨天让 Agent 帮忙做的事今天要接着讨论，但 Agent "不认识"昨天的对话——**只能靠用户复述历史**。

**核心目标**：进程重启后，Agent 能从上次的位置继续。就像文档编辑器的"上次未保存"提示——**关掉重开，还在**。

## 1. 技术选型：为什么是 JSONL

对话持久化有多种方案。我们选 **JSONL（JSON Lines）**——每行一条 JSON 记录。

三个理由：

### 1.1 Append-only = 天然崩溃安全

这不是"文件系统很快"的意思，是"**没有一致性窗口**"的意思。看两种存储的写入语义对比：

```
方案 A：全量覆写 JSON 文件
  ├─ 读旧文件
  ├─ 内存里改
  ├─ 写新文件         ← 断电在这里，文件被截断成 0 字节
  └─ 完成
  代价：某一步崩溃可能损坏之前所有的历史

方案 B：JSONL append
  ├─ 打开文件（O_APPEND）
  ├─ 追加一行 JSON      ← 断电在这里，最多这一行不完整
  └─ 完成
  代价：只丢正在写的那一条，历史全保
```

关键在于 `O_APPEND` 是 POSIX 保证原子的——linux 上单次 `write()` ≤ PIPE_BUF (4096 字节) 是原子的，多个进程同时 append 也不会互相踩。**"最多丢最后一行"是 JSONL 的最大结构优势**。

### 1.2 可调试 = 可 grep、可 diff、可肉眼审阅

想象一个 debug 流程：

```bash
# 用 SQLite：得学它的 CLI 或写脚本
sqlite3 sessions.db "SELECT ... WHERE session_id = ...;"

# 用 JSONL：所有你已经熟悉的命令行工具直接用
tail -5 .sessions/default.jsonl | jq .message.role
grep '"tool_call"' .sessions/default.jsonl | jq -r '.message.content[0].toolName'
```

**JSONL 是"Unix philosophy 兼容"的存储格式**——`cat` / `jq` / `grep` / `tail` 全部适用。SQLite 要装 CLI + 学 SQL。

### 1.3 零依赖 = 真的零依赖

不只是"不用装 npm 包"，是**不用起独立进程/服务**。SQLite 虽然是嵌入式，但至少要装 `better-sqlite3` 这种 native module——涉及 platform-specific 编译。我们只用 `node:fs`——Node 内置，跨平台无痛。

### 1.4 参考：Claude Code 也这么做

Claude Code 的对话记录也是 JSONL 格式（它叫 transcript），支持 `--continue` 和 `--resume` 恢复历史会话。同样的选型出现在多个成熟项目里，是"这个规模用这个方案"的强信号。

## 2. SessionStore 的职责边界

代码在 [`src/session/store.ts`](../src/session/store.ts)，约 110 行做完五件事。

### 2.1 类的四个职责

```
┌─────────────────────────────────────────┐
│ SessionStore('default')                 │
│                                         │
│ 管理文件：.sessions/default.jsonl       │
│                                         │
│ 干四件事：                              │
│   1. 确保 .sessions/ 目录存在           │  ← 构造函数
│   2. append(msg)  — 写一行 JSON          │  ← 每次对话追加
│   3. load()       — 读回全部消息         │  ← 启动时恢复
│   4. exists()     — 有没有历史          │  ← 判断续会话 or 新会话
│                                         │
│ 加一个 debug 用的：                     │
│   5. stats()      — 元信息扫描           │  ← 启动时打印
└─────────────────────────────────────────┘
```

### 2.2 一行 JSON 长什么样

每次 `append(message)` 追加一行：

```json
{"type":"message","timestamp":"2026-08-29T10:23:45.123Z","message":{"role":"user","content":"查看 vercel/ai 的 issues"}}
```

三个字段：

- **`type: 'message'`** — 为将来扩展其他事件类型留的位（比如 `'system_note'`、`'checkpoint'`）
- **`timestamp`** — ISO 8601 时间戳，肉眼审阅时能对上会话时间轴
- **`message`** — 原封不动的 `ModelMessage`（AI SDK 的类型）——user / assistant / tool_call / tool_result 都是它

**存储层类型 vs 运行时类型的分离**：对外只暴露 `ModelMessage`，`SessionEntry` 只在 JSONL 里存在。这样将来加 checksum、加 event ordering，只改 `SessionEntry` 结构、不影响调用方。

### 2.3 三个非显然的实现选择

**a. 只用 `appendFileSync`，不 hold 文件句柄**

每次追加都是"打开 → 写一行 → 关闭"。看起来低效，但：
- 单会话一秒最多写几条，性能开销 << 0.1ms
- 不 hold 句柄 = 进程崩溃不会有"未 flush 的 buffer"
- 用 `O_APPEND` 语义，多进程同时写也不会互相踩

**b. `load()` 一次性全读进内存**

不是流式的、不做分页。前提假设：**单会话消息量在几 MB 以内**（几千条对话）。超过这个规模再考虑分页或 checkpoint 压缩。

**c. `stats()` 完整扫描，不缓存**

启动时调一次，性能不敏感——JSONL 几 KB 到几 MB，一次同步读毫秒级。**换来的是**：`stats()` 永远反映磁盘真实状态，跟内存里的 messages 无关。两个方法独立、都从磁盘读——`load()` 出问题不影响 `stats()` 的准确性。

### 2.4 `load()` 里的错误处理：留声音而非静默

看 [`store.ts:53-64`](../src/session/store.ts#L53-L64) 关键的一段：

```ts
try {
  const entry: SessionEntry = JSON.parse(line);
  if (entry.type === 'message') messages.push(entry.message);
} catch (err) {
  // 特意选 JSONL 是为了"最多丢最后一行"——但静默吞掉解析失败会让你不知道丢了什么
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(`[session] 跳过第 ${i + 1} 行（JSON 解析失败）：${reason}`);
}
```

**"跳过"没问题，但要留声音**。JSONL 的核心承诺是"最多丢最后一行"——如果静默吞掉所有解析失败，你不知道跳过了哪一行、为什么跳过，只知道恢复出来的对话"莫名少了几条"。这跟 JSONL 的调试友好优势直接冲突。

初版是 `catch { /* skip malformed lines */ }`——写完立刻改成 warn，因为静默 catch 会让 JSONL 的可调试性失效。

## 3. 落盘时机：三种策略的取舍

**JSONL 是"怎么存"的问题**。同样重要的是"**什么时候存**"——决定崩溃时会丢什么。

三种候选策略：

### 策略 1：只存 user 消息（最保守）

```
user 输入 → messages.push(user) → store.append(user)
agentLoop → messages.push(assistant + tool 若干)  ← 不落盘
```

恢复出来是残缺对话——只有用户说的话，没有 Agent 的回复。**语义错**，pass。

### 策略 2：agentLoop 结束后一次性 append 本轮所有新消息（简单）

```
beforeCount = messages.length
messages.push(user)
agentLoop(...)               ← 循环内部 push assistant + tool
for (i = beforeCount; ...) {
  store.append(messages[i])  ← 本轮结束一次性落盘
}
```

**优点**：改动小（只动 ask()），逻辑清晰。
**缺点**：agentLoop 里工具跑到一半崩了，这一轮完全没落盘——**副作用已经发生（GitHub issue 已建、文件已写），恢复时看不到**。

### 策略 3：agentLoop 内部每次 push 就 append（正确但侵入）

需要让 registry / agentLoop 拿到 store 引用、push 时同步 append。改动面大，agent/loop.ts 要加一个新参数。**崩溃只丢当前正在处理的那一条**。

### 我们的选择：策略 2

理由：

1. 我们在**教学项目**里，"崩溃语义完美"不是当前目标
2. 真实用户 REPL 里，Ctrl+C / exit 都是**优雅退出**——那时候 agentLoop 已经跑完了
3. **进程被杀** / **断电**这种硬崩溃场景，目前 Agent 也没有事务保护（工具已经跑了、副作用已经发生），少存一轮对话不是最严重的问题
4. 改动只在 `ask()` 里，不动 `agentLoop`

代码在 [`src/index.ts`](../src/index.ts) 的 `ask()` 里：

```ts
const beforeCount = messages.length;
messages.push({ role: 'user', content: trimmed });

// ... pipe.build + agentLoop 跑完 ...

// 本轮所有新消息（user + assistant 若干 + tool 结果若干）落盘
for (let i = beforeCount; i < messages.length; i++) {
  store.append(messages[i]);
}
```

**已知语义**：本轮 agentLoop 中途崩溃 → 本轮对话不落盘 → 重启看不到本轮。**用副作用已经发生换恢复完美**——这个 trade-off 在教学项目里可以接受，生产环境该做策略 3。

## 4. 恢复的正确姿势：不是重放，是加载

**最容易踩的坑**：恢复不等于重放。

看反面 case——"重放"式恢复：

```
1. load messages
2. 遍历每条 message
3. 如果是 tool_call → 再执行一次 tool
4. 如果是 assistant text → 打印出来
```

**这是错的**——工具已经跑过了、副作用已经落地：
- GitHub issue **已经创建**——不能再建一次
- 文件 **已经写好**——不能再覆盖
- API 请求 **已经付了钱**——不能再扣一次

正确的恢复是**"加载"** — 把历史 messages 塞进 `messages` 数组、模型看到完整历史、**继续对话**。工具在恢复时不再执行、副作用不再触发。

看 [`src/index.ts`](../src/index.ts) 的实现：

```ts
const isContinue = process.argv.includes('--continue');
let messages: ModelMessage[] = [];
if (isContinue && store.exists()) {
  messages = store.load();     // ← 只 load，不 replay
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
} else {
  console.log(`[Session] 新会话`);
}
```

**加载到 messages 就够了**——下次 `agentLoop(model, registry, messages, ...)` 时，模型看到完整历史，就像它从没停过。

### 一次实测

```
第一次跑：
  You: 上海今天的天气
  （Agent 调 get_weather，回复：多云，18-22°C）
  You: 适合去图书馆吗
  （Agent 回复：适合）
  You: exit

第二次跑（--continue）：
  [Session] 恢复会话，4 条历史消息
  You: 我们刚刚聊了什么
  （Agent 回复："上海天气 → 图书馆合适度"）
```

**Agent 准确复述了 3 轮对话**——说明历史 messages 真的进了 context，不只是加载了字符串。这就是"加载"式恢复的正确行为。

## 5. 一个真实的踩坑：`--continue` 传不进去

第一次接完 session 恢复后测试：

```bash
npm run start --continue
```

预期看到 `[Session] 恢复会话`——实际看到 `[Session] 新会话`。

**排查了三种可能，最终定位到**：npm 的参数吃掉了 flag。

`npm run start --continue` 里，npm 把 `--continue` **当作自己的 flag 吃掉了**——不会传给下游进程。**正确写法**：

```bash
npm run start -- --continue          # ← 关键是这个 --
# 或者绕开 npm：
npx tsx src/index.ts --continue
```

`--` 之前的所有 flag 都被认为是给 npm 自己的。虽然 npm 不认识 `--continue`，但它也不会转发给下游进程——除非用 `--` 明确告诉它"这后面的都是给 script 的"。

**这是 npm 的祖传坑**，几乎每个用 npm run 传参的项目都踩过。记下来：

> 用 npm run 给下游 script 传参，永远加 `--` 分隔。

## 6. 已知的坑与后续方向

**1. `budget` 和 `discoveredTools` 不持久化**

现在只存 messages。重启后：
- `budget.used` 从 0 开始——预算实际上被重置
- `discoveredTools` 清空——用户续会话后，defer 工具需要重新走 tool_search 发现

修法：在 SessionStore 里加一个 meta 文件（`.sessions/default.meta.json`），存这两个状态。已知限制，后续做。

**2. 策略 2 的崩溃窗口**

agentLoop 中途崩溃 = 本轮不落盘。想要更严格的恢复语义，走策略 3（每次 push 就 append）。当前是教学项目取舍。

**3. 单会话文件、单会话粒度**

现在只有一个 `default.jsonl`。想要"每个项目独立会话" / "多会话切换"，得加：
- session id 生成策略（比如按 cwd 哈希）
- `/new` / `/switch <id>` REPL 命令
- session 列表 UI

**4. 无淘汰、无归档**

长期跑同一个会话，`default.jsonl` 会一直涨。生产上得做：
- 按大小滚动（超过 10 MB 归档）
- 按时间归档（30 天前的挪到 archive/）
- 关键节点做 checkpoint（比如任务完成时打一个"这里之前的历史可以忽略"标记）

**5. 无并发保护**

现在假设单进程 REPL。如果两个 REPL 同时启动、同时写 `default.jsonl`——因为 `O_APPEND` 是原子的，**不会数据损坏**，但**消息交错**（A 的 user 出现在 B 的对话中间）。要多会话隔离，见坑 3。

**6. Windows CRLF 兼容**

现在 `content.split('\n')` 在 Windows 上如果 JSONL 被别的工具改成 CRLF 换行，每行末尾会带 `\r`——被 `JSON.parse` 认为格式错误。跨平台防御一行代码：`content.split(/\r?\n/)`。目前 Mac 用不上，留作已知问题。

---

## 相关文档

- [prompt-pipe-design.md](prompt-pipe-design.md) — Prompt Pipe 模式：sessionContext segment 让"恢复历史"这件事在 prompt 里也能被感知到
- [tool-search-design.md](tool-search-design.md) — ToolSearch：`discoveredTools` 是"应该持久化但目前没有"的典型案例
- [agent-loop-protections.md](agent-loop-protections.md) — Agent Loop 三道防线，跟 session 状态正交
