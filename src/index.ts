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

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个（直接进 system prompt）`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个（走 tool_search 按需激活）`);
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`);
  console.log(`  节省比例: ~${Math.round(estimate.deferred / estimate.total * 100)}%`);

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
// SYSTEM 保持最小——只讲身份 + tool_search 存在
// defer 目录在 ask() 里每轮动态拼上，因为 discoveredTools 会变
const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。
如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。`;
// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = { used: 0, limit: 600000 };

function ask() {
    rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit') {
            console.log('Bye!');
            rl.close();
            return;
        }

        // 记住 push user 消息前的位置——本轮结束时从这里开始 flush 到磁盘
        // 策略 2：本轮结束一次性 append 新消息。崩溃丢当前轮，退出/Ctrl+C 前正常落盘
        const beforeCount = messages.length;
        messages.push({ role: 'user', content: trimmed });

        // 每轮都重新拼 SYSTEM——因为 discoveredTools 可能变，defer 目录要跟着更新
        // （已发现的工具会从目录里消失，避免模型重复搜索）
        const dynamicSystem = SYSTEM + registry.getDeferredToolSummary();
        await agentLoop(model, registry, messages, dynamicSystem, budget);

        // 本轮所有新消息（user + assistant 若干 + tool 结果若干）落盘
        for (let i = beforeCount; i < messages.length; i++) {
            store.append(messages[i]);
        }

        if (!rl.closed) ask();   // 管道输入 EOF 时 readline 已关闭，跳过避免 ERR_USE_AFTER_CLOSE
    });
};