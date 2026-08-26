import 'dotenv/config'
;(globalThis as any).AI_SDK_LOG_WARNINGS = false
import { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'node:readline';
import process from 'node:process';
import { ToolRegistry } from './tool-registry.ts';
import { allTools } from './tool/index.ts';
import { agentLoop, type BudgetState } from './agent/loop';

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
registry.register(...allTools);

console.log(`已注册 ${registry.getAll().length} 个工具：`);

for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? '可并发' : '串行',
    tool.isReadOnly ? '只读' : '读写',
  ].join(', ');
  console.log(`  - ${tool.name}（${flags}）`);
}

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

        await agentLoop(model, registry, messages, SYSTEM, budget);

        if (!rl.closed) ask();   // 管道输入 EOF 时 readline 已关闭，跳过避免 ERR_USE_AFTER_CLOSE
    });
};

console.log('Registey Tools...');
ask();