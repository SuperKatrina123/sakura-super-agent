import 'dotenv/config';
;(globalThis as any).AI_SDK_LOG_WARNINGS = false;
import { ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
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
import { ChannelGateway } from './channels/gateway.ts';
import { FeishuChannel } from './channels/feishu.ts';
import { createChannelCommands } from './commands/channel.ts';
import { createSecurityCommands } from './commands/security.ts';
import { bashSecurityHook, auditLogHook } from './security/built-in-hooks.ts';
import { CronService, type CronExecutor } from './cron/service.ts';
import { createCronCommands } from './commands/cron.ts';
import { SubAgentRegistry } from './agents/registry.ts';
import { createSpawnTool } from './tools/spawn-tools.ts';
import type { SpawnContext } from './agents/spawn.ts';
import { createTestSpawnCommands } from './commands/test-spawn.ts';
import { createAgentCommands } from './commands/agent.ts';
import { buildSqliteIndex } from './rag/build-sqlite.ts';
import { SqliteVectorStore } from './rag/sqlite-store.ts';
import { createMockEmbedder, createDashScopeEmbedder } from './rag/embedder.ts';
import { createRagSearchTool } from './tools/rag-tools.ts';
import { loadConfig } from './config/loader.ts';
import type { SuperAgentConfig } from './config/schema.ts';
import { LocalTraceRecorder } from './trace/recorder.ts';
import { createTraceCommands } from './commands/trace.ts';

// ═══════════════════════════════════════════════════════════════════════════
// createModel —— 根据 config 生成 model 实例、apiKey 缺失自动降级 mock
// ═══════════════════════════════════════════════════════════════════════════
function createModel(cfg: SuperAgentConfig['model']) {
  if (!cfg.apiKey || cfg.apiKey.startsWith('${')) {
    console.log(`  ⚠ 未配置 apiKey、使用 Mock 模型`);
    return createMockModel();
  }
  const provider = createOpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  return provider.chat(cfg.name);
}

// ═══════════════════════════════════════════════════════════════════════════
// startAgent —— 主入口。所有子系统按配置逐个初始化、按 enabled 开关取舍
// ═══════════════════════════════════════════════════════════════════════════
export async function startAgent() {
  const config = loadConfig();

  // ── 模型 ────────────────────────────────────────────
  const model = createModel(config.model);
  const modelInfo = config.model.apiKey && !config.model.apiKey.startsWith('${')
    ? { provider: config.model.provider, modelName: config.model.name }
    : { provider: 'mock', modelName: 'mock-model' };

  // ── ToolRegistry + 内置 hook ──────────────────────
  const registry = new ToolRegistry();
  registry.register(...allTools, pickSearchTool());

  // 三层安全防线的第三层——hook 注册
  // audit-log 是可观测钩子（moderate 命令告警拼进 output）
  // bash-security 是拦截钩子（dangerous block）
  registry.hooks.registerPre('bash-security', bashSecurityHook);
  if (config.security.auditLog) {
    registry.hooks.registerPost('audit-log', auditLogHook);
  }

  // ── Memory / Skill ─────────────────────────────────
  const memoryStore = new MemoryStore(config.memory.dataDir);
  const skillLoader = new SkillLoader('.');
  skillLoader.load();

  // 元工具——闭包运行时组件引用
  registry.register(createToolSearchTool(registry));
  registry.register(createMemoryTool(memoryStore));
  registry.register(createSkillLoadTool(skillLoader));

  // ── SubAgent ────────────────────────────────────────
  // maxSpawnDepth / maxConcurrent / defaultTimeout 从 config 来
  const subAgentRegistry = new SubAgentRegistry({
    maxSpawnDepth: config.agents.maxSpawnDepth,
    maxConcurrent: config.agents.maxConcurrent,
    defaultTimeout: config.agents.defaultTimeout,
  });
  const getSpawnCtx = (): SpawnContext => ({
    model,
    registry,
    agentRegistry: subAgentRegistry,
    buildSystem: () => promptBuilder.build({
      toolCount: registry.getAll().length,
      deferredTools: registry.getDeferredTools(),
      sessionMessageCount: 0,
      sessionId: 'subagent',
    }),
    currentDepth: 0,
  });
  registry.register(createSpawnTool(subAgentRegistry, getSpawnCtx));

  // ── Plugin 系统 ─────────────────────────────────────
  const pluginManager = new PluginManager(registry);
  const availablePlugins = new Map<string, PluginDefinition>([
    ['supabase', supabasePlugin],
  ]);

  // ── Channel 系统 ────────────────────────────────────
  const gateway = new ChannelGateway({
    model,
    registry,
    buildSystem: () => promptBuilder.build({
      toolCount: registry.getAll().length,
      deferredTools: registry.getDeferredTools(),
      sessionMessageCount: 0,
      sessionId: 'channel',
    }),
  });

  // 只在 enabled 时才实例化——之前不管用不用飞书都会创建 FeishuChannel 实例、占 3000 端口
  if (config.channels.feishu.enabled) {
    const feishuChannel = new FeishuChannel({
      appId: config.channels.feishu.appId,
      appSecret: config.channels.feishu.appSecret,
      port: config.channels.feishu.port,
    });
    gateway.register(feishuChannel);
  }

  // ── Cron ────────────────────────────────────────────
  const cronService = new CronService(config.cron.dataDir);

  // ── MCP 连接 ────────────────────────────────────────
  await connectMCP(registry);
  registerSimulatedTools(registry);

  // ── Plugin 加载：按 config.plugins 决定 ────────────
  console.log(`\n加载 Plugins...`);
  for (const pluginCfg of config.plugins) {
    const def = availablePlugins.get(pluginCfg.name);
    if (!def) {
      console.log(`  ✗ ${pluginCfg.name} — 未知插件`);
      continue;
    }
    if (!pluginCfg.enabled) {
      console.log(`  - ${pluginCfg.name} — 已禁用`);
      continue;
    }
    try {
      const tools = await pluginManager.load(def);
      console.log(`  ✓ ${pluginCfg.name} v${def.version} — 注册 ${tools.length} 个工具`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${pluginCfg.name} 加载失败: ${msg}`);
    }
  }

  // ── Channel 启动 ────────────────────────────────────
  console.log(`\n启动 Channel...`);
  await gateway.startAll();

  // ── Cron 启动（可禁用）────────────────────────────
  if (config.cron.enabled) {
    console.log(`\n启动 Cron...`);
    const cronExecutor: CronExecutor = {
      runAgentPrompt: async (prompt: string, timeout = 60000) => {
        const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
        const cronBudget: BudgetState = { used: 0, limit: budget.limit };
        const dynamicSystem = promptBuilder.build({
          toolCount: registry.getAll().length,
          deferredTools: registry.getDeferredTools(),
          sessionMessageCount: 0,
          sessionId: 'cron',
        });
        // Trace: cron 每次 fire 一个 recorder、sessionId 用 'cron' 前缀便于筛选
        const cronTracer = config.trace.enabled
          ? await LocalTraceRecorder.start({
              directory: config.trace.dir,
              sessionId: 'cron',
              model: modelInfo.modelName,
            })
          : null;
        const loopPromise = agentLoop(model, registry, cronMessages, dynamicSystem, cronBudget, {
          usageTracker,
          modelInfo,
          cacheDisabled: cacheState.disabled,
          trace: cronTracer ?? undefined,
        }).then(async () => {
          await cronTracer?.finish('completed');
          const last = cronMessages[cronMessages.length - 1];
          if (!last || last.role !== 'assistant') return '(no reply)';
          return typeof last.content === 'string'
            ? last.content
            : (Array.isArray(last.content)
              ? last.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
              : '(no reply)');
        }).catch(async (err) => {
          await cronTracer?.finish('failed', err);
          throw err;
        });
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`cron job timeout after ${timeout}ms`)), timeout));
        return Promise.race([loopPromise, timeoutPromise]);
      },
      notify: (msg: string) => console.log(`  [cron notify] ${msg}`),
    };
    cronService.setExecutor(cronExecutor);
    cronService.load();
    cronService.start();
    console.log(`  ✓ Cron 已启动`);
  }

  // ── RAG（可禁用）────────────────────────────────────
  const ragStoreRef: { store: SqliteVectorStore | null } = { store: null };
  if (config.rag.enabled) {
    const ragProvider = process.env.DASHSCOPE_API_KEY ? 'dashscope' : 'mock';
    const store = await buildSqliteIndex({ docsDir: config.rag.docsDir, provider: ragProvider });
    ragStoreRef.store = store;

    const ragEmbedder = ragProvider === 'dashscope' && process.env.DASHSCOPE_API_KEY
      ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
      : createMockEmbedder();
    registry.register(createRagSearchTool(store, ragEmbedder));
  }

  // ── Session ─────────────────────────────────────────
  const isContinue = process.argv.includes('--continue');
  const store = new SessionStore(config.session.id);

  let messages: ModelMessage[] = [];
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话`);
  }

  // ── Prompt Pipe ─────────────────────────────────────
  const promptBuilder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('memoryContext', memoryContext(memoryStore))
    .pipe('skillsContext', skillsContext(skillLoader))
    .pipe('ragContext', ragContext(() => ragStoreRef.store))
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext());

  // ── Budget + Tracking ───────────────────────────────
  const budget: BudgetState = { used: 0, limit: 600000 };
  const usageTracker = new UsageTracker();
  const cacheState = { disabled: false };

  // ── Debug 打印 ──────────────────────────────────────
  printSessionDebug(store);
  printMemoryDebug(memoryStore);
  promptBuilder.debug({
    toolCount: registry.getAll().length,
    deferredTools: registry.getDeferredTools(),
    sessionMessageCount: messages.length,
    sessionId: config.session.id,
  });

  // ── REPL readline ───────────────────────────────────
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // ── Command Dispatcher ─────────────────────────────
  const dispatcher = createDispatcher([
    statusHandler, contextHandler, usageHandler,
    simHandler, defendHandler,
    cacheOffHandler, cacheOnHandler, cacheStatusHandler,
    memorySearchHandler, memoryReadHandler, memoryForgetHandler,
    memoryLintHandler,
    memoryDreamHandler,
    memoryListHandler,
    ...createCronCommands(cronService),
    ...createTraceCommands(config.trace.dir),
    ...createTestSpawnCommands(getSpawnCtx),
    ...createAgentCommands(subAgentRegistry),
    ...createSecurityCommands(registry),
    ...createPluginCommands(pluginManager, availablePlugins),
    ...createChannelCommands(gateway),
    skillLoadHandler,
    skillUnloadHandler,
    skillListHandler,
    skillShortcutHandler,
  ]);

  // ── Shutdown 顺序：cron → channel → plugin → MCP ──
  const shutdown = async () => {
    cronService.stop();
    await gateway.stopAll();
    await pluginManager.unloadAll();
    await registry.closeAllMCP();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  rl.on('close', shutdown);

  // ── ask REPL loop ───────────────────────────────────
  const ask = () => {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        cronService.stop();
        await gateway.stopAll();
        await pluginManager.unloadAll();
        rl.close();
        return;
      }

      const makePromptCtx = () => ({
        toolCount: registry.getAll().length,
        deferredTools: registry.getDeferredTools(),
        sessionMessageCount: messages.length,
        sessionId: config.session.id,
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
        model,
        budget,
      };
      if (await dispatcher(trimmed, cmdCtx)) return;

      const beforeCount = messages.length;
      const userMsg: ModelMessage = { role: 'user', content: trimmed };
      messages.push(userMsg);
      markMessageTime(userMsg);

      const promptCtx = {
        toolCount: registry.getAll().length,
        deferredTools: registry.getDeferredTools(),
        sessionMessageCount: messages.length - 1,
        sessionId: config.session.id,
      };
      const dynamicSystem = promptBuilder.build(promptCtx);

      // Trace: 一个 REPL 任务一个 recorder
      // enabled=false 时 tracer 为 null、agentLoop 不 emit、零开销
      const tracer = config.trace.enabled
        ? await LocalTraceRecorder.start({
            directory: config.trace.dir,
            sessionId: config.session.id,
            model: (model as any)?.modelId || modelInfo.modelName,
          })
        : null;

      try {
        await agentLoop(model, registry, messages, dynamicSystem, budget, {
          usageTracker,
          modelInfo,
          cacheDisabled: cacheState.disabled,
          trace: tracer ?? undefined,
        });
        await tracer?.finish('completed');
        if (tracer) console.log(`  [Trace] ${tracer.filePath}`);
      } catch (error) {
        // 不 throw——REPL 要继续跑、把错误告诉用户 + trace 存好 + 让下轮 ask 就绪
        await tracer?.finish('failed', error);
        console.error(`  [Agent] ${error instanceof Error ? error.message : String(error)}`);
        if (tracer) console.log(`  [Trace] ${tracer.filePath}`);
        ask();
        return;
      }

      for (let i = beforeCount; i < messages.length; i++) {
        store.append(messages[i]);
      }

      if (!(rl as any).closed) ask();
    });
  };

  console.log('\nRegistery Tools...');
  ask();
}

// ═══════════════════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════════════════

async function connectMCP(registry: ToolRegistry) {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import('node:child_process');
    execSync('echo test', { stdio: 'ignore' });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
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

function registerSimulatedTools(registry: ToolRegistry) {
  registry.register(...simulatedMcpTools);
  console.log(`\n注入 ${simulatedMcpTools.length} 个模拟 MCP 工具（全部 shouldDefer）`);
}

function printSessionDebug(store: SessionStore) {
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

function printMemoryDebug(memoryStore: MemoryStore) {
  const s = memoryStore.stats();
  const byType = `user × ${s.byType.user} / feedback × ${s.byType.feedback} / project × ${s.byType.project} / reference × ${s.byType.reference}`;
  console.log(`\n=== Memory Debug ===`);
  console.log(`  索引路径: ${s.indexPath}`);
  console.log(`  条目总数: ${s.count}`);
  console.log(`  分类分布: ${byType}`);
  console.log(`=====================`);
}
