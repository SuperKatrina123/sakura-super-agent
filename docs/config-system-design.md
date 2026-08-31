# 配置系统：从硬编码到配置驱动

> 配套 [../README.md](../README.md) 的拓展阅读。前面十几篇讲的是**造能力**——工具、记忆、通道、定时、子 Agent。这一篇讲**把所有能力做成可配置**：为什么运维不该看代码、Zod + 环境变量替换 + 默认值合并的三段管线、`enabled` 开关让子系统"关了就完全不初始化"、interactive init 向导让"用户零门槛上手"。

## 目录

- [0. 为什么需要配置系统](#0-为什么需要配置系统)
- [1. 三件事的顺序：读 → 替换 → 校验](#1-三件事的顺序读--替换--校验)
- [2. Zod schema：唯一事实源](#2-zod-schema唯一事实源)
- [3. 环境变量替换：${VAR} 语法](#3-环境变量替换var-语法)
- [4. enabled 开关：条件初始化](#4-enabled-开关条件初始化)
- [5. Interactive Init 向导](#5-interactive-init-向导)
- [6. 入口分层：router / main / init](#6-入口分层router--main--init)
- [7. 已知的坑与后续方向](#7-已知的坑与后续方向)

## 0. 为什么需要配置系统

**翻一下前面几章的 index.ts、硬编码到处都是**：

```ts
// 模型地址、模型名硬编码
const deepseek = createOpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});
const model = process.env.DEEPSEEK_API_KEY
  ? deepseek.chat('deepseek-v4-flash')
  : createMockModel();

// 子 Agent 参数硬编码
const subAgentRegistry = new SubAgentRegistry({ maxSpawnDepth: 1, maxConcurrent: 3 });

// 飞书端口硬编码
const FEISHU_PORT = Number(process.env.FEISHU_PORT || '3000');

// 插件列表硬编码
const defaultPlugins: PluginDefinition[] = [supabasePlugin];

// Cron 数据目录硬编码
const cronService = new CronService('.');
```

**每改一处都要动代码、重新部署**——运维层的可调参数被埋在代码层里、非开发者根本没法动。

**核心洞察**：**代码是"能做什么"、配置是"当前怎么做"**——两者混在一起、就是把"运维决策"绑在了"代码逻辑"上。

**配置化的真正价值**：**让运维和使用者不需要理解代码就能调整行为**。

## 1. 三件事的顺序：读 → 替换 → 校验

`loadConfig()` 的三步管线、**顺序很重要**：

```ts
// src/config/loader.ts
export function loadConfig(path = CONFIG_FILE): SuperAgentConfig {
  // ① 读 JSON
  if (!fs.existsSync(path)) {
    console.log(`  未找到 ${path}，使用默认配置`);
    return SuperAgentConfigSchema.parse({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`  ✗ 解析 ${path} 失败: ${(err as Error).message}`);
    process.exit(1);
  }

  // ② 替换 ${ENV_VAR}
  const substituted = substituteEnvVars(raw);

  // ③ Zod 校验 + 默认值合并
  const result = SuperAgentConfigSchema.safeParse(substituted);
  if (!result.success) {
    console.error('  ✗ 配置文件校验失败:');
    for (const issue of result.error.issues) {
      console.error(`    ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  console.log(`  ✓ 已加载 ${path}`);
  return result.data;
}
```

**为什么顺序是"替换在校验之前"**：

配置里写 `"apiKey": "${DASHSCOPE_API_KEY}"`——**这是字面字符串、schema 会认为"apiKey 是字符串"通过**、但真实值是**运行时替换出来的**。

**如果顺序反了**：先校验、再替换——**schema 里没法约束"apiKey 是有效的 API key"**、因为校验时看到的是占位符。反过来先替换、`substituteEnvVars` 把 `${DASHSCOPE_API_KEY}` 换成真实值、然后 schema 校验的是**真实值**——能捕获"环境变量确实设了、但值为空字符串"这种问题。

**顺序的哲学**：**校验必须发生在数据变形之后**、不然就是校验中间态、白费功夫。

## 2. Zod schema：唯一事实源

**为什么用 Zod 而不是自己写 validator**：

**Zod 把"类型 + 校验 + 默认值 + TypeScript 类型推导"绑在一起**——一份 schema、四个用途：

```ts
// src/config/schema.ts
export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),          // ← 校验 + 默认值
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  port: z.number().default(3000),
});

export const SuperAgentConfigSchema = z.object({
  version: z.string().default('1.0'),
  model: ModelConfigSchema.default({}),
  channels: ChannelConfigSchema.default({}),
  agents: AgentConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  rag: RagConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  // ...
});

// TypeScript 类型自动推导
export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;
```

**四个价值**：

**① 校验错误自动带路径**

```
  ✗ 配置文件校验失败:
    channels.feishu.port: Expected number, received string
    agents.maxSpawnDepth: Number must be greater than 0
```

用户看到 `channels.feishu.port` 就知道哪儿写错了——**比"配置文件有问题、请检查"友好一万倍**。

**② 默认值合并是天然的**

配置文件只需要写"跟默认不一样的部分"、其他 Zod 自动填。极端情况：**空配置文件 `{}` 也能启动**——所有默认值就位：

```ts
if (!fs.existsSync(path)) {
  return SuperAgentConfigSchema.parse({});  // ← 空对象、拿到全默认
}
```

**③ TypeScript 类型跟着走**

代码里读 `config.channels.feishu.port`——IDE 补全 + 类型检查全有。**没有"配置和代码类型不一致"的漂移**——**schema 是唯一事实源**。

**④ 校验和默认值绑在一起**

传统做法：schema 说"这个字段必填"、代码里再写 `port = cfg.port ?? 3000` 兜底——**两处都要维护、一改容易漏**。

Zod 里 `port: z.number().default(3000)`——**默认和类型在同一处声明**、永远不漂移。

## 3. 环境变量替换：${VAR} 语法

**为什么需要**：

- **配置文件要 commit 到 git**——不能塞 API key / secret
- **不同环境不同值**——开发用测试 key、生产用真实 key、代码不动

**方案**：配置里写占位符、运行时替换：

```json
{
  "model": {
    "apiKey": "${DASHSCOPE_API_KEY}"
  },
  "channels": {
    "feishu": {
      "appId": "${FEISHU_APP_ID}",
      "appSecret": "${FEISHU_APP_SECRET}"
    }
  }
}
```

**递归遍历 + 大写限制**：

```ts
// src/config/loader.ts
const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(ENV_VAR_RE, (match, name) => {
      const val = process.env[name];
      if (val === undefined) {
        console.warn(`  ⚠ 环境变量 ${name} 未设置，保留原值`);
        return match;
      }
      return val;
    });
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }
  return obj;
}
```

**两个设计细节**：

**① 只匹配大写字母 + 下划线（`[A-Z_][A-Z0-9_]*`）**

**OpenClaw 也在用的约定**——**环境变量统一大写**、避免误替换正常文本中的 `${}` 模式（比如描述里的 `${task}` 是模板变量、不是环境变量）。

**② 缺失时打 warning 但保留原值**

不 throw、不静默填空——**保留 `${VAR}` 原样**、让下游（Zod schema）根据字段是否必填来决定报错还是走默认值。**"缺失"的语义应该由 schema 定义、不该由替换器擅自决定**。

**Plugin 系统里已经有一份类似的实现**（见 [plugin-system-design.md](plugin-system-design.md)）—— 未来可以抽到 `src/config/env-interpolation.ts`、两处共用。当前教学项目留着两份、能跑就行。

## 4. enabled 开关：条件初始化

**旧代码**：不管用不用、都创建实例——

```ts
// 旧：不管是否用飞书都创建实例、占 3000 端口
const feishuChannel = new FeishuChannel({
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
  port: 3000,
});
gateway.register(feishuChannel);
```

**新代码**：只在 enabled 时才实例化——

```ts
// 新：完全跳过初始化
if (config.channels.feishu.enabled) {
  const feishuChannel = new FeishuChannel({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
    port: config.channels.feishu.port,
  });
  gateway.register(feishuChannel);
}
```

**语义差别很大**：
- 旧：**创建 FeishuChannel 实例 + 启动 HTTP 服务在 3000 端口**——即便不用飞书、端口也被占了、内存也在
- 新：**"关了"就是"完全不存在"**——零端口、零内存、零心智负担

**几个子系统都上了这个开关**：

```ts
// Cron
if (config.cron.enabled) {
  // ... executor 注入 + load + start
}

// RAG
if (config.rag.enabled) {
  const store = await buildSqliteIndex({ docsDir: config.rag.docsDir, provider: ragProvider });
  registry.register(createRagSearchTool(store, ragEmbedder));
}

// Security hook
if (config.security.auditLog) {
  registry.hooks.registerPost('audit-log', auditLogHook);
}

// Plugin 逐个开关
for (const pluginCfg of config.plugins) {
  const def = availablePlugins.get(pluginCfg.name);
  if (!def) { console.log(`  ✗ ${pluginCfg.name} — 未知插件`); continue; }
  if (!pluginCfg.enabled) { console.log(`  - ${pluginCfg.name} — 已禁用`); continue; }
  await pluginManager.load(def);
}
```

**enabled 开关的哲学**：**关闭 = 不存在**、而不是"存在但不用"。这个区别在**运维层面很关键**——机器上不再有幽灵进程、不再有闲置端口、不再有无用日志。

**一个反直觉的洞察**：**"关了就完全不初始化"这个能力、只有在配置化之后才能真正做到**。硬编码时代**代码里没有开关**——想关一个子系统只能删代码或者注释掉、每次改配置都要重新部署。

## 5. Interactive Init 向导

**问题**：用户第一次用 Super Agent、不应该让他手动写 JSON。

**方案**：**交互式向导**引导用户走完所有关键配置：

```ts
// src/config/init.ts (简化)
export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => { console.log(q); rl.question('  > ', resolve); });

  // ── 覆盖确认 ──
  if (fs.existsSync(CONFIG_FILE)) {
    const overwrite = await ask(`  ${CONFIG_FILE} 已存在，覆盖? (y/N): `);
    if (overwrite.toLowerCase() !== 'y') return;
  }

  // ── 模型选择（预设候选）──
  console.log('  选择模型:');
  console.log('    1. qwen-plus-latest');
  console.log('    2. qwen-turbo-latest');
  console.log('    3. qwen-max-latest');
  const modelChoice = (await ask('  模型 [1]: ')) || '1';
  const modelName = { '1': 'qwen-plus-latest', /* ... */ }[modelChoice];

  // ── API Key ──
  const apiKey = await ask('\n  DashScope API Key (留空则从环境变量读取): ');

  // ── 飞书 Channel ──
  const enableFeishu = (await ask('\n  启用飞书 Channel? (y/N): ')).toLowerCase() === 'y';
  // ...

  // ── 生成配置 ──
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  if (apiKey) fs.writeFileSync('.env', `DASHSCOPE_API_KEY=${apiKey}\n`);
  console.log('\n  启动 Agent: pnpm start\n');
}
```

**几个关键设计**：

**① 预设候选比自由输入友好**

模型名不让用户手写——**"1 / 2 / 3"选一个**、避免拼写错误。

**② 默认值走中括号提示**

`模型 [1]:` —— 直接回车用 `[1]`、不用重复打字。**降低走完向导的心力成本**。

**③ 空输入 = 走默认**

不强制用户填、留空走 `${DASHSCOPE_API_KEY}` 占位符——**"我知道要配、但暂时不想"的场景也支持**。

**④ 顺带生成 .env**

用户填了 API key、`init.ts` 自动写 `.env`——**不用让用户手动创建**。**降低门槛比追求 100% 灵活性更重要**。

## 6. 入口分层：router / main / init

配置系统改完后、**入口需要重新分层**：

```
src/index.ts   ← 8 行、只做路由（init / start）
    ↓
    ├── src/config/init.ts  ← 交互式向导、生成 config
    └── src/main.ts         ← startAgent() 主入口、按 config 初始化所有子系统
```

**`index.ts`（22 行）**：

```ts
const command = process.argv[2];

if (command === 'init') {
  import('./config/init.js').then(m => m.runInit());
} else {
  import('./main.js').then(m => m.startAgent().catch(console.error));
}
```

**三个好处**：

**① 关注点分离**——index 只管路由、main 只管启动、init 只管向导。**每个文件一件事**、改起来清晰。

**② 测试友好**——`startAgent` 可以直接被单测调用、不需要走 CLI 参数。

**③ 动态 import 延迟加载**——`import('./main.js')` 是动态 import、**跑 init 时不加载 main.ts**——**跑 init 快得多**（不用等 ToolRegistry、MCP 客户端、RAG 索引这些全部初始化）。

**CLI 命令**：

```
pnpm init            → 交互式向导、生成 super-agent.config.json + .env
pnpm start           → 读 config + 启动 Agent
pnpm start --continue → 恢复上次 session
```

## 7. 已知的坑与后续方向

### 7.1 两份环境变量替换实现

- `src/config/loader.ts` 里的 `substituteEnvVars`
- `src/plugins/manager.ts` 里的 `resolveEnvVars`

**当前教学项目留着两份**——想 DRY 就抽到 `src/config/env-interpolation.ts`、两处 import。**没做的原因**：Plugin 系统的实现有细微差别（只匹配"整个 value 是占位符"、不递归）、抽出来要先对齐语法。

### 7.2 缺失环境变量的语义

现在缺失时：
- Loader 打 warning、保留 `${VAR}` 原样
- Zod schema 收到字面字符串、按 `default('')` 走空

**问题**：**没法区分"用户忘了配"和"用户故意留空"**——两种情况都是空字符串。

**改进方向**：
- `${VAR!}` 语法表示必填、缺失时 loader throw
- `${VAR:-fallback}` 语法表示"缺失时用 fallback"
- 保持默认行为兼容旧配置

### 7.3 配置热重载

**当前只在启动时读一次**——改 config 得重启。生产可能想"改 feishu 端口不重启"、需要：
- fs.watch 监听 config 文件变化
- diff 变化的字段、按字段决定是否需要重启对应子系统

**教学项目不做**——重启两秒的事、优先级低。

### 7.4 配置文件加密

**secret 字段**（appSecret、apiKey）虽然走 env、**但如果用户直接把值写死在 config 里怎么办**？

- **警告**：loader 里发现 secret 字段是明文（不是 `${...}`）、打警告
- **加密**：用 SOPS 或 age 加密整个 config、启动时解密——**过度设计**、教学不做

### 7.5 多环境配置

生产 / staging / dev 三套配置——当前只有一个 `super-agent.config.json`。

**候选**：
- `super-agent.dev.config.json` / `super-agent.prod.config.json` + `NODE_ENV` 切换
- `super-agent.config.json` + `super-agent.local.config.json` 覆盖模式

**没做**——教学项目一套够用、真上生产要加。

### 7.6 CLI 参数覆盖 config

跟 [12-factor app](https://12factor.net/) 对齐——`pnpm start --model qwen-max-latest` 应该覆盖 config 里的 model.name。当前只支持 `--continue`——**扩展方向**：yargs / commander 加参数解析。

### 7.7 内置 plugin 列表还是硬编码

```ts
const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
]);
```

**这里是"代码级决策"、不是运维参数**——加新 plugin 需要写 `import` 加到 map 里。**跟 config 无关**——config 只决定"启用哪些已知 plugin"、不决定"存在哪些 plugin"。

**真正的动态 plugin 加载**（scan 目录 / npm 安装）是 Plugin 系统的下一步、[Plugin 那节](plugin-system-design.md#8-已知的坑与后续方向) 有讨论。

---

## 回顾：配置化是最后一公里

**这一篇是这个项目最后一个改造**——**从"演示原型"到"可交付产品"的分水岭**。

回看前面十几篇——每一篇都在**造一个能力**：工具、记忆、通道、定时、Plugin、Channel、Cron、SubAgent、安全、Skill、RAG、Memory ...。**都是往 Agent 里加东西**。

**配置化不是加能力、是让所有能力"可运维"**：

- **能改**：不用重新部署就能改行为
- **能关**：不需要的子系统"完全不存在"、零占用
- **能给非开发者用**：向导 → 配置 → 启动、零代码知识

**"能不能配置"是"内部工具"和"可交付产品"的界线**。教学项目走到这里、你手上的 Agent 才真正成为一个**别人也能用**的东西。

**几个可迁移的原则**：

1. **schema 是唯一事实源** —— 类型 / 校验 / 默认值 / TypeScript 类型推导四合一
2. **顺序：读 → 变形 → 校验** —— 校验必须发生在数据变形之后
3. **enabled 开关 = 完全不存在** —— 关闭不是"存在但不用"、是"根本不实例化"
4. **交互式向导降低门槛** —— 别让用户手写 JSON
5. **动态 import 分层入口** —— router 只做路由、main / init 各自懒加载

**这些原则跟"是不是 Agent"无关**——CLI 工具、服务器、GUI 应用、任何需要配置的系统都适用。
