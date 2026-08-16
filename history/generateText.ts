import 'dotenv/config'
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'

const deepseek = createOpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY
});

const model = process.env.DEEPSEEK_API_KEY ? 
    deepseek.chat('deepseek-v4-flash') 
    : createMockModel();

// https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text
// generateText 是同步返回的 -> 下一步改为streamText
async function main() {
    const { text } = await generateText({
        model,
        prompt: '用一句话介绍你自己'
    })

    console.log(text);
};

main();