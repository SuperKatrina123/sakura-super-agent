import 'dotenv/config'
;(globalThis as any).AI_SDK_LOG_WARNINGS = false
import { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'node:readline';
import process from 'node:process';
import { ToolRegistry } from './tool-registry.ts';
import { allTools, pickSearchTool } from './tool/index.ts';
import { simulatedMcpTools } from './tool/simulated-mcp.ts';
import { createToolSearchTool } from './tool/tool-search.ts';
import { agentLoop, type BudgetState } from './agent/loop';
import { MCPClient } from './mcp/client.ts';
import { SDKMCPClient } from './mcp/sdk-client.ts';
import { MockMCPClient } from './mcp/mock-client.ts';

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

const messages: ModelMessage[] = [];
const SYSTEM = `你是一个Agent，一个专注于软件开发的AI助手。你说话简单直接，喜欢用代码示例来解释问题。如果用户说话模糊，你倾向于询问而不是瞎猜。

## Vibe Coding 模式（当用户要求"做一个 XX 网页/应用/小程序"时启用）

项目里有一个预置的 app/ 目录，专门用来跑用户想要的小应用。你的职责是**只写应用代码**：

- **只允许写**：app/App.tsx（必需，作为入口）、app/其他组件.tsx、app/styles.css
- **绝对不要动**：app/index.html——这是预置的脚手架（importmap + Babel + loader），改了会让整个应用跑不起来
- **写完立即调 start_preview**——用户需要看到运行结果

技术约束（浏览器直接跑，无 build 工具）：
1. 不要写 \`import React from 'react'\`——用 automatic JSX runtime，直接写 JSX 即可
2. 需要 hooks 时明确导入：\`import { useState } from 'react'\`
3. App.tsx 必须有入口渲染代码：
   \`\`\`tsx
   import { createRoot } from 'react-dom/client';
   createRoot(document.getElementById('root')!).render(<App />);
   \`\`\`
4. 组件间 import 可以省略后缀（loader 会尝试 .tsx/.ts/.jsx/.js），但**推荐写全**：\`import Button from './Button.tsx'\`
5. 只能用 react / react-dom，不要引第三方库（除非在 index.html 的 importmap 里已经注册）
6. 样式统一写在 app/styles.css，不用 CSS-in-JS
7. 不要用 Node 环境的东西（process.env、fs、path 等——这些浏览器里没有）

流程：write_file 应用代码 → start_preview → 告诉用户 http://localhost:8080`;
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

        messages.push({ role: 'user', content: trimmed });

        // 每轮都重新拼 SYSTEM——因为 discoveredTools 可能变，defer 目录要跟着更新
        // （已发现的工具会从目录里消失，避免模型重复搜索）
        const dynamicSystem = SYSTEM + registry.getDeferredToolSummary();
        await agentLoop(model, registry, messages, dynamicSystem, budget);

        if (!rl.closed) ask();   // 管道输入 EOF 时 readline 已关闭，跳过避免 ERR_USE_AFTER_CLOSE
    });
};