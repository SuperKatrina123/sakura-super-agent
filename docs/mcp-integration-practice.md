# MCP 集成实践：从 stdio 传输到统一工具管线

> 配套 [../README.md](../README.md) 的拓展阅读。README 讲的是 Agent 的骨架；这篇讲**把 MCP（Model Context Protocol）接进来**——为什么 stdio 是 MCP 的默认传输、`MCPClient` 怎么用 400 行以内实现一个真实可用的 client、`ToolRegistry.registerMCPServer` 如何让 MCP 工具"零改动"融入 Agent Loop、以及三层降级链路的现实必要性。

## 目录

- [0. 为什么 Agent 需要 MCP](#0-为什么-agent-需要-mcp)
- [1. 协议底座：JSON-RPC 2.0 over stdio](#1-协议底座json-rpc-20-over-stdio)
- [2. MCPClient 实现要点](#2-mcpclient-实现要点)
- [3. 挂进 ToolRegistry：前缀避冲突、闭包做翻译](#3-挂进-toolregistry前缀避冲突闭包做翻译)
- [4. 三层降级：真实 → Mock → 无 MCP](#4-三层降级真实--mock--无-mcp)
- [5. 端到端跑一次会看到什么](#5-端到端跑一次会看到什么)
- [6. 手写 vs 官方 SDK：抽象层选对位置的最强证据](#6-手写-vs-官方-sdk抽象层选对位置的最强证据)
- [7. 已知的坑与后续方向](#7-已知的坑与后续方向)

## 0. 为什么 Agent 需要 MCP

Agent 的能力上限被**工具的丰富度**决定。前面几篇把内置工具（文件读写、bash、grep、web fetch）做到了 12 个，够跑 vibe coding、够做 code agent，但很快会撞墙——用户想让 Agent 查 GitHub issue、读 Linear ticket、发 Slack 消息，每一个都要你手写一遍适配器、维护一份 API 变更。

MCP 的存在就是把这件事**外部化**：任何工具方按 MCP 协议实现一个 server，任何 client（Claude Desktop、Cursor、我们的 Agent）都能直接接上。目前生态里已经有几百个 server，从 GitHub、GitLab、Postgres 到 Puppeteer、Blender。

对我们这个"从零构建 Agent"的项目来说，接 MCP 有三个价值：

1. **马上多 26 个工具**（一个 GitHub server 就够）
2. **走通协议层**——JSON-RPC + stdio 是 Agent 与外部进程通信的通用模式，MCP 只是其中一种应用
3. **验证 ToolRegistry 的解耦是否成立**——如果加一个新的工具来源需要改 Agent Loop，抽象就失败了；如果一行都不改就工作，抽象就成立

结论先说：Agent Loop 一行没改，`toAISDKFormat()` 一行没改，只在 [`src/tool-registry.ts`](../src/tool-registry.ts) 加了 `registerMCPServer` 和 `closeAllMCP` 两个方法，MCP 工具就跟内置工具站在了同一起跑线。

## 1. 协议底座：JSON-RPC 2.0 over stdio

MCP 的传输规范列了两种：**stdio** 和 **Streamable HTTP**。生态里绝大部分 server 用的是 stdio——本地进程、零配置、无鉴权，装完 `npx` 就能跑。这一节展开讲 stdio 的三个关键属性。

### 1.1 消息格式：newline-delimited JSON

每条消息一行 JSON，以 `\n` 结尾。不是 length-prefixed、不是 SSE，就是最朴素的按行切分。

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}\n
{"jsonrpc":"2.0","id":1,"result":{...}}\n
{"jsonrpc":"2.0","method":"notifications/initialized"}\n
```

Client 侧的读取实现就是一个 `readline.createInterface({ input: process.stdout })`——见 [`src/mcp/client.ts`](../src/mcp/client.ts) 第 45 行。

### 1.2 stdout 是协议专属通道

Server 的 stdout **只能写 JSON-RPC 消息**。任何调试输出——`console.log`、`print`、库的默认日志——都会毒化协议流，client 解析时直接崩。

正确的做法是所有日志走 **stderr**。我们的真实测试里，`@modelcontextprotocol/server-github` 启动时会往 stderr 打一行：

```
[server-github stderr] GitHub MCP Server running on stdio
```

如果 client 静音了 stderr（[`client.ts`](../src/mcp/client.ts) 曾经的 `this.process.stderr?.on('data', () => {})`），一旦 server 出问题——token 无效、rate limit、内部报错——你会**啥都看不到**，只会看到 `MCP request timeout: initialize` 这种含糊错误。

所以现在的实现把 stderr 前缀化后透传（[`client.ts:43-45`](../src/mcp/client.ts#L43-L45)）：

```ts
this.process.stderr?.on('data', (chunk) => {
  process.stderr.write(`  [${this.serverName} stderr] ${chunk}`);
});
```

**这个改动的价值只在"出问题时"才显现**——正常跑一无所见，一旦 server 挂了，前缀化日志能让你 3 秒定位问题源头。

### 1.3 请求-响应可能乱序：id-map 是必需的

JSON-RPC 允许 server 并发处理请求。你连发 3 个 `tools/call`，server 完全可能"谁算完谁先回"——快的工具先返回、慢的后返回。加上 server 还可能主动推 notification（progress、resource 变化），notification 没有 `id`，跟你发的请求响应交错在一起。

所以 client 必须维护 **`id → { resolve, reject }` 的 pending map**，靠 `id` 匹配响应——不能用"发一个等一个"的同步模式。见 [`client.ts:19-22`](../src/mcp/client.ts#L19-L22)：

```ts
private pending = new Map<number, {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}>();
```

收到响应时按 id 找回 Promise（[`client.ts:46-61`](../src/mcp/client.ts#L46-L61)）：

```ts
this.rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  } catch { /* ignore non-JSON */ }
});
```

`msg.id === undefined` 的 notification 天然被这个 `if` 过滤掉——目前够用，未来要支持 progress 就在这里加分支。

## 2. MCPClient 实现要点

代码在 [`src/mcp/client.ts`](../src/mcp/client.ts)，一共 110 多行，实现 4 个 public 方法：`connect`、`listTools`、`callTool`、`close`。这里挑三个非平凡的点讲。

### 2.1 握手是两步，第二步是 notification

MCP spec 要求握手分两步：

```
Client → initialize (request，等响应)
Server → initialize response (能力协商)
Client → notifications/initialized (通知，无 id，无响应)
```

第三步是 **notification**（没有 `id`、server 不回复），告诉 server "我准备好了，可以正常收请求了"。漏了这步，严格的 server 会拒绝后续请求。

代码里就是 [`client.ts:63-72`](../src/mcp/client.ts#L63-L72)：

```ts
await this.send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'super-agent', version: '0.5.0' },
});

this.process.stdin!.write(JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
}) + '\n');
```

第一行 `await` 了——是 request，要等响应；第二行没 `await`，因为 notification 没响应可等，直接写进 stdin 就当发完。

### 2.2 超时是防卡死，不是防慢

`send()` 里 [第 78 行](../src/mcp/client.ts#L78) 挂了个 60 秒超时。为什么这么长？

第一次跑 `npx -y @modelcontextprotocol/server-github` 时，npm 要下载 server 包（几十 MB），实际发生的事情是：

```
Client 发 spawn        ← 立刻返回
Client 发 initialize   ← 已经进 stdin buffer 了
                       ← 但 npx 还在下载，server 根本没启动
                       ← server 启动后从 buffer 读到 initialize
                       ← server 处理，返回响应
Client 收到响应        ← 可能 30 秒后
```

15 秒不够。设 60 秒是给"首次下载 + 冷启动"留余量。第二次跑 npm 已经缓存了包，握手 1 秒内完成。

**超时后的行为**：Promise reject、pending map 里把这个 id 删掉。如果 server 事后真回来一条这个 id 的响应，`pending.has(id)` 返回 false，静默丢弃——行为正确，但生产上应该记一条 warning 帮定位"server 特别慢"。

### 2.3 close 只 kill 进程，不做协议关闭

MCP spec 里有个 `shutdown` notification，可以优雅通知 server 收摊。我们的 [`close()`](../src/mcp/client.ts#L110-L113) 只做了两件事：`rl.close()` 关行读取器、`process.kill()` 杀子进程。

选简单版是因为**stdio 传输的 server 收到 SIGTERM/stdin EOF 都会退出**，多数 server 也没实现 `shutdown` 通知。等生产上真需要 graceful shutdown（server 有内存状态要落盘、有连接要断开）再补也不迟。

## 3. 挂进 ToolRegistry：前缀避冲突、闭包做翻译

MCP 工具进 registry 走 [`ToolRegistry.registerMCPServer`](../src/tool-registry.ts)（[第 46 行](../src/tool-registry.ts#L46)）。核心是三件事。

### 3.1 前缀避冲突：`mcp__<serverName>__<toolName>`

GitHub server 暴露 `list_issues`，Jira server 也可能叫 `list_issues`——直接注册会互相覆盖。所以 registry 加了强制前缀：

```ts
const prefixed = `mcp__${serverName}__${tool.name}`;
```

这个格式跟 Claude Code 保持一致。模型看到 `mcp__github__list_issues` 就知道这是外部工具，System Prompt 里也方便按前缀引用。

上限校验（OpenAI/Anthropic 的 tool name 上限是 64 字符）：超长的直接跳过，警告一条。同名（含前缀）也跳过——**不静默覆盖**是这里唯一的正确策略。

### 3.2 闭包做翻译：本地看到前缀名，发给 server 是原名

前缀只在**本地生效**——server 不认识加了前缀的名字，`tools/call` 时必须发原名。所以 execute 用闭包捕获两个东西：

```ts
const toolClient = client;
const originalName = tool.name;

this.register({
  name: prefixed,                                    // ← 模型看到的名字
  execute: async (input) => toolClient.callTool(originalName, input),  // ← 转发时用原名
});
```

这个"翻译层"只在 client-registry 边界存在。模型 → 前缀名；registry → 闭包脱前缀；client → 协议原名——三个层次一路脱掉包装。

### 3.3 默认属性的取舍

MCP 工具是**黑盒**——registry 拿到的只有 name/description/inputSchema，看不出这个工具是否只读、有没有副作用。所以默认属性走保守值：

| 字段 | 默认 | 理由 |
|---|---|---|
| `isConcurrencySafe` | `true` | MCP 是跨进程调用，本地读写锁保护不到 server 那边——串行化只会浪费 server 的并发能力 |
| `isReadOnly` | `false` | 工具可能改远端状态（`create_issue`、`delete_repo`），保守设为读写，让上层的只读检查不误判 |
| `maxResultChars` | 3000 | 走全局默认，跟内置工具同一套截断策略 |

**`isConcurrencySafe: true` 是有意的宽松**——`create_issue` 严格说应该串行，但 MCP 层没有描述副作用的字段，无法自动判断。生态里公认的两种解法：

- 挂 server 时传白名单：`registerMCPServer('github', client, { unsafe: ['create_issue'] })`
- 按名称启发式：`create_/update_/delete_/write_` 前缀判定为写操作

现在两个都没做，属于**已知限制**——留给权限系统那一篇统一处理。

### 3.4 description 加 `[MCP:xxx]` 前缀

```ts
description: `[MCP:${serverName}] ${tool.description}`,
```

这个前缀**模型也会看到**——description 就是喂给模型的 tool schema 一部分。但没关系：

- 对模型是无害噪声，只增加几个 token
- 对**调试**是溯源信号——出问题时看 assistant message 里的 tool description 就能定位来自哪个 server

替代方案是"description 里不加、内部维护 name→server 的 map"。当前做法把信息内嵌，代价小、收益直接。

## 4. 三层降级：真实 → Mock → 无 MCP

启动流程在 [`src/index.ts` 的 `connectMCP()`](../src/index.ts) 里，逻辑分三层：

```
真实 GitHub Server（有 token + 能 spawn）
    ↓ 失败（token 无效、npx 超时、协议不兼容等）
Mock GitHub Server（本地进程内假数据）
    ↓ Mock 也没配（几乎不会）
Agent 继续跑，只是没有 GitHub 能力
```

三层降级不是过度工程，是**stdio 传输的必然代价**。每一层都有独立的失败模式：

| 层 | 失败原因 | 症状 |
|---|---|---|
| `spawn` | 环境不支持子进程、`npx` 不存在 | `MCP request timeout: initialize`（spawn 静默失败） |
| `initialize` 握手 | 网络慢导致下载超时、server 崩溃、协议版本不兼容 | 60s 超时 |
| `tools/call` 运行时 | GitHub API 挂了、token 过期、rate limit | 单次调用失败但不影响 Agent |

**每一层的失败都不是"bug"，是"跑久了必然遇到"**。GitHub API 一年至少几次全球性 outage、npm registry 偶尔慢到 30 秒、你换了 token 忘更新环境变量——这些都是运维现实。

三层降级的价值在于：**Agent 的核心能力永远可用**。哪怕 MCP 全废，"帮我读 README"、"算个数学题"、"启动 preview" 依然能工作——因为这些是内置工具，不经过 MCP 链路。

### 4.1 Mock 存在的两个 non-obvious 价值

Mock 看起来是"没 token 时的兜底"，其实有两个更重要的价值：

**1. 测试基础设施**：任何时候你改 `registerMCPServer` 逻辑，都能通过 `MockMCPClient` 快速验证——不用真的连 GitHub、不消耗 API 配额、不用 3-5 秒启动开销。开发迭代闭环变短。

**2. 教学载体**：这个项目要"教从零写 Agent"。如果 MCP 章节的门槛是"先配 GitHub token + 排 3 个坑"，学习曲线陡然抬高。Mock 让 MCP 章节的验证从复杂配置变成 `npm start`。

所以 Mock 不是过度工程，是**降低开发和学习的启动成本**。

### 4.2 Mock 数据必须主动打标

Mock 返回的每一段文本都以 `[Mock MCP] 以下是演示预设数据，非真实 GitHub API 返回：` 开头。这条约定在 [CLAUDE.md](../CLAUDE.md) 里有：**遇到 mock 数据要主动说明**。

但实测发现模型不一定守规矩——拿到 Mock 数据后可能直接呈现给用户，一句"这是演示数据"都没提。这是**模型对齐层面的问题**，不是代码问题。缓解方案：

- **A. Mock 输出加更硬的警示**（`⚠️ ... 禁止把它们当作真实数据呈现`）
- **B. SYSTEM prompt 里加规则**（`工具结果以 "[Mock MCP]" 开头时必须明确说明是演示数据`）

当前实现走 A。接了真实 GitHub server 后这个坑变次要——但保留 Mock 作为 fallback，规则要持续生效。

## 5. 端到端跑一次会看到什么

`npm start` 启动，`GITHUB_PERSONAL_ACCESS_TOKEN` 已配的情况：

```
[web_search] 当前后端：Tavily (自动挡)

连接 GitHub MCP Server...
  [server-github stderr] GitHub MCP Server running on stdio
  已注册 26 个 MCP 工具

已注册 38 个工具：
  - get_weather（可并发, 只读）
  - calculator（串行, 读写）
  - read_file（可并发, 只读）
  ...
  - mcp__github__list_issues（可并发, 读写）
  - mcp__github__search_repositories（可并发, 读写）
  - mcp__github__create_issue（可并发, 读写）
  ...
```

**38 = 12 内置 + 26 MCP**——注册链路无损。

问一句 "查看 vercel/ai 的 issues"，会看到：

```
--- Step 1 ---
  [调用: mcp__github__list_issues({"owner":"vercel","repo":"ai"})]
  [并发] mcp__github__list_issues 获取共享锁
  [结果: "..."真实 issue 列表"..."]
  [Token] 1979/600000 (0%)
  → 继续下一步...

--- Step 2 ---
（模型基于真实数据整理成表格）
```

两个信号：

1. `[并发] mcp__github__list_issues 获取共享锁`——这行日志是 `toAISDKFormat()` 里的锁代码打的，MCP 工具**自动**享受了本地读写锁调度
2. Token 计数正常——MCP 工具的结果也走了统一截断策略

**Agent Loop 一行都没改**。这就是 registry 抽象成立的证据。

## 6. 手写 vs 官方 SDK：抽象层选对位置的最强证据

前面几节讲的都是手写 `MCPClient`——目的是搞清楚 MCP 在传输层到底做了什么。但生产环境里你**不会自己维护** JSON-RPC 的 id 分配、响应匹配、超时处理、协议版本协商这些细节。官方 SDK `@modelcontextprotocol/sdk` 已经封好了这些。

**API 层面几乎一模一样**：
- `StdioClientTransport` 替代了手写的 `spawn` + `readline` + JSON 行解析
- `Client` 替代了手写的 `pending Map` + `id` 匹配 + 超时处理
- 方法名连改都没改——`listTools()`、`callTool()`

我们没有**替换**手写版本，而是**并行**多加了一个 [`src/mcp/sdk-client.ts`](../src/mcp/sdk-client.ts)，走 env switch 选：

```bash
MCP_CLIENT_KIND=sdk npm start          # 默认，生产推荐
MCP_CLIENT_KIND=handwritten npm start  # 教学版，看协议细节
```

两种模式下**注册的工具数、Agent Loop 的行为、工具调用的结果完全一致**——26 个 GitHub 工具、38 个总工具。启动日志除了 `client: sdk` vs `client: handwritten` 那一行，其余一模一样。

**关键事实**：`ToolRegistry.registerMCPServer` **一行都没改**——不是"几乎不用改"，是"零改动"。原因是我们不是"把参数换成官方 `Client`"，而是保持 `MCPClientLike` 抽象接口不变——手写 client 和 SDK client 都通过薄适配层实现同一个接口，registry 从头到尾只看到 `MCPClientLike`，永远不知道底下是谁。这就是抽象层选对位置的最强证据。

### 6.1 为什么替换只需要动一个文件

`ToolRegistry.registerMCPServer` 只依赖 `MCPClientLike` 这个**结构接口**（[`tool-registry.ts:15-24`](../src/tool-registry.ts#L15-L24)）：

```ts
export interface MCPClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<Array<{ name; description; inputSchema }>>;
  callTool(name: string, args): Promise<string>;
}
```

只要一个对象暴露这四个方法，就能塞进 registry。TypeScript 的结构类型（duck typing）帮你自动检查——`MCPClient` 满足，`SDKMCPClient` 满足，`MockMCPClient` 也满足。三个实现互相不知道对方存在，但都对 registry 表现出**同一张接口**。

对应 [`src/mcp/sdk-client.ts`](../src/mcp/sdk-client.ts) 的实现只做一件事：**把 SDK 的 API 翻译成 `MCPClientLike` 契约**。核心逻辑不到 30 行——SDK 的 `Client.connect(transport)` 已经把 initialize + notifications/initialized 串好，`callTool` 的返回结构跟 spec 完全对齐，我们只做类型收窄和 text 内容提取。

### 6.2 SDK 帮你干了什么

对比 [`src/mcp/client.ts`](../src/mcp/client.ts) 手写版本，SDK 内部帮你处理的事情：

| 能力 | 手写版本 | SDK 版本 |
|---|---|---|
| 握手时序 | 手动 `send('initialize')` + 手动写 `notifications/initialized`（[client.ts:63-72](../src/mcp/client.ts#L63-L72)，10 行） | `client.connect(transport)` 一行 |
| JSON-RPC id 分配 | `++this.requestId`（[client.ts:77](../src/mcp/client.ts#L77)） | SDK 内部自动 |
| 响应匹配 | 手动维护 `pending` Map（[client.ts:19-22](../src/mcp/client.ts#L19-L22)） | SDK 内部自动 |
| 请求超时 | 手写 `setTimeout` + `clearTimeout`（[client.ts:78-81](../src/mcp/client.ts#L78-L81)） | 通过 `RequestOptions` 配置，SDK 处理 |
| 协议版本协商 | 硬编码 `protocolVersion: '2024-11-05'`（可能过时） | SDK 自动填入当前 spec 版本 |
| 响应 schema 校验 | 无——收到脏数据会静默错乱 | Zod schema，格式不合 spec 会显式抛错 |
| 错误分类 | 只有一个 `MCP error ${code}: ${message}` | 区分 transport 错误 / 协议错误 / 应用错误 |
| Notification 处理 | 忽略（`msg.id === undefined` 直接丢弃） | 内建 handler，可订阅 progress / resource change |
| 传输层抽象 | 硬编码 stdio | 可切 `SSEClientTransport`、`StreamableHTTPClientTransport`、`WebSocketClientTransport` |

**几百行的差距，都在协议正确性和可维护性上**。

### 6.3 为什么保留手写版本

手写版本的价值在**"教学"**，不在"生产"。三个具体收益：

**1. 看得懂 SDK 内部**：任何时候 SDK 版本出诡异问题——比如 initialize 挂着不返回、callTool 抛出未知格式错误——你有能力打开 SDK 源码定位。因为你自己写过一遍，知道那些抽象背后的事实是什么。

**2. 调试传输层问题**：某些边缘场景 SDK 帮你抽象走了但你**需要看**——比如"server 到底发了几条 stderr？stdout 里有没有非 JSON-RPC 消息？id-map 里有没有孤儿？"这些手写版本一目了然，SDK 版本要打 debug flag。

**3. 极端环境嵌入**：SDK 依赖 Node.js 环境 + `child_process.spawn`，浏览器 Web Worker 里跑不了。如果你要在受限环境实现 MCP client（比如内嵌到某个 CLI 里，或者接自己写的 IPC 协议），手写版本 110 行更容易改造。

### 6.4 一个实测差异：stderr 的接入方式

两种 client 都做到了"server stderr 前缀化打印"，但路径不同：

**手写版本**（[client.ts:43-45](../src/mcp/client.ts#L43-L45)）：

```ts
this.process.stderr?.on('data', (chunk) => {
  process.stderr.write(`  [${this.serverName} stderr] ${chunk}`);
});
```

直接监听 `ChildProcess.stderr`——Node.js 原生 stream。

**SDK 版本**（[sdk-client.ts](../src/mcp/sdk-client.ts)）：

```ts
this.transport = new StdioClientTransport({
  ...,
  stderr: 'pipe',                        // ← 关键：让 SDK 把 stderr 走 pipe 而非 inherit
});
this.transport.stderr?.on('data', (chunk) => { ... });
```

SDK 默认是 `stderr: 'inherit'`（直接透传到父进程 stderr，你看得到但拿不到——加不了前缀）。要拿到 stderr 流做前缀化，必须显式设 `'pipe'`。

这个差异说明一件事：**SDK 帮你做了合理默认，但合理默认不一定是你想要的**。用 SDK 时要读它的类型定义（`stderr?: IOType | Stream | number`），才知道有这个选项。手写版本因为你自己控制 `spawn`，选项都在你眼前。

### 6.5 什么时候选哪个

| 场景 | 推荐 |
|---|---|
| 生产环境、企业内部 Agent | **SDK**——协议演进跟得上、bug 有官方修 |
| 学习 MCP 内部机制 | **手写**——所有细节可见 |
| 需要非标准传输层（自研 IPC、Web Worker） | **手写**——SDK 的 Transport 抽象需要你实现 5+ 方法，改现成的更快 |
| 需要极致定制超时/重试策略 | **手写**——SDK 的 RequestOptions 覆盖不全 |
| 需要接入 remote HTTP MCP server | **SDK**——`StreamableHTTPClientTransport` 已经封好 |

这个项目两个都保留，因为**教学定位需要"从零到 SDK"这条路径完整可见**——先手写理解协议，再看 SDK 就懂它每一层抽象在做什么。

## 7. 已知的坑与后续方向

写完这一节，回头看还有一些问题没解决：

**1. `isConcurrencySafe` 保守宽松**

MCP 工具一律标记为"可并发"，但 `create_issue`、`delete_repo` 这类写操作严格说应该串行。当前无法自动识别，属于**已知限制**——留给权限系统那篇。

**2. Server 崩溃的兜底**

现在如果 server 中途挂了，pending map 里的 Promise 只能等 60s 超时。可以在 `process.on('exit')` 里把所有 pending 一次 reject 掉——[`client.ts`](../src/mcp/client.ts) 现在没做，跑起来遇到再补。

**3. 单次 tools/call 的自定义超时**

现在所有 `send()` 共享 60s 超时。真实场景里 `initialize` 应该 5s 内响应（否则就是 server 有问题），而 `web_scrape_full_page` 这类工具可能真的要 2 分钟。**分层超时**是下一步优化。

**4. Streamable HTTP 传输**

stdio 只能本地。想接远程 MCP server（GitHub 官方新版就是 remote HTTP）得实现另一个 `TransportLike` 接口。当前 `MCPClient` 硬编码了 stdio，未来抽一个 `Transport` 接口就能扩展。

**5. Notification 支持**

现在收到 `msg.id === undefined` 的消息直接丢弃。MCP spec 里有 progress notification、resource change notification——生产 Agent 想显示"server 正在处理..."这类中间态就得实现。

---

## 相关文档

- [tool-call-concurrency.md](tool-call-concurrency.md) — 读写锁细节，MCP 工具复用同一套机制
- [agent-loop-protections.md](agent-loop-protections.md) — Agent Loop 三道防线，跟工具来源无关
- [research-agent-practice.md](research-agent-practice.md) — 工具驱动的多轮流程，MCP 天然融入
