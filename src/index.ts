import 'dotenv/config'
;(globalThis as any).AI_SDK_LOG_WARNINGS = false
import { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'node:readline';
import process from 'node:process';
import { ToolRegistry } from './tools/tool-registry.ts';
import { allTools, pickSearchTool } from './tools/index.ts';
import { simulatedMcpTools } from './tools/simulated-mcp.ts';
import { createToolSearchTool } from './tools/tool-search.ts';
import { createMemoryTool } from './tools/memory-tools.ts';
import { MemoryStore } from './memory/store.ts';
import { agentLoop, type BudgetState } from './agent/loop';
import { MCPClient } from './mcp/client.ts';
import { SDKMCPClient } from './mcp/sdk-client.ts';
import { MockMCPClient } from './mcp/mock-client.ts';
import { SessionStore } from './session/store.ts';
import { PromptBuilder } from './context/prompt-builder.ts';
import { coreRules, toolGuide, sessionContext, deferredTools } from './context/segments.ts';
import { memoryContext, ragContext, skillsContext } from './context/prompt-pipes.ts';
import { markMessageTime } from './session/defense.ts';
import { UsageTracker } from './session/usage-tracker.ts';
import { createDispatcher, type CommandContext } from './commands/index.ts';
import { statusHandler, contextHandler, usageHandler } from './commands/view.ts';
import { simHandler, defendHandler } from './commands/defense.ts';
import { cacheOffHandler, cacheOnHandler, cacheStatusHandler } from './commands/cache.ts';
import { memoryListHandler, memorySearchHandler, memoryReadHandler, memoryForgetHandler, memoryLintHandler, memoryDreamHandler } from './commands/memory.ts';
import { skillListHandler, skillLoadHandler, skillUnloadHandler, skillShortcutHandler } from './commands/skill.ts';
import { SkillLoader } from './skills/loader.ts';
import { createSkillLoadTool } from './tools/skill-tools.ts';
import { PluginManager } from './plugins/manager.ts';
import { supabasePlugin } from './plugins/supabase-plugin.ts';
import type { PluginDefinition } from './plugins/types.ts';
import { createPluginCommands } from './commands/plugin.ts';
import { buildSqliteIndex } from './rag/build-sqlite.ts';
import { SqliteVectorStore } from './rag/sqlite-store.ts';
import { createMockEmbedder, createDashScopeEmbedder } from './rag/embedder.ts';
import { createRagSearchTool } from './tools/rag-tools.ts';

const deepseek = createOpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY
});

const model = process.env.DEEPSEEK_API_KEY ? 
    deepseek.chat('deepseek-v4-flash') 
    : createMockModel();

const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
})

const registry = new ToolRegistry();
registry.register(...allTools, pickSearchTool());

// MemoryStore：跨会话记忆——.memory/ 目录下的索引 + 分散 markdown 文件
// 挂在项目根：跟着项目走、可 commit 到 git
const memoryStore = new MemoryStore('.');

// SkillLoader：.skills/ 目录下的可复用工作流——用 markdown 定义、渐进式加载
// 启动时扫全部 SKILL.md、解析 frontmatter 元数据；body 只在激活后进 SYSTEM
const skillLoader = new SkillLoader('.');
skillLoader.load();

// 元工具最后注册——都要闭包运行时组件引用
registry.register(createToolSearchTool(registry));
registry.register(createMemoryTool(memoryStore));
registry.register(createSkillLoadTool(skillLoader));

// ═══════════════════════════════════════════════════════════════════════════
// Plugin 系统
// ═══════════════════════════════════════════════════════════════════════════
// PluginManager 是 Plugin 与 Agent 内部的唯一通道——通过 PluginApi 受控暴露能力
// 三大保证：工具名 pluginName__ 前缀防冲突、config 里 ${ENV} 占位自动解析、错误隔离
//
// availablePlugins：项目"注册表"——列出所有已知 plugin、REPL 里可 /plugin load 激活
// 启动时可以选一批默认加载（比如 supabase）；也可以留空、全靠 REPL 手动激活
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
]);
// 启动时默认加载哪些 plugin——教学演示：把 supabase 直接加载、Agent 一进 loop 就能用
const defaultPlugins: PluginDefinition[] = [supabasePlugin];

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  // 检测运行环境是否支持 spawn 子进程——部分沙箱环境（浏览器、受限容器）不支持
  let canSpawn = true;
  try {
    const { execSync } = await import('node:child_process');
    execSync('echo test', { stdio: 'ignore' });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    // MCP_CLIENT_KIND: 'sdk'（默认，生产推荐）| 'handwritten'（教学版，看协议细节）
    const kind = process.env.MCP_CLIENT_KIND === 'handwritten' ? 'handwritten' : 'sdk';
    console.log(`\n连接 GitHub MCP Server (client: ${kind})...`);
    try {
      const client = kind === 'sdk'
        ? new SDKMCPClient(
            'npx', ['-y', '@modelcontextprotocol/server-github'],
            { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
          )
        : new MCPClient(
            'npx', ['-y', '@modelcontextprotocol/server-github'],
            { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
          );
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
      console.log('  降级为 Mock MCP...');
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
  }

  const mockClient = new MockMCPClient();
  const tools = await registry.registerMCPServer('github', mockClient);
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// 制造工具膨胀场景——注入 11 个模拟 MCP 工具（notion / browser / supabase）
// 全部 shouldDefer: true，用来演示"工具太多时 ToolSearch 的价值"
function registerSimulatedTools() {
  registry.register(...simulatedMcpTools);
  console.log(`\n注入 ${simulatedMcpTools.length} 个模拟 MCP 工具（全部 shouldDefer）`);
}

const searchProvider = process.env.TAVILY_API_KEY ? 'Tavily (自动挡)'
                     : process.env.SERPER_API_KEY ? 'Serper (手动挡)'
                     : '未配置 (默认 Tavily，调用会提示配 key)';
console.log(`\n[web_search] 当前后端：${searchProvider}`);

async function main() {
  await connectMCP();
  registerSimulatedTools();

  // Plugin 默认加载——错误隔离：一个失败不影响其他
  // 每个 plugin 独立 try/catch、失败只 log、不阻塞主流程
  console.log(`\n加载默认 Plugins (${defaultPlugins.length} 个)...`);
  for (const def of defaultPlugins) {
    try {
      const tools = await pluginManager.load(def);
      console.log(`  ✓ ${def.name} v${def.version} — 注册 ${tools.length} 个工具`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${def.name} 加载失败: ${msg}`);
    }
  }

  // RAG 索引：启动时扫 docs/、chunk、embed、灌进 SQLite 三表
  // SQLite 持久化：进程退出后知识库还在、无需重新 embed
  // 用 DASHSCOPE_API_KEY 走真实 embedding、否则降级到 mock
  const provider = process.env.DASHSCOPE_API_KEY ? 'dashscope' : 'mock';
  const store = await buildSqliteIndex({ docsDir: 'docs', provider });
  // 把 store 塞进 ragStoreRef——让 pipe 拿到 store 引用
  ragStoreRef.store = store;

  // 挂 rag_search 工具——Agent 通过它检索项目文档知识库
  // 用同一个 embedder：query 必须跟 chunks 用同一 provider 才能 cosine 匹配
  const ragEmbedder = provider === 'dashscope' && process.env.DASHSCOPE_API_KEY
    ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
    : createMockEmbedder();
  registry.register(createRagSearchTool(store, ragEmbedder));

  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();

//   console.log(`\n=== 工具统计 ===`);
//   console.log(`  全部工具: ${allCount} 个`);
//   console.log(`  活跃工具: ${activeTools.length} 个（直接进 system prompt）`);
//   console.log(`  延迟工具: ${allCount - activeTools.length} 个（走 tool_search 按需激活）`);
//   console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`);
//   console.log(`  节省比例: ~${Math.round(estimate.deferred / estimate.total * 100)}%`);

  // Prompt Pipe 启动时打一次——用当前状态（工具都注册完 + session 恢复完）预览 SYSTEM 长啥样
  // 每轮的实时 debug 目前不打，需要时可以在 ask() 里加 promptBuilder.debug(ctx)
  promptBuilder.debug({
    toolCount: registry.getAll().length,
    deferredTools: registry.getDeferredTools(),
    sessionMessageCount: messages.length,
    sessionId: 'default',
  });

  // 应用退出前关掉所有 MCP 子进程 + 卸载所有 Plugin，避免留下孤儿资源
  // Plugin 的 destroy 用于释放 DB 连接池、WebSocket、setInterval 等长生命周期资源
  // unloadAll 内部对每个 plugin 独立 try/catch——一个 destroy 出错不影响其他
  const shutdown = async () => {
    await pluginManager.unloadAll();
    await registry.closeAllMCP();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  rl.on('close', shutdown);

  console.log('\nRegistey Tools...');
  ask();
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

// Session 持久化：默认新会话，加 --continue 恢复
// budget 和 discoveredTools 目前不持久化——重启后从零开始（已知限制）
const isContinue = process.argv.includes('--continue');
const store = new SessionStore('default');

let messages: ModelMessage[] = [];
if (isContinue && store.exists()) {
  messages = store.load();
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
} else {
  console.log(`[Session] 新会话`);
}

// Session 调试信息——启动时打印一次，方便排查文件路径 / 历史膨胀 / 消息分布
// 空会话也打（能看到"文件会写到哪"，避免下次又"找不到 jsonl"）
printSessionDebug();
printMemoryDebug();

function printSessionDebug() {
  const s = store.stats();
  const kb = (s.bytes / 1024).toFixed(1);
  const roles = Object.entries(s.roleBreakdown)
    .map(([r, n]) => `${r} × ${n}`)
    .join(' / ') || '(空)';
  const timespan = s.firstTimestamp && s.lastTimestamp
    ? `${s.firstTimestamp} → ${s.lastTimestamp}`
    : '(无消息)';
  console.log(`\n=== Session Debug ===`);
  console.log(`  文件路径: ${s.absolutePath}`);
  console.log(`  文件大小: ${kb} KB`);
  console.log(`  消息分布: ${roles}`);
  console.log(`  时间跨度: ${timespan}`);
  console.log(`======================`);
}

// Memory 调试——跟 session debug 一致的风格
// 让"记忆存哪了、有多少条"一眼可见
function printMemoryDebug() {
  const s = memoryStore.stats();
  const byType = `user × ${s.byType.user} / feedback × ${s.byType.feedback} / project × ${s.byType.project} / reference × ${s.byType.reference}`;
  console.log(`\n=== Memory Debug ===`);
  console.log(`  索引路径: ${s.indexPath}`);
  console.log(`  条目总数: ${s.count}`);
  console.log(`  分类分布: ${byType}`);
  console.log(`=====================`);
}
// Prompt Pipe：把 SYSTEM 拆成 6 个独立 segment，每个自己决定要不要出现
// 顺序即 cache 策略——越少变的越靠前，最大化 prompt cache 前缀命中
// memory / rag 两轮之间可能变、一轮内稳定；deferredTools 一轮内会变（tool_search 激活）
//
// ragStoreRef：pipe 顶层声明时 store 还没建（要等 main() 里 buildSqliteIndex）
// 用 mutable ref + getter 让 pipe 延后拿到 store 实例——避免"pipe 声明依赖异步初始化"
const ragStoreRef: { store: SqliteVectorStore | null } = { store: null };

const promptBuilder = new PromptBuilder()
  .pipe('coreRules', coreRules())                     // 永远不变——cache 稳稳命中
  .pipe('toolGuide', toolGuide())                     // 工具数量基本固定，变化很少
  .pipe('memoryContext', memoryContext(memoryStore))  // 两轮之间可能变、一轮内稳定
  .pipe('skillsContext', skillsContext(skillLoader))  // skill 索引 + 激活的 body
  .pipe('ragContext', ragContext(() => ragStoreRef.store))  // 知识库声明——启动后一轮内不变
  .pipe('deferredTools', deferredTools())             // 一轮内可能变（tool_search 激活）
  .pipe('sessionContext', sessionContext());          // 每轮变（messageCount）——最后
// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = { used: 0, limit: 600000 };

// Cache 可视化：UsageTracker 跨轮持续累计四类 token + 成本
// modelInfo 明确告诉 agentLoop 当前跑什么——用来查价目表 + 走 provider 特化归一化
const usageTracker = new UsageTracker();

// Cache 实验开关：'cache off' 命令切换、agentLoop 里给 SYSTEM 加 nonce 破坏 cache
// 让"cache 有多值钱"变成可实测的对照实验
// Cache 实验开关——用对象包装成 ref、这样 dispatcher/handler 里改能同步到 agentLoop 读取处
const cacheState = { disabled: false };
const modelInfo = process.env.DEEPSEEK_API_KEY
  ? { provider: 'deepseek', modelName: 'deepseek-v4-flash' }
  : { provider: 'mock', modelName: 'mock-model' };
// 快捷命令 dispatcher——handler 按数组顺序尝试匹配
// 注意：cache off / cache on 必须在裸 cache 之前（前者是更长的精确匹配）
// 同理：memory search / read / forget 必须在裸 memory 之前
const dispatcher = createDispatcher([
  statusHandler, contextHandler, usageHandler,
  simHandler, defendHandler,
  cacheOffHandler, cacheOnHandler, cacheStatusHandler,
  memorySearchHandler, memoryReadHandler, memoryForgetHandler,
  memoryLintHandler,   // "memory lint" / "memory lint prune" 匹配、必须在裸 memory 之前
  memoryDreamHandler,  // "dream" / "memory dream"——Agent 自主整理记忆
  memoryListHandler,   // 裸 "memory" 放最后——避免抢走带参数的命令
  // ── Plugin 命令 ─────────────────────────────────────
  // /plugin / /plugin list / /plugin load <name> / /plugin unload <name>
  // handler 数组内部已按顺序排好：load / unload 先匹配、list 兜底
  ...createPluginCommands(pluginManager, availablePlugins),
  // ── Skill 命令 ──────────────────────────────────────
  skillLoadHandler,     // "/skill load <name>" —— 必须在裸 skill 之前
  skillUnloadHandler,   // "/skill unload <name>"
  skillListHandler,     // "/skill" / "/skill list"
  skillShortcutHandler, // "/<skill-name>" —— **必须放最后**，会尝试匹配任何 slash 命令
]);


function ask() {
    rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit') {
            console.log('Bye!');
            rl.close();
            return;
        }

        // 快捷命令 dispatcher——匹配到就停止 fallthrough，否则走正常对话
        const makePromptCtx = () => ({
            toolCount: registry.getAll().length,
            deferredTools: registry.getDeferredTools(),
            sessionMessageCount: messages.length,
            sessionId: 'default',
        });
        const cmdCtx: CommandContext = {
            messages,
            registry,
            builder: promptBuilder,
            tracker: usageTracker,
            sessionStore: store,
            memoryStore,
            skillLoader,
            makePromptCtx,
            ask,
            cacheState,
            modelInfo,
            model,     // dream / 未来的 async 命令用来触发 agentLoop
            budget,
        };
        if (await dispatcher(trimmed, cmdCtx)) return;


        // 记住 push user 消息前的位置——本轮结束时从这里开始 flush 到磁盘
        // 策略 2：本轮结束一次性 append 新消息。崩溃丢当前轮，退出/Ctrl+C 前正常落盘
        const beforeCount = messages.length;
        const userMsg: ModelMessage = { role: 'user', content: trimmed };
        messages.push(userMsg);
        markMessageTime(userMsg);   // 打时间戳，让 TTL 修剪能识别新旧

        // 每轮都重建 PromptContext——registry/messages 都可能变
        // pipe.build 里 5 个 segment 各自决定要不要出现，最终拼成 SYSTEM
        const promptCtx = {
            toolCount: registry.getAll().length,
            deferredTools: registry.getDeferredTools(),
            sessionMessageCount: messages.length - 1,   // 减去刚 push 的这条 user，反映"历史"
            sessionId: 'default',
        };
        const dynamicSystem = promptBuilder.build(promptCtx);
        await agentLoop(model, registry, messages, dynamicSystem, budget, {
            usageTracker,
            modelInfo,
            cacheDisabled: cacheState.disabled,   // true 时 SYSTEM 前面加 nonce 让 cache 全 miss
        });

        // 本轮所有新消息（user + assistant 若干 + tool 结果若干）落盘
        for (let i = beforeCount; i < messages.length; i++) {
            store.append(messages[i]);
        }

        if (!rl.closed) ask();   // 管道输入 EOF 时 readline 已关闭，跳过避免 ERR_USE_AFTER_CLOSE
    });
};