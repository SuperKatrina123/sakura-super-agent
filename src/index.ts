import 'dotenv/config';
import { generateText, ModelMessage, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';

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

const messages: ModelMessage[] = []; // 维护一个消息列表，记录对话历史

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

    const result = streamText({
      model,
      // 定义完system prompt之后，整个对话风格就变了
      system: `你是 Super Agent，一个专注于软件开发的 AI 助手。
          你说话简洁直接，喜欢用代码示例来解释问题。
          如果用户的问题不够清晰，你会反问而不是瞎猜。`,
      messages, // 对话历史
    });

    process.stdout.write('Assistant: ');
    let fullResponse = '';
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
    }
    console.log(); // 换行

    messages.push({ role: 'assistant', content: fullResponse }); // 助手说一句，再push一条

    ask(); // 递归调用
  });
}

console.log('Super Agent v0.1 (type "exit" to quit)\n');
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

