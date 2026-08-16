import 'dotenv/config'
import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'

const deepseek = createOpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY
});

const model = process.env.DEEPSEEK_API_KEY ? 
    deepseek.chat('deepseek-v4-flash') 
    : createMockModel();

// https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
async function main() {
    const result = streamText({
        model,
        prompt: '用一句话介绍你自己'
    })

    for await (const textPart of result.textStream) {
        process.stdout.write(textPart);
    }

    console.log(); // 换行
};

main();