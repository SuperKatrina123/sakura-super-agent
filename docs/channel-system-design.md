# Channel 系统：把 Agent 从 REPL 里解放出来

> 配套 [../README.md](../README.md) 的拓展阅读。前面几篇让 Agent **在 REPL 里变强**——工具、记忆、RAG、Skill、Plugin。这一篇讲**怎么把同一个 Agent 塞进任何输入通道**：为什么 REPL 只是"Channel 之一"、Gateway 如何把 IncomingMessage 路由到 agentLoop、每个 sender 独立 session + 独立 budget 的意义、以及"接一个新 channel 需要写什么"。

## 目录

- [0. 为什么需要 Channel](#0-为什么需要-channel)
- [1. Channel ≠ Tool ≠ Plugin：三个扩展维度的区分](#1-channel--tool--plugin三个扩展维度的区分)
- [2. 核心抽象：ChannelDefinition + Gateway](#2-核心抽象channeldefinition--gateway)
- [3. Session 隔离：每个 sender 独立 messages + budget](#3-session-隔离每个-sender-独立-messages--budget)
- [4. buildSystem closure：channel 看到的工具是"当前状态"](#4-buildsystem-closure-channel-看到的工具是当前状态)
- [5. 停机顺序：channel → plugin → MCP](#5-停机顺序channel--plugin--mcp)
- [6. 内置样本：FeishuChannel + Dashboard](#6-内置样本feishuchannel--dashboard)
- [7. 接一个新 Channel 需要写什么](#7-接一个新-channel-需要写什么)
- [8. 已知的坑与后续方向](#8-已知的坑与后续方向)

## 0. 为什么需要 Channel

前面几章让 Agent 在 REPL 里越来越强——**但 REPL 只有一个人能用、只在一台机器上跑**。真实需求是：

- **飞书里 @ 机器人**——同事在群里就能用 Agent
- **Slack 里 DM**——远程团队通过 Slack 触发 Agent
- **邮件回复触发**——收到告警邮件、Agent 自动分析
- **Web 表单提交**——公司内部工单系统嵌入 Agent

**共同的抽象**：一个消息进来 → 触发 agentLoop → 一段回复出去。**REPL 本质上也是这个模式**——`rl.question` 是输入、`console.log` 是输出。

**把这个抽象显性化就是 Channel**——REPL 只是众多 channel 里的一个特例。核心洞察：**Agent 的能力（工具 / 记忆 / RAG / Plugin）跟"用户从哪来"完全无关**、应该能被任意通道复用。

## 1. Channel ≠ Tool ≠ Plugin：三个扩展维度的区分

这个项目现在有三种扩展机制、**各扩展一个正交维度**：

| 维度 | 抽象 | 例子 |
|---|---|---|
| **能力维度**：Agent 能做什么 | Tool / Skill / Plugin | `bash` / `code-review` skill / supabase plugin |
| **知识维度**：Agent 知道什么 | Memory / RAG | 用户偏好 / 项目文档 |
| **通道维度**：Agent 服务谁** | **Channel** | REPL / 飞书 / Slack / 邮件 |

**正交的意义**：你在飞书里加一个 supabase plugin——**不需要飞书 channel 知道"什么是 supabase"**、也**不需要 supabase plugin 知道"什么是飞书"**。它们通过 `registry` 间接协作、彼此完全解耦。

**跟 Plugin 特别容易混淆**——两者都是"外部接进来"、语义有什么不同？

- **Plugin**：**加能力**——注册工具、可能持有资源。跟 CLI/飞书/Slack 无关。
- **Channel**：**加入口**——把消息 route 进 agentLoop、把回复 route 回去。跟"Agent 能做什么"无关。

**边界的一个 litmus test**：飞书能不能作为 plugin 写？技术上可以——但语义扭曲。plugin 语义是"注册工具"、飞书要**主动喂消息进 loop**、这跟 plugin 的"被动被调用"完全不同。**该有一个独立抽象、就有一个独立抽象**——不为了"少一个概念"硬塞到已有抽象里。

## 2. 核心抽象：ChannelDefinition + Gateway

**Channel 层两个类型**：

```ts
// src/channels/types.ts
export interface IncomingMessage {
  channelId: string;
  senderId: string;
  senderName: string;
  text: string;
  raw?: unknown;   // 原始消息、debug / 高级路由用
}

export interface OutgoingMessage {
  channelId: string;
  recipientId: string;
  text: string;
}

export interface ChannelDefinition {
  name: string;
  description: string;

  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  send(message: OutgoingMessage): Promise<void>;

  onMessage?: (handler: (msg: IncomingMessage) => void) => void;
}
```

**设计取舍**：

**① IncomingMessage / OutgoingMessage 是极简的通用形态**——4-5 个字段、能容纳大多数 channel。飞书的"回复某条消息"、Slack 的"thread reply"、邮件的"Re:"等更复杂语义走 `raw`，不污染核心结构。

**② `onMessage` 是可选的**——纯发送 channel（比如"钉钉告警"、只发不收）不用实现。**收发解耦让 channel 的用途更广**。

**③ `start` / `stop` 的语义跟 Plugin 的 `activate` / `destroy` 平行**——channel 也是有生命周期的资源（长连接、HTTP 服务器）、需要显式清理。

**Gateway 层负责把 channel 编排起来**：

```ts
// src/channels/gateway.ts
export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>();
  private sessions = new Map<string, ChannelSession>();

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel);
    channel.onMessage?.((msg) => this.handleIncoming(channel.name, msg));
  }

  async startAll(): Promise<void> {
    // 每个 channel 独立 try/catch——一个失败不阻塞其他（错误隔离）
    for (const [name, ch] of this.channels) {
      try { await ch.start(); console.log(`  [gateway] ✓ ${name} 已启动`); }
      catch (err) { console.error(`  [gateway] ✗ ${name} 启动失败: ${err}`); }
    }
  }

  private async handleIncoming(channelName: string, msg: IncomingMessage) {
    // 1. 定位 session
    // 2. 塞 user message
    // 3. 调 agentLoop
    // 4. 取最后一条 assistant 消息、通过 channel.send 发回
  }
}
```

**关键洞察**：**Channel 只管消息的"运输"、Gateway 管消息的"分派"**——这层分工让"接新 channel"不需要改 gateway，"改 session 语义"不需要动 channel。

## 3. Session 隔离：每个 sender 独立 messages + budget

**问题**：飞书群里 A 用户和 B 用户都 @机器人、他们的对话应该混在一起吗？

**答案**：显然不该——**每个用户有独立的对话记忆**。这也是 REPL 那一份 messages 走不通的场景——REPL 假设"这台终端只有一个人"、channel 不能这么假设。

**方案**：每个 `(channelName, senderId)` 对应一个独立 session：

```ts
interface ChannelSession {
  messages: ModelMessage[];
  budget: BudgetState;
}

const sessionKey = `${channelName}:${msg.senderId}`;
if (!this.sessions.has(sessionKey)) {
  this.sessions.set(sessionKey, {
    messages: [],
    budget: { used: 0, limit: DEFAULT_BUDGET_LIMIT },
  });
}
```

**为什么 `messages` 和 `budget` 都要独立**——不是 messages 独立、budget 共用一份就够：

**独立 messages** 是 obvious 的——A 说的 B 不该看到、上下文不能串。

**独立 budget** 是隐性但重要的——**共用一份 budget** 会导致 A 用户狂问烧完 600k 后、B 用户第一次问机器人就被拒绝。**运营灾难**——B 什么都没做、体验就被 A 拖垮了。**"资源份额跟着用户走"是多租户系统的通用原则**。

**代价**：session 数量随用户数线性增长、每个 session 占几十 KB messages 数组。**当前没做 LRU 淘汰**——见 [已知的坑](#8-已知的坑与后续方向)。

## 4. buildSystem closure：channel 看到的工具是"当前状态"

Channel session 调 agentLoop 需要一个 SYSTEM——**用哪一版？**

三种候选、看起来都合理、其实**只有一个对**：

**a. 启动时静态构建一次**——固化在 gateway 里——❌ tool_search 激活的工具看不到、后续加载的 plugin 也看不到
**b. gateway 拿到 PromptBuilder + PromptContext 自己 build**——每次调都 build——✓ 语义正确、但 gateway 要理解 builder / ctx 的耦合太重
**c. 传一个 `buildSystem: () => string` closure 进来**——**gateway 只调用、不理解怎么构造**——✓ 最干净

选 c、Gateway 只有一个"构建当前 SYSTEM"的黑盒：

```ts
// src/index.ts
const gateway = new ChannelGateway({
  model,
  registry,
  buildSystem: () => promptBuilder.build({
    toolCount: registry.getAll().length,
    deferredTools: registry.getDeferredTools(),
    sessionMessageCount: 0,   // channel session 自己管、这里给 0
    sessionId: 'channel',
  }),
});
```

**闭包捕获 `promptBuilder` + `registry`**——**每次调都是"现在这一刻"的状态**：

- 用户在 REPL 里 `/plugin load slack`——channel session 下一次收消息、SYSTEM 里就有 `slack__*` 工具
- 某个 channel session 触发了 `tool_search` 激活工具——之后所有 channel session 都看得到（因为 registry 是共享的）

**这个 closure 是 gateway 跟主进程唯一的"活状态耦合点"**——理解了它就理解了 channel 系统跟其他系统的解耦逻辑。

## 5. 停机顺序：channel → plugin → MCP

进程退出时、有三种长生命周期资源要清：

1. **Channel**：飞书 WebSocket、Dashboard HTTP 服务器、Slack RTM 连接...
2. **Plugin**：DB 连接池、订阅、定时器...
3. **MCP**：子进程

**顺序有讲究**——**下游先停、上游后停**：

```ts
// src/index.ts
const shutdown = async () => {
  await gateway.stopAll();          // ① 先停 channel——不再接受新消息
  await pluginManager.unloadAll();  // ② 再卸 plugin——channel 里跑的 loop 已经停、可以清 plugin 资源
  await registry.closeAllMCP();     // ③ 最后关 MCP 子进程
  process.exit(0);
};
```

**为什么这个顺序**：

**channel 先停** —— 不停就有新消息进来、消息触发 agentLoop、loop 里调 plugin 工具——**plugin 已经卸了 tool call 会崩**。

**MCP 最后停** —— MCP 是被 plugin/channel 共同依赖的"更基础的资源"、最后停符合"依赖倒序清理"原则。

**exit 分支也要显式清理**：

```ts
if (!trimmed || trimmed === 'exit') {
  console.log('Bye!');
  await gateway.stopAll();
  await pluginManager.unloadAll();
  rl.close();
  return;
}
```

**为什么不复用 shutdown()**——REPL 的 exit 是"用户主动退"、跟 SIGINT 的"信号触发退"是两条路径。**显式写清理、比隐式 fall-through 更好读**——三个月后回看代码不用去猜 shutdown 有没有被调到。

## 6. 内置样本：FeishuChannel + Dashboard

`src/channels/feishu.ts` 用 lark SDK 长连接模式接飞书：

**订阅端（收消息）**——注册 `im.message.receive_v1` 事件：

```ts
dispatcher.register({
  'im.message.receive_v1': (data) => {
    if (data.message.message_type !== 'text') return;
    const content = JSON.parse(data.message.content);
    let text = content.text || '';
    // 去掉 @Bot 的 mention 标记
    if (data.message.mentions) {
      for (const m of data.message.mentions) {
        text = text.replace(m.key, '').trim();
      }
    }
    if (text && this.messageHandler) {
      this.messageHandler({
        channelId: data.message.chat_id,
        senderId: data.sender.sender_id?.open_id || 'unknown',
        senderName: data.sender.sender_id?.open_id || 'unknown',
        text,
        raw: data,
      });
    }
  },
});
```

**几个隐性设计**：

- **`if (data.message.message_type !== 'text') return`** —— 只处理文本、图片/文件不解析、避免下游拿到不能处理的内容
- **去 mention 标记** —— 飞书文本里 `@Bot` 是特殊 token `${AtBot_xxx}`、要显式移除，不然 LLM 会把 "@AtBot" 当成用户输入
- **`open_id` 作为 senderId** —— 稳定跨会话、跟"每 sender 独立 session"对齐

**发送端**——用 REST API：

```ts
await this.larkClient.im.message.create({
  params: { receive_id_type: 'chat_id' },
  data: {
    receive_id: message.channelId,
    msg_type: 'text',
    content: JSON.stringify({ text: message.text }),
  },
});
```

**Dashboard** —— `startDashboard()` 用 `node:http` 起一个最小 HTTP 服务器（零依赖）、展示"是否配置飞书 / 长连接是否建立 / Dashboard 端口"。**打开 http://localhost:3000 就能看到状态面板**——不用登飞书就能确认服务活着。

**长连接 vs Webhook**——飞书两种事件订阅方式：

- **长连接（WebSocket）**：SDK 主动连飞书服务端、事件推过来——**本地开发不用 ngrok**、零外网暴露
- **Webhook**：飞书发 POST 请求到你的公网 URL——生产更稳定、但本地开发需要 ngrok 隧道

**教学项目用长连接**——本地一键跑通、心智负担最低。

## 7. 接一个新 Channel 需要写什么

Channel 抽象的价值在于**接新通道成本低**——加 Slack / Discord / 邮件 只需要：

**① 写一个类实现 `ChannelDefinition`**：

```ts
class SlackChannel implements ChannelDefinition {
  name = 'slack';
  description = 'Slack Bot';
  private messageHandler?: (msg: IncomingMessage) => void;

  constructor(private config: SlackConfig) {}

  onMessage(handler: (msg: IncomingMessage) => void) {
    this.messageHandler = handler;
  }

  async start() {
    // 连 Slack RTM / Events API
    // 收到消息时构造 IncomingMessage、调 this.messageHandler(...)
  }

  async stop() {
    // 断连 / 释放资源
  }

  async send(message: OutgoingMessage) {
    // 调 Slack chat.postMessage API
  }
}
```

**② index.ts 里 register**：

```ts
gateway.register(new SlackChannel({ token: process.env.SLACK_TOKEN! }));
```

**完了**——不用改 gateway、不用改 agentLoop、不用改 plugin / memory / RAG。**这就是抽象层的价值**。

## 8. 已知的坑与后续方向

### 8.1 Session 无限膨胀——没有 LRU

每个 `(channel, sender)` 都会生成一个 session、**永不清理**。一个飞书群 1000 个用户 * 每人几十 KB messages = 几十 MB 常驻内存。

**修法**：给 sessions Map 加 LRU + TTL——比如超过 7 天没活跃就淘汰。或者更好——**把 channel session 也接入 [SessionStore](session-persistence.md)**、落盘、进程重启不丢历史。**当前没做**、教学场景够跑就行。

### 8.2 Session 无持久化——重启就丢

跟 REPL 的 [SessionStore](session-persistence.md) 一样问题、但 channel 更严重——**REPL 用户还知道自己"重启了"**、飞书用户看到的现象是"机器人失忆了"。

**修法**：channel session key 走同一套 JSONL store、加载时按 key restore、每条消息 append。**当前没做**。

### 8.3 消息合并——并发处理还是串行

一个用户连发 3 条消息、当前实现是 **3 个 handleIncoming 并发跑**——如果第一条 loop 还没结束、第二条已经开始改同一个 session.messages、会数据竞争。

**修法**：per-session 加 Promise queue——同一个 session 的消息串行、不同 session 并发。**当前没做**——飞书用户手速一般跟不上 loop 速度、隐性 bug 但暂未暴露。

### 8.4 消息类型窄——只处理文本

飞书传图片 / 表格 / 文件——现在直接 `return` 忽略。**修法**：`IncomingMessage` 结构里加 `attachments` / `type` 字段、feishu 把 raw 里的富媒体信息带出来、下游看情况处理（比如 vision LLM 能处理图片）。

### 8.5 回复格式单一——只发文本

`OutgoingMessage.text` 只支持纯文本、发不了飞书 rich text card / 交互式按钮。**修法**：加 `blocks?: unknown[]` 字段、由 channel 层负责翻译成各自的原生格式。

### 8.6 Dashboard 只能看不能操作

Dashboard 现在只显示状态——不支持"从网页手动发一条消息给某个 senderId"、也不支持"查看某个 session 的历史"。**是 debug 场景的实用工具方向**、但优先级低。

### 8.7 REPL vs Channel 现在是两条并列路径——没抽出共性

理论上"REPL 也是一个 channel"——但当前实现里 REPL 走的是 `rl.question(...)` + 全局 `messages` + 全局 `budget`、channel 走的是 gateway + 独立 session。**两套代码路径**。

**理想的重构**：REPL 也实现 `ChannelDefinition`、`stdin` 上一条消息就 emit onMessage、`stdout` 上打印就是 send——**整个 Agent 只有一条消息处理链路**。**没做的原因**：REPL 有太多特殊逻辑（快捷命令 dispatcher、`makePromptCtx` 用全局 messages.length、`printSessionDebug` 等）、抽象出去要动的地方太多、当前分层已经够跑。

---

## 9. 前瞻：Channel 作为 Plugin 的扩展点

回顾 [Plugin 那一篇](plugin-system-design.md) 我们留了个伏笔——**`PluginApi` 未来能注册更多类型的能力**。Channel 实现之后、两者的集成路径就很清晰了：**往 `PluginApi` 加一个 `registerChannel` 方法、Plugin 就能动态注册通道**。

未来的 `PluginApi` 可以扩展成这样：

```ts
interface PluginApi {
  registerTools(tools: ToolDefinition[]): void;
  registerChannel(channel: ChannelDefinition): void;   // ← 新增
  getConfig(): PluginConfig;
  log(message: string): void;
}
```

一个 Telegram Plugin 就长这样：

```ts
const telegramPlugin: PluginDefinition = {
  name: 'telegram',
  version: '1.0.0',
  description: 'Telegram Bot 通道',

  activate(api: PluginApi) {
    const channel = new TelegramChannel({
      botToken: api.getConfig().botToken as string,
    });
    api.registerChannel(channel);
    api.log('Telegram 通道已注册');
  },
};
```

**用户装上这个 Plugin、Agent 就自动多了一个 Telegram 通道**——不需要改核心代码、不需要重新部署、动态加载完事。

**这也是为什么我们把 Channel 设计成接口而不是具体实现**——`ChannelDefinition` 就像一份契约、只要适配器满足 `start` / `stop` / `send` / `onMessage` 这几个方法、Gateway 都能统一调度。

**关键洞察**：**把接口暴露给 Plugin、就等于把整个扩展点开放给生态**。任何人写一个 npm 包实现 `ChannelDefinition`、通过 Plugin 挂进来、就能给 Agent 加新入口——**跟这个项目的开发者完全无关**。这是 [Plugin 那一篇讲的"API 隔离层"](plugin-system-design.md#3-决策二api-隔离层pluginapi) 真正兑现价值的地方。

---

## 回顾

**Channel 系统跟前面所有系统一样、要传递一个具体原则**：

- **Tool 抽象让"Agent 能做什么"可扩展**——加个 tool 定义就行
- **Plugin 抽象让"能力包"可扩展**——加个 PluginDefinition 就行
- **Channel 抽象让"Agent 服务谁"可扩展**——加个 ChannelDefinition 就行

**共同的模式**：**定义一个稳定的接口、内部实现只依赖这个接口、外部实现按接口挂上来**。这条原则**跟 Agent 完全无关**——写 Web 框架、编辑器、任何有扩展性需求的系统都适用。

一个略微反常识的结论：**"能力"和"入口"必须分开抽象**——很多系统把两者混在一起（比如 "Slack bot 里可以查 Notion" 被塞成一个 monolithic 集成）、看起来简单、但随着 channel 或能力变多、组合爆炸——n 个 channel × m 个能力 = n×m 份代码。**分开抽象后是 n + m**、这是核心的架构杠杆。
