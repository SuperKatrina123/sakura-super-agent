import type { ModelMessage } from 'ai';
import { toolResultOutputToText } from './tool-result-output.js';

// ═══════════════════════════════════════════════════════════════════════════
// Token 计数基础工具
// ═══════════════════════════════════════════════════════════════════════════
//
// 单一职责：**遍历 messages 数据结构、把所有文本字符累加起来**
//
// 为什么单独一个文件：
//   - compressor.ts 里 estimateTokens 要用
//   - defense.ts 里 TokenTracker 的 replaceMessages / addMessage 要用
//   - 两个模块共用同一份计数逻辑——避免"改一处忘另一处"
//
// 为什么不做 tokenizer 精确计数：
//   - tiktoken 初始化几百 ms、encode 也要几十 ms
//   - 不同模型 tokenizer 不一样（GPT vs Claude 差异大）
//   - "要不要触发压缩" 是二元判断，10-20% 误差完全够用
//   - 生产上要精确值走 usage.inputTokens 校准（见 TokenTracker.updateFromAPI）

// 单条 message 的字符数——遍历 content 里所有携带文本的字段
export function countMessageChars(msg: ModelMessage): number {
  if (typeof msg.content === 'string') return msg.content.length;
  if (!Array.isArray(msg.content)) return 0;

  let chars = 0;
  for (const part of msg.content) {
    // tool-result / text / tool-call 都可能带文本内容
    // 用 'x' in obj 判断而不是 part.type，兼容将来 AI SDK 新增的 part 类型
    if ('text' in part && typeof part.text === 'string') chars += part.text.length;
    if ('value' in part && typeof part.value === 'string') chars += part.value.length;
    if ('output' in part) chars += toolResultOutputToText(part.output).length;
    if ('input' in part && part.input) chars += JSON.stringify(part.input).length;
  }
  return chars;
}

// 一批 messages 的字符数——就是每条累加
export function countMessagesChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) chars += countMessageChars(msg);
  return chars;
}
