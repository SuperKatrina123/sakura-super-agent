import type { ModelMessage } from 'ai';
import type { CommandHandler } from './index.ts';
import { estimateTokens } from '../session/compressor.ts';
import { applyDefense, markMessageTime } from '../session/defense.ts';

// ═══════════════════════════════════════════════════════════════════════════
// defense.ts — 三层防线相关的 2 个命令
// ═══════════════════════════════════════════════════════════════════════════
//
// - sim     注入 10 组模拟 tool 调用作为历史（含过期时间戳，让 TTL 有东西可清）
// - defend  手动触发三层零 LLM 防线，看 tokens 节省

// simulateHistory：生成 pairCount 组 (assistant tool_call + tool result)
// 一半打 12 分钟前的时间戳（触发硬清）、一半 7 分钟前（触发软修剪）
// 用来演示三层防线，无需等真实长会话自然触发
function simulateHistory(pairCount: number): ModelMessage[] {
  const out: ModelMessage[] = [];
  const now = Date.now();
  for (let i = 0; i < pairCount; i++) {
    const ageMs = i < pairCount / 2 ? 12 * 60_000 : 7 * 60_000;
    const when = new Date(now - ageMs);
    const callId = `sim-${i}`;
    const asst: ModelMessage = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: callId, toolName: 'read_file', input: { path: `/tmp/file-${i}.txt` } }],
    };
    // ~1000 字符的假 tool result，让截断/TTL 都有东西可清
    const fakeContent = `模拟文件 ${i} 的内容: `.padEnd(1000, `abcdefghij${i} `);
    const tool: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: callId, toolName: 'read_file', output: { type: 'text', value: fakeContent } }],
    };
    markMessageTime(asst, when);
    markMessageTime(tool, when);
    out.push(asst, tool);
  }
  return out;
}

// sim: 注入 20 条模拟历史（10 组 tool 调用对）到 messages
// 每条 tool result ~1000 字符——总量 ≈ 6k tokens
// 时间戳：一半 12 分钟前（触发硬清）、一半 7 分钟前（触发软修剪）
export const simHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'sim') return false;
  const injected = simulateHistory(10);
  ctx.messages.push(...injected);
  console.log(`[Sim] 注入 ${injected.length} 条模拟历史消息`);
  ctx.ask();
  return true;
};

// defend: 手动触发三层零 LLM 防线 + 打前后 tokens 对比
export const defendHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'defend') return false;
  const { messages, ask } = ctx;

  const beforeTokens = estimateTokens(messages);
  console.log(`\n--- 执行三层防线 ---`);
  const defense = applyDefense(messages);
  messages.splice(0, messages.length, ...defense.messages);
  const afterTokens = estimateTokens(messages);
  console.log(`  [Layer 2] 截断: ${defense.truncated} 条, 预算清理: ${defense.compacted} 条`);
  console.log(`  [Layer 3] 软修剪: ${defense.softPruned}, 硬清除: ${defense.hardPruned}`);
  console.log(`  [结果] ~${beforeTokens} → ~${afterTokens} tokens (节省 ${beforeTokens - afterTokens})`);
  ask();
  return true;
};
