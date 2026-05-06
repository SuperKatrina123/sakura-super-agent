import 'dotenv/config';
import { generateText, ModelMessage, stepCountIs, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';
import { weatherTool, calculatorTool } from './tools';
import { agentLoop } from './agent-loop';
import { allTools } from './tools.js';
import { ToolRegistry } from './tool-registry.js';

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

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

const messages: ModelMessage[] = []; // 维护一个消息列表，记录对话历史

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

// 一个循环：等待输入 → 发给模型 → 流式输出 → 等待输入……
function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!');
      rl.close();
      return;
    }

    messages.push({ role: 'user', content: trimmed }); // 用户说一句，push一条

    // SDK自动调用，自主性较差，我们采用手动循环的方式，定义一个agentLoop
    // const result = streamText({
    //   model,
    //   // 定义完system prompt之后，整个对话风格就变了
    //   system: `你是 Super Agent，一个专注于软件开发的 AI 助手。
    //       你说话简洁直接，喜欢用代码示例来解释问题。
    //       如果用户的问题不够清晰，你会反问而不是瞎猜。`,
    //   messages, // 对话历史
    //   tools, // 可用工具
    //   stopWhen: stepCountIs(5), // 最多跑 5 步
    // });

    // process.stdout.write('Assistant: ');
    // let fullResponse = '';

    // // textStreamtextStream 只给你文本片段
    // // 但现在模型除了文本，还可能返回工具调用，fullStream 包含完整的事件流
    // // for await (const chunk of result.textStream) {
    // //   process.stdout.write(chunk);
    // //   fullResponse += chunk;
    // // }

    // for await (const events of result.fullStream) {
    //   switch (events.type) {
    //     case 'text-delta':
    //       process.stdout.write(events.text);
    //       fullResponse += events.text;
    //       break;
    //     case 'tool-call':
    //       console.log(`\n  [调用工具: ${events.toolName}(${JSON.stringify(events.input)})]`);
    //       break;
    //     case 'tool-result':
    //       console.log(`  [工具返回: ${JSON.stringify(events.output)}]`);
    //       break;
    //   }
    // }

    // console.log(); // 换行

    // messages.push({ role: 'assistant', content: fullResponse }); // 助手说一句，再push一条

    await agentLoop(model, registry, messages, SYSTEM);

    ask(); // 递归调用
  });
}

// console.log('Super Agent v0.1 (type "exit" to quit)\n');
// console.log('Super Agent v0.2 — Agent Loop (type "exit" to quit)\n');
ask();

// async function main() {
//   // generateText是同步返回的
//   // const { text } = await generateText({
//   //   model,
//   //   prompt: '用一句话介绍你自己',
//   // });

//   // console.log(text);

//   // 换成流式输出
//   const result = streamText({
//     model,
//     prompt: '用一句话介绍你自己',
//   }); 

//   for await (const chunk of result.textStream) {
//     process.stdout.write(chunk);
//   }

//   console.log(); // 换行

// }

// main();

