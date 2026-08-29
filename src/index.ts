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
import { agentLoop, type BudgetState } from './agent/loop';
import { MCPClient } from './mcp/client.ts';
import { SDKMCPClient } from './mcp/sdk-client.ts';
import { MockMCPClient } from './mcp/mock-client.ts';
import { SessionStore } from './session/store.ts';
import { PromptBuilder } from './context/prompt-builder.ts';
import { coreRules, toolGuide, sessionContext, deferredTools } from './context/segments.ts';
import { estimateTokens } from './session/compressor.ts';
import { applyDefense, markMessageTime } from './session/defense.ts';

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
// 元工具 tool_search 必须最后注册——需要闭包 registry 引用
registry.register(createToolSearchTool(registry));

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

  // 应用退出前关掉所有 MCP 子进程，避免留下孤儿。SIGINT 也走同一条路径
  const shutdown = async () => {
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
// Prompt Pipe：把 SYSTEM 拆成 4 个独立 segment，每个自己决定要不要出现
// 顺序即 cache 策略——越少变的越靠前，最大化 prompt cache 前缀命中
const promptBuilder = new PromptBuilder()
  .pipe('coreRules', coreRules())            // 永远不变——cache 稳稳命中
  .pipe('toolGuide', toolGuide())            // 工具数量基本固定，变化很少
  .pipe('deferredTools', deferredTools())    // 所有工具列表基本固定，放中间
  .pipe('sessionContext', sessionContext()); // 每次启动都不同（历史消息数），放最后
// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = { used: 0, limit: 600000 };

// 生成模拟历史——一半打 12 分钟前的时间戳（触发硬清）、一半 7 分钟前（触发软修剪）
// 用来演示三层防线，无需等长会话自然触发
function simulateHistory(pairCount: number): ModelMessage[] {
  const out: ModelMessage[] = [];
  const now = Date.now();
  for (let i = 0; i < pairCount; i++) {
    const ageMs = i < pairCount / 2 ? 12 * 60_000 : 7 * 60_000;
    const when = new Date(now - ageMs);
    const callId = `sim-${i}`;
    const asst: ModelMessage = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: callId, toolName: 'read_file', input: { path: `/tmp/file-${i}.txt` } }],
    };
    // ~1000 字符的假 tool result，让截断/TTL 都有东西可清
    const fakeContent = `模拟文件 ${i} 的内容: `.padEnd(1000, `abcdefghij${i} `);
    const tool: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: callId, toolName: 'read_file', output: { type: 'text', value: fakeContent } }],
    };
    markMessageTime(asst, when);
    markMessageTime(tool, when);
    out.push(asst, tool);
  }
  return out;
}

function ask() {
    rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit') {
            console.log('Bye!');
            rl.close();
            return;
        }

        // ─── 快捷命令：直接演示三层防线效果 ────────────────────────────
        if (trimmed === 'sim') {
            // 注入 10 组 (assistant tool_call + tool result) = 20 条消息
            // 每条 tool result ~1000 字符——总量 ≈ 6k tokens
            // 时间戳：一半 12 分钟前（触发硬清）、一半 7 分钟前（触发软修剪）
            const injected = simulateHistory(10);
            messages.push(...injected);
            console.log(`[Sim] 注入 ${injected.length} 条模拟历史消息`);
            if (!rl.closed) ask();
            return;
        }
        if (trimmed === 'status') {
            const tokens = estimateTokens(messages);
            console.log(`[Status] ${messages.length} 条消息, ~${tokens} tokens (含中文 1.2x 安全系数)`);
            if (!rl.closed) ask();
            return;
        }
        if (trimmed === 'defend') {
            const beforeTokens = estimateTokens(messages);
            console.log(`\n--- 执行三层防线 ---`);
            const defense = applyDefense(messages);
            messages.splice(0, messages.length, ...defense.messages);
            const afterTokens = estimateTokens(messages);
            console.log(`  [Layer 2] 截断: ${defense.truncated} 条, 预算清理: ${defense.compacted} 条`);
            console.log(`  [Layer 3] 软修剪: ${defense.softPruned}, 硬清除: ${defense.hardPruned}`);
            console.log(`  [结果] ~${beforeTokens} → ~${afterTokens} tokens (节省 ${beforeTokens - afterTokens})`);
            if (!rl.closed) ask();
            return;
        }
        // ────────────────────────────────────────────────────────────

        // 记住 push user 消息前的位置——本轮结束时从这里开始 flush 到磁盘
        // 策略 2：本轮结束一次性 append 新消息。崩溃丢当前轮，退出/Ctrl+C 前正常落盘
        const beforeCount = messages.length;
        const userMsg: ModelMessage = { role: 'user', content: trimmed };
        messages.push(userMsg);
        markMessageTime(userMsg);   // 打时间戳，让 TTL 修剪能识别新旧

        // 每轮都重建 PromptContext——registry/messages 都可能变
        // pipe.build 里 4 个 segment 各自决定要不要出现，最终拼成 SYSTEM
        const promptCtx = {
            toolCount: registry.getAll().length,
            deferredTools: registry.getDeferredTools(),
            sessionMessageCount: messages.length - 1,   // 减去刚 push 的这条 user，反映"历史"
            sessionId: 'default',
        };
        const dynamicSystem = promptBuilder.build(promptCtx);
        await agentLoop(model, registry, messages, dynamicSystem, budget);

        // 本轮所有新消息（user + assistant 若干 + tool 结果若干）落盘
        for (let i = beforeCount; i < messages.length; i++) {
            store.append(messages[i]);
        }

        if (!rl.closed) ask();   // 管道输入 EOF 时 readline 已关闭，跳过避免 ERR_USE_AFTER_CLOSE
    });
};