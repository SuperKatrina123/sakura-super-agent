# Plugin 系统：五个可迁移的架构决策

> 配套 [../README.md](../README.md) 的拓展阅读。前面几篇讲的是**给 Agent 装能力**（工具、记忆、RAG、Skill）——这一篇讲**给 Agent 装扩展性**：为什么 Plugin 跟 Tool / Skill 不是一个东西、PluginApi 隔离层为什么是所有插件系统的起点、命名空间前缀 / 生命周期 / 错误隔离这三个"标配"背后的取舍、以及为什么这五个决策**跟"Agent"没关系**——做编辑器、构建工具、开放平台都会用到。

## 目录

- [0. 为什么需要 Plugin](#0-为什么需要-plugin)
- [1. Plugin ≠ Tool ≠ Skill：三层能力扩展的边界](#1-plugin--tool--skill三层能力扩展的边界)
- [2. 决策一：接口契约（PluginDefinition）](#2-决策一接口契约plugindefinition)
- [3. 决策二：API 隔离层（PluginApi）](#3-决策二api-隔离层pluginapi)
- [4. 决策三：命名空间隔离（`pluginName__toolName`）](#4-决策三命名空间隔离pluginname__toolname)
- [5. 决策四：生命周期管理（activate / destroy）](#5-决策四生命周期管理activate--destroy)
- [6. 决策五：错误隔离](#6-决策五错误隔离)
- [7. 三个补丁：环境变量占位、REPL 命令、graceful shutdown](#7-三个补丁环境变量占位repl-命令graceful-shutdown)
- [8. 已知的坑与后续方向](#8-已知的坑与后续方向)

## 0. 为什么需要 Plugin

前面几篇给 Agent 装了很多能力——工具、记忆、RAG、Skill。**但这些能力都写在项目内部**：加一个 supabase 工具要改 `tools/`、加一个 code-review skill 要改 `.skills/`。

**痛点**在生态维度：

- **谁能加**——现在只有项目作者能加、外部贡献者要 PR
- **能加什么**——只能加工具/skill/记忆条目、加不了"新的运行时资源"（比如 WebSocket 长连接）
- **加了怎么管**——项目重启才生效、没有独立生命周期

**Plugin 是解耦这三个问题的通用手段**：定义一个稳定的"接入协议"、让第三方按协议接、项目内部实现随便改。

**跟 Tool / Skill 的关系**（先厘清、后面 5 节都基于这个区分）：

| | Tool | Skill | Plugin |
|---|---|---|---|
| **加什么** | 单个能力（函数） | 工作流（SOP） | 一整套（工具 + 资源 + 生命周期） |
| **谁加** | 项目内部 | 用户或团队 | 第三方 / 部署方 |
| **生命周期** | 无（进程级） | 无（进程级） | **显式 activate/destroy** |
| **需要资源** | 一般不需要 | 不需要 | **常需要**（DB 连接、订阅） |
| **典型例子** | `bash` / `read_file` | code-review SOP | supabase 集成、slack 集成 |

**关键洞察**：**Plugin 不是"更大的 Tool"、是"带生命周期的能力包"**。这个区分决定了后面所有设计——为什么要有 API 隔离层、为什么要有 destroy、为什么要错误隔离。

## 1. Plugin ≠ Tool ≠ Skill：三层能力扩展的边界

三种扩展机制在这个项目里共存、**各管一层**：

```
      ┌─────────────────────────────────────────┐
      │  Plugin：一整套能力 + 长生命周期资源     │  ← 第三方接入协议
      │  ├── 注册多个 Tool                       │
      │  ├── 可能带 DB 连接 / 订阅 / 定时器      │
      │  └── activate / destroy                  │
      └─────────────────────────────────────────┘
                       ↓ 注册的产物
      ┌─────────────────────────────────────────┐
      │  Tool：单个可调用能力                    │  ← Agent 直接调
      │  ├── bash / read_file                    │
      │  ├── supabase__query（来自 plugin）      │
      │  └── mcp__github__get_issue（来自 MCP）  │
      └─────────────────────────────────────────┘

      ┌─────────────────────────────────────────┐
      │  Skill：工作流模板                       │  ← 激活后进 SYSTEM
      │  用 markdown 定义、告诉 Agent 怎么办事    │
      └─────────────────────────────────────────┘
```

**为什么不合并**：

- **合并 Tool + Plugin** → 单个工具能启动 DB 连接？语义乱、垃圾回收难做
- **合并 Skill + Plugin** → 一个 markdown 文件能"注册运行时资源"？破坏"skill 是数据"的心智
- **合并三者** → 每种能力都要 activate/destroy？简单 tool 也被迫写生命周期、心智负担爆炸

**这个分层是有代价的**——加一个能力要问"这是 tool / skill / plugin？"、但**代价随规模稀释**：项目大了、边界清晰的价值远超"多一次判断"的成本。

## 2. 决策一：接口契约（PluginDefinition）

**所有插件系统的起点**——定义"一个 plugin 长什么样"。

```ts
// src/plugins/types.ts
export interface PluginDefinition {
  name: string;
  version: string;
  description: string;
  config?: PluginConfig;

  activate(api: PluginApi): Promise<void> | void;
  destroy?(): Promise<void> | void;
}
```

**5 个字段的取舍**：

**① `name` 必填、`version` 必填**——**这两个是身份和演进的基础**：
- 没 name 就没法命名空间、没法从 registry 里定位、没法在 REPL 里管理
- 没 version 就没法在日志里说清"我加载的是哪个 supabase"、debug 一个 plugin bug 时说不清

**② `description` 必填**——**给用户看的**、`/plugin` 列表里就靠它告诉用户"这插件能干嘛"

**③ `config` 可选、当"默认配置"**——不是"当前值"（后者由 `PluginApi.getConfig()` 返回、见第 3 节）

**④ `activate` 必填、`destroy` 可选**——生命周期一节详细讲

**为什么长这样**：

- **对齐生态惯例**：VS Code 扩展的 `package.json`、Webpack plugin 的 `apply(compiler)`、Express middleware 的 `(req, res, next)` ——所有插件系统都是"一个对象 + 一个入口方法"的形状
- **强类型 + 简洁**：只暴露 plugin 作者**必须知道**的字段；project 内部的复杂度（工具怎么注册、什么时候清理）藏在 `PluginApi` 后面

**可迁移性**：这五个字段几乎适用于任何插件系统——**做编辑器扩展**（`activate(context: ExtensionContext)`）、**做构建工具**（`apply(compiler)`）、**做开放平台**（`onLoad(sdk)`）——名字换掉、结构不变。

## 3. 决策二：API 隔离层（PluginApi）

**这一节是全篇最重要的设计**——不然为什么单独一个 `PluginApi` 类型、直接把 `registry` 传给 plugin 不就完了？

### 不做 API 层的后果

如果 activate 直接接 `registry`：

```ts
activate(registry: ToolRegistry) {
  registry.register({...});           // ← plugin 想干的事
  registry.unregister('bash');        // ← 意外能干的事
  registry.tools.clear();             // ← 更意外能干的事
}
```

**问题不是"plugin 作者会恶意搞破坏"**——是三件其他事：

**a. Plugin 意外能碰到不该碰的**——不小心 `unregister('bash')`、内置工具就没了

**b. 内部实现锁死**——想把 registry 换成新的（比如加索引、加缓存）？所有 plugin 都得改

**c. 无法追踪归属**——plugin 注册的工具跟内置工具混在一个 map 里、卸载 plugin 时清哪些？靠 plugin 自己记？

### 引入 API 层解决三个问题

```ts
export interface PluginApi {
  registerTools(tools: ToolDefinition[]): void;
  getConfig(): PluginConfig;
  log(message: string): void;
}
```

**关键**：**PluginApi 是 plugin 与 Agent 内部的唯一通道**——plugin 拿到 `api`、拿不到 `registry`、拿不到 `builder`、拿不到 `memoryStore`。

三个问题一次性解决：

- **能干什么由 API 说了算**——想扩展就在 `PluginApi` 上加方法（`registerCommand` / `subscribeEvent` / `registerSkill`）、**不改 plugin 的接入方式**、老 plugin 不受影响
- **内部实现随便换**——registry 换成新版本？只要 `api.registerTools` 的语义不变、plugin 完全无感
- **归属可追踪**——`api` 在 Manager 里是**每个 plugin 独立创建的闭包实例**、`registerTools` 内部把注册的工具名记在闭包变量里（见 manager.ts 的 `registeredTools` 数组）、destroy 时按这个数组清

### 业界的样本

**同样的 pattern 满地都是**：

- **VS Code 扩展**：`activate(context: ExtensionContext)`——`context` 就是 API 层、暴露 `subscriptions` / `commands` / `workspace` 等受控接口、扩展碰不到 VS Code 内部
- **Webpack**：`apply(compiler: Compiler)`——`compiler` 是 API 层、暴露 `hooks` 让 plugin 挂 callback、plugin 不直接改 webpack 内部
- **Express middleware**：`(req, res, next)`——`req` / `res` / `next` 是 API 层、middleware 不能访问 express app 内部
- **Chrome Extension**：`chrome.*` API——扩展只能通过这些接口访问浏览器能力

**共同的洞察**：**内部实现是流动的、API 是契约**。契约一旦定了就得稳定、内部想怎么重构都行。

**可迁移性**：**任何要开放扩展性的系统、第一步都是设计这一层**。跳过它、生态发展到一定规模就会积累大量"依赖内部细节"的 plugin、任何重构都变成 breaking change——JIT 优化不敢改、bug 不敢修、只能一直背着技术债往前走。

## 4. 决策三：命名空间隔离（`pluginName__toolName`）

**问题**：两个 plugin 都想注册叫 `query` 的工具——怎么办？

**方案**：Manager 内部把工具名自动加前缀：

```ts
// src/plugins/manager.ts
registerTools: (tools: ToolDefinition[]) => {
  for (const tool of tools) {
    const prefixedName = `${definition.name}__${tool.name}`;
    const prefixedTool: ToolDefinition = { ...tool, name: prefixedName, ... };
    this.registry.register(prefixedTool);
    registeredTools.push(prefixedName);
  }
}
```

Plugin 里写 `name: 'query'`——**注册到 registry 里叫 `supabase__query`**。Agent 看到的也是 `supabase__query`。

### 为什么用双下划线 `__`

- 单下划线 `_` 会跟 tool 自己的命名冲突（比如 `list_tables`）
- 冒号 `:` 在 OpenAI / Anthropic tool name 规范里不合法
- 双下划线视觉上够分隔、且 npm / SQL / Python 生态都在用（`__init__` / dunder）

### 一致性：MCP 也用同样的前缀

```
mcp__<serverName>__<toolName>       ← MCP 工具
<pluginName>__<toolName>             ← Plugin 工具
```

**两套系统前缀语法一致**——用户看到 `mcp__github__get_issue` 和 `supabase__query`，能立刻分清哪个来自 MCP server、哪个来自 Plugin。**教学项目里这个一致性很重要**——两种"能力接入"方式共享同一个心智模型。

### 业界样本

**几乎所有插件系统都做命名空间**：

- **npm scope**：`@anthropic/sdk` 跟 `@openai/sdk` 用 scope 区分组织、避免 root 命名争抢
- **Chrome Extension manifest ID**：每个扩展有唯一 ID、跨扩展消息传递必须显式指名
- **Kubernetes CRD**：`kind: Pod` 属于 `core/v1`、自定义 CRD 必须带 group 前缀（`example.com/v1`）
- **Cargo crate**：Rust 生态里模块名 + crate 名双层隔离

**共同的洞察**：**开放系统必须假设 name collision 会发生**、不做隔离就是等灾难。

### 一个 trade-off：可读性 vs 隔离性

**代价**：Agent 看到的工具名变长——`supabase__query` 比 `query` 多 10 个字符、模型的 token 成本轻微上升、tool schema 里的 name 字段也变胖。

**好处**：命名空间冲突 100% 消除、卸载 plugin 时"哪些工具是我注册的"一目了然（前缀扫一遍就出）。

**这个 trade-off 在教学项目里划算**——3 个 plugin × 3 个工具 = 9 个前缀化的 name、多花几十 tokens、换来"永远不会撞名"的稳定性。

## 5. 决策四：生命周期管理（activate / destroy）

**问题**：Plugin 常需要**长生命周期的资源**——DB 连接池、WebSocket 订阅、`setInterval` 定时器、文件 watcher。**这些资源不清理就是内存泄漏 / 端口占用 / 幽灵进程**。

**方案**：显式的 `activate` / `destroy` 生命周期。

```ts
export interface PluginDefinition {
  activate(api: PluginApi): Promise<void> | void;
  destroy?(): Promise<void> | void;
}
```

### `activate` 的语义

**做初始化**：拿到 `api` 就是 plugin 被激活的信号——建 DB 连接、启动订阅、注册工具、注册命令都在这里做。

**语义细节**：
- **可能是异步**——DB 连接、鉴权都要等
- **抛错会阻止加载**——manager 会捕获、log、跳过这个 plugin（错误隔离、见第 6 节）
- **成功后 api 用完即弃**——不需要在 plugin 内部保存 api 引用（除非 destroy 里想用）

### `destroy` 的语义

**做清理**：跟 activate 对称——activate 里拿了什么资源、destroy 里就还回去什么。

**为什么可选**：**大部分 plugin 不需要 destroy**——只注册几个工具、没有长生命周期资源、进程退出时资源自然回收。

**必须要 destroy 的场景**：
- **数据库连接池** → 得 `.end()` 关连接
- **WebSocket 订阅** → 得 `.close()` 解除服务端订阅
- **`setInterval` / `setTimeout`** → 得 `clearInterval`——**这个是最容易漏的**、内存里的定时器不清就一直跑
- **文件 watcher** → 得 `.close()`
- **子进程** → 得 `.kill()`

**注册的工具不用管**——manager 在 `unload()` 里自动清（用第 3 节说的归属追踪）：

```ts
// src/plugins/manager.ts
async unload(name: string): Promise<boolean> {
  const plugin = this.plugins.get(name);
  if (!plugin) return false;

  if (plugin.definition.destroy) {
    try { await plugin.definition.destroy(); }
    catch (err) { console.error(...); }   // 错误隔离
  }

  // 框架代记账：activate 时前缀化的工具、按名字扫一遍清干净
  for (const toolName of plugin.tools) {
    this.registry.unregister(toolName);
  }

  this.plugins.delete(name);
  return true;
}
```

### 生命周期的时序

**为什么先 destroy 再 unregister 工具**：

Plugin 的 destroy 里**可能会用到自己注册的工具**——比如收尾时想调一次 `supabase__query` 记录关闭时间。**先 unregister 工具 destroy 就调不到了**。

先 destroy、再 unregister、次序是**"plugin 先说完话、再收走它的话筒"**。

### 业界样本

**这个模式在所有系统级抽象里都反复出现**：

- **React `useEffect`**：`return () => cleanup()` 就是 destroy——effect 建立订阅、cleanup 解除订阅
- **Kubernetes lifecycle hooks**：`postStart` / `preStop` 对应 activate / destroy
- **Systemd service**：`ExecStart` / `ExecStop` 就是 activate / destroy
- **VS Code Extension**：`activate(context)` / `deactivate()` 语义完全一致
- **RAII in C++/Rust**：构造函数拿资源、析构函数还——虽然是隐式的、语义等价

**共同的洞察**：**资源必须显式配对**——拿了不还、系统会慢慢烂掉。

**可迁移性**：设计任何"有状态的扩展点"——不管是插件、组件、服务、还是 middleware——**一定要给一个显式的 destroy 语义**。没有 destroy 的系统不是简单、是**故意留了泄漏**。

## 6. 决策五：错误隔离

**问题**：加载 5 个 plugin、第 3 个 activate 抛异常——**剩下的两个还加载吗**？

**方案**：**每个 plugin 独立 try/catch、失败只 log、不阻塞其他 plugin**。

### 三个隔离层

**层一：加载时**（`main()` 里的批量加载）

```ts
// src/index.ts
for (const def of defaultPlugins) {
  try {
    const tools = await pluginManager.load(def);
    console.log(`  ✓ ${def.name} v${def.version} — 注册 ${tools.length} 个工具`);
  } catch (err) {
    console.error(`  ✗ ${def.name} 加载失败: ${msg}`);
  }
}
```

一个失败、log 打完继续加载下一个。**关键是"整个进程不该因为一个 plugin 挂而挂"**——生产环境更是这样、Agent 是核心服务、supabase plugin 挂了不能把整个 Agent 拉下水。

**层二：destroy 时**（`unloadAll` 内部）

```ts
// src/plugins/manager.ts
if (plugin.definition.destroy) {
  try { await plugin.definition.destroy(); }
  catch (err) { console.error(`[plugin:${name}] destroy 出错: ${msg}`); }
}
```

**destroy 抛错更需要隔离**——unload 场景常见于"批量卸载所有 plugin"（进程退出前）、**一个 destroy 挂了不能阻止其他 plugin 清理**、否则关键资源（DB 连接、订阅）就残留了。

**层三：运行时**（Tool 执行时——由 [ToolRegistry 的读写锁](tool-call-concurrency.md) 保证）

Plugin 注册的工具 execute 抛错、不会污染其他工具的执行——**这一层不是 Plugin 特有的**、是 Registry 的通用保证。**但这个组合很重要**：Plugin 系统的错误隔离要靠三层协同，不是 Plugin Manager 一个人的事。

### 错误隔离 vs 错误吞掉

**这是最容易搞错的地方**——错误隔离**不是**"catch 完就当没事发生"、而是"**catch 后转成日志、让人能排查**"。

三条铁律：

- **必须打 log**——包含 plugin 名 + 错误消息 + stack（生产还要打到 telemetry）
- **必须让状态一致**——activate 失败时、`registeredTools` 里已注册的工具要回滚（当前 manager 没做、见"已知的坑"）
- **不能假装成功**——`pluginManager.load()` 抛出去、调用方能知道"这个 plugin 没加载成功"

### 业界样本

- **Kubernetes**：一个 Pod crash 只重启它、不影响 Node 上其他 Pod（隔离粒度）
- **Erlang OTP**：每个 process 独立、supervisor 只重启挂的那个
- **Chrome multi-process**:一个 tab 挂了不影响其他 tab
- **Docker container**：一个容器挂了不影响宿主机上其他容器

**共同的洞察**：**隔离粒度决定系统韧性**——粒度越细、局部故障影响面越小。

**可迁移性**：**任何"批量加载" / "批量清理"的场景都要错误隔离**——扫目录加载配置文件、逐个连接下游服务、启动 workers——记住"整体成功 = 全部尝试完 + 报告成功和失败"、而不是"遇错即停"。

## 7. 三个补丁：环境变量占位、REPL 命令、graceful shutdown

上面五个决策是**核心**、下面三个是**让核心可用的补丁**。

### 7.1 环境变量占位 `${VAR}`

Plugin 里配置写死 `apiKey: 'sk-xxx'`——**代码里塞 credential** 是禁忌。

**方案**：plugin 声明的时候用 `${SUPABASE_URL}` 占位符、Manager 自动解析：

```ts
// src/plugins/manager.ts
private resolveEnvVars(config: PluginConfig): PluginConfig {
  const resolved: PluginConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
      const envKey = value.slice(2, -1);
      resolved[key] = process.env[envKey] || '';
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
```

**语义**：**Plugin 声明"我需要这个变量"、部署方通过 env 提供实际值**——同一个 plugin 定义在开发/预发/生产各自跑起来、代码不改。

**已知不足**（见 [已知的坑](#8-已知的坑与后续方向) 第 3 项）：
- 只支持"整个 value 是占位符"、不支持嵌入（`postgres://${USER}:${PASS}@host`）
- 缺失时静默给空字符串——生产应该 throw

### 7.2 REPL 命令 `/plugin`

Plugin 需要"人机接口"——用户想临时加载/卸载 plugin、想看当前挂了哪些：

```
/plugin                     列出已加载 + 可加载
/plugin load supabase       加载
/plugin unload supabase     卸载
```

实现在 [src/commands/plugin.ts](../src/commands/plugin.ts)——遵循 [async dispatcher](skill-system-design.md#4-两种激活入口元工具-vs-快捷命令) 的模式。**关键设计**：**用户主动控制** + **默认自动加载**双入口——`defaultPlugins` 声明"启动自动加载"、`/plugin load` 支持"运行时按需加载"。

### 7.3 Graceful Shutdown

进程退出时——**必须给所有 plugin 一个 destroy 的机会**、不然长生命周期资源会残留。

```ts
// src/index.ts
const shutdown = async () => {
  await pluginManager.unloadAll();   // 先 plugin
  await registry.closeAllMCP();      // 再 MCP
  process.exit(0);
};
process.on('SIGINT', shutdown);
rl.on('close', shutdown);
```

**顺序有讲究**——**plugin 可能依赖 MCP 提供的能力**（未来场景）、所以 plugin 先清、MCP 后清、依赖方向清晰。

**未来要加的**：SIGTERM 支持（Docker `docker stop` 发 SIGTERM 而不是 SIGINT）、超时保护（destroy 卡住 30s 就强杀）——生产环境的完善度。

## 8. 已知的坑与后续方向

### 8.1 activate 失败没回滚——幽灵工具

```ts
try {
  await definition.activate(api);
} catch (err) {
  // ← 这里没清 registeredTools、已注册的工具会遗留在 registry 里
  throw err;
}
```

**修法**：catch 里遍历 `registeredTools` 逐个 unregister、然后 throw。**当前没做**、教学项目里失败即整体启动失败、影响不大——生产必须补。

### 8.2 撞名没检查——两个 plugin 同名工具会静默覆盖

Plugin A 注册 `foo__query`、Plugin B 也叫 `foo`——两次调用 `registry.register('foo__query')`、后者覆盖前者、前者的工具**指针还留在 A 的 `registeredTools` 数组里**、A unload 时会把 B 的工具误清。

**修法**：`registerTools` 内部先 `registry.has(prefixedName)`、撞了 throw。**当前 manager 只在 `plugins.has(name)` 层做了检查**、不够。

### 8.3 环境变量解析太粗

见 7.1 已经说了——不支持嵌入、缺失时静默兜底空字符串。生产建议：
- 用正则 `/\$\{(\w+)\}/g` 全局替换
- 语法上加 `${VAR?}` 表示"可选"（缺失走空）
- 默认必须存在、缺失 throw

### 8.4 log 用 console.log、跟 REPL 输出格式不一致

`api.log` 内部就是 `console.log('  [plugin:name] ...')`——**没有走统一的 logger**。当前跟 memory / rag 的 debug 输出格式各不一样、观感稍显散乱。

改法：抽一个 `Logger` 抽象、所有子系统（Plugin / Memory / RAG / MCP）都用它。**没做的原因**：当前 console.log 够跑、抽象 logger 会拉高心智门槛、优先级不高。

### 8.5 PluginApi 只有 3 个方法——不够用

现在只有 `registerTools` / `getConfig` / `log`。**很快会想要**：

- `registerCommand(handler)`——plugin 注册自己的 REPL 命令（比如 supabase plugin 想加 `/supabase migrate`）
- `registerSkill(skill)`——plugin 打包一整套 SOP（比如 supabase plugin 带一个"查询优化"skill）
- `subscribeEvent('tool_call', callback)`——telemetry plugin 需要（比如统计工具调用频率）
- `getMemoryStore()`——plugin 想读跨会话记忆（比如 slack plugin 记录常聊的人）

**第 3 节说过的原则**：加能力 = **加方法、不改 plugin 接入方式**、老 plugin 无感——PluginApi 就是为了让这种演进平滑。

### 8.6 destroy 里拿不到 api——log 不带前缀

```ts
destroy() {
  console.log('  [plugin:supabase] 连接已释放');  // ← 手动加前缀
}
```

destroy 签名没接 api——想用 `api.log` 只能在 activate 里存到闭包。**改法**：
- **方案 a**：`destroy(api)` 也接 api 参数
- **方案 b**：activate 时 plugin 自己 `this.api = api` 存起来

选 a 更明确、跟 activate 对称。当前没做。

### 8.7 没有 plugin 之间的依赖 / 加载顺序

Plugin A 依赖 Plugin B 提供的能力——现在只能靠 `defaultPlugins` 数组的顺序手动保证。**生产 plugin 系统**（VS Code、Webpack）都有依赖声明：

```ts
// 未来可能长这样
export interface PluginDefinition {
  ...
  dependsOn?: string[];   // 依赖的其他 plugin
}
```

**没做的原因**：教学项目当前一个 plugin、依赖是零成本假设；等有 3+ plugin 且真的互相依赖时再加。

### 8.8 没有热加载 / 动态发现

- Plugin 定义改了要重启才生效
- 只支持显式挂载（`defaultPlugins` 数组硬编码）、没有扫 `plugins/` 目录自动发现

**热加载**（改代码不重启就生效）——生产工程复杂度高、要处理"旧版本已经注册的工具怎么优雅退出"这种问题、教学场景不做。

**动态发现**（扫目录）——可以做、但会引入路径 / 类型 / 错误隔离的额外复杂度。当前显式挂载**类型完整、教学友好**、跟 skill 用 `.skills/` 数据发现的对照也漂亮（**skill 是数据、plugin 是代码、加载方式不同很自然**）。

---

## 回顾：五个决策的迁移价值

写完这一篇最想传递的不是"怎么给 Agent 加 plugin"、而是**这五个决策适用于所有需要扩展性的系统**：

| 决策 | 解决的问题 | 业界样本 |
|---|---|---|
| **接口契约** | 定义"扩展长什么样" | VS Code 扩展、Webpack plugin、Express middleware |
| **API 隔离层** | 内部实现自由演化 | `vscode` API、Webpack compiler、Chrome `chrome.*` |
| **命名空间隔离** | 防冲突 | npm scope、K8s CRD group、Cargo crate |
| **生命周期管理** | 防资源泄漏 | `useEffect` cleanup、K8s hooks、RAII |
| **错误隔离** | 局部故障不扩散 | Erlang OTP、K8s Pod、Chrome multi-process |

**做插件系统 / 开放平台 / 内部工具的扩展性——这五个决策绕不过去**。跳过任何一个、系统扩展到一定规模都会撞上代价——**要么锁死内部实现、要么资源持续泄漏、要么一个坏扩展搞崩整个系统**。

值得记住的话：**扩展性不是"以后再加"、是"从第一天就该定的契约"**。API 层一旦有了 100 个 plugin 依赖它、想改内部就得同时改 100 个下游——**先设计 API 契约的成本、永远低于后期兼容 legacy 的成本**。
