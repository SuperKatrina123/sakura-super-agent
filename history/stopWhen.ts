import 'dotenv/config'
import { ModelMessage, streamText, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'node:readline';
import process from 'node:process';
import { weatherTool, calculatorTool } from './tool/utility-tools';

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

const messages: ModelMessage[] = [];
const tools = { get_weather: weatherTool, calculator: calculatorTool };

function ask() {
    rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit') {
            console.log('Bye!');
            rl.close();
            return;
        }

        messages.push({ role: 'user', content: trimmed });

        // syste可以定义系统角色
        const result = streamText({
            model,
            messages,
            system: '你是一个Agent，一个专注于软件开发的AI助手。你说话简单直接，喜欢用代码示例来解释问题。如果用户说话模糊，你倾向于询问而不是瞎猜。',
            tools,
            stopWhen: stepCountIs(5), // 最多跑 5 步
        })

        process.stdout.write('Assistant: ');
        let fullResponse = '';

        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'text-delta':
                    process.stdout.write(part.text);
                    fullResponse += part.text;
                    break;
                case 'tool-call': 
                    console.log(`\n [调用工具: ${part.toolName}${JSON.stringify(part.input)}]`);
                    break;
                case 'tool-result':
                    console.log(`\n [工具返回: ${JSON.stringify(part.output)}]`);
                    break;
            }
        }
        console.log(); // 换行

        messages.push({ role: 'assistant', content: fullResponse });

        ask();
    });
};

console.log('Chat with agent which  has tool...');
ask();