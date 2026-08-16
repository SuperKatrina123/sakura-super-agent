import 'dotenv/config'
import { ModelMessage, streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'node:readline';
import process from 'node:process';

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

function ask() {
    rl.question('\nYou:', async (input) => {
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
            system: '你是一个Agent，一个专注于软件开发的AI助手。你说话简单直接，喜欢用代码示例来解释问题。如果用户说话模糊，你倾向于询问而不是瞎猜。'
        })

        process.stdout.write('Assistant:');
        let fullResponse = '';
        for await (const chunk of result.textStream) {
            process.stdout.write(chunk);
            fullResponse += chunk;
        }
        console.log(); // 换行

        messages.push({ role: 'assistant', content: fullResponse });

        ask();
    });
};

console.log('Chat with agent...');
ask();