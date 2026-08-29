import { streamText, type ModelMessage } from 'ai';
import { microcompact, summarize, estimateTokens } from '../session/compressor.js';
import { applyDefense, TokenTracker, markMessageTime, markMessagesTime } from '../session/defense.js';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.ts';
import { isRetryable, calculateDelay, sleep } from './retry.ts';
import { ToolRegistry } from '../tools/tool-registry.ts';

const MAX_STEPS = 150;
const MAX_RETRIES = 3;

export interface BudgetState {
  used: number;
  limit: number;
}


export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState,
  tracker?: TokenTracker,   // 可选——不传的话 loop 内部 new 一个（每轮独立）
) {
  let step = 0;
  resetHistory();
  const tokenTracker = tracker ?? new TokenTracker();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    // ─── 零 LLM 防线：TTL 修剪 + 大小截断（applyDefense 聚合入口）─────────
    // 顺序：便宜的先——TTL/截断（无 LLM）→ microcompact（无 LLM）→ summarize（有 LLM）
    const defense = applyDefense(messages);
    const defenseChanged =
      defense.softPruned || defense.hardPruned || defense.truncated || defense.compacted;
    if (defenseChanged) {
      const before = messages.slice();
      messages.splice(0, messages.length, ...defense.messages);
      tokenTracker.replaceMessages(before, messages);
      console.log(
        `  [Layer 2 截断] ${defense.truncated} 条超长截断 / ${defense.compacted} 条预算清理`,
      );
      console.log(
        `  [Layer 3 TTL] 软修剪 ${defense.softPruned} / 硬清除 ${defense.hardPruned}`,
      );
    }
    // ────────────────────────────────────────────────────────────────────

    // ─── 上下文压缩：Microcompact → Summarize，前后各打 tokens 让效果可见 ─────
    // 只在本轮真的发生了压缩时才打 log，避免每轮都刷屏
    // "压缩前"的数字放在第一次真正生效的动作之前打——保持日志块紧凑
    const beforeCount = messages.length;
    const beforeTokens = estimateTokens(messages);

    // Layer 4：Microcompact（零成本、幂等——反复跑不会误清）
    // 原地修改 messages 保持外部引用一致（index.ts / SessionStore 都指向同一个数组）
    const { messages: compacted, cleared } = microcompact(messages);
    let didAnything = false;
    if (cleared > 0) {
      const before = messages.slice();
      messages.splice(0, messages.length, ...compacted);
      tokenTracker.replaceMessages(before, messages);
      didAnything = true;
    }
    const afterMicroTokens = estimateTokens(messages);

    // Layer 2：Summarize（只在超阈值时才调 LLM，未超时 compressedCount=0）
    const summarizeResult = await summarize(model, messages);
    if (summarizeResult.compressedCount > 0) {
      const before = messages.slice();
      messages.splice(0, messages.length, ...summarizeResult.messages);
      tokenTracker.replaceMessages(before, messages);
      // 摘要消息是新 push 进来的 user message——打时间戳（避免下次 TTL 因无时间戳跳过）
      if (messages[0]) markMessageTime(messages[0]);
      didAnything = true;
    }
    const afterSummarizeTokens = estimateTokens(messages);

    if (didAnything) {
      console.log(`\n[压缩前] ${beforeCount} 条消息, ~${beforeTokens} tokens`);
      if (cleared > 0) {
        console.log(`[Layer 1: Microcompact] 清理了 ${cleared} 个工具结果, ~${afterMicroTokens} tokens`);
      }
      if (summarizeResult.compressedCount > 0) {
        console.log(`[Layer 2: Summarization] 压缩了 ${summarizeResult.compressedCount} 条消息, ~${afterSummarizeTokens} tokens`);
        // 摘要预览：只打前 100 字符，够看结构够看是否符合模板、不刷屏
        const preview = summarizeResult.summary.slice(0, 100).replace(/\n/g, ' ');
        const truncated = summarizeResult.summary.length > 100 ? '...' : '';
        console.log(`[摘要预览] ${preview}${truncated}`);
      }
      console.log(`[压缩后] ${messages.length} 条消息, ~${afterSummarizeTokens} tokens\n`);
    }
    // ─────────────────────────────────────────────────────────────────────

    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: Awaited<ReturnType<typeof streamText>['response']>;
    let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>;

    // 步骤级重试：包裹整个 stream 消费过程
    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({ model, system, tools: registry.toAISDKFormat(), messages, maxRetries: 0, onError: () => {} });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              // console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === 'critical') {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);
              break;
            }

            case 'tool-result':
              // console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output);
              }
              break;
          }
        }

        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`);
        await sleep(delay);
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    messages.push(...stepResponse!.messages);
    // 打时间戳（TTL 修剪需要）+ 更新 TokenTracker 的粗估增量
    markMessagesTime(stepResponse!.messages);
    tokenTracker.addMessages(stepResponse!.messages);

    // Token 预算追踪：budget 由调用方持有，跨轮持续累计
    const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : (stepUsage?.inputTokens?.total ?? 0);
    const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : (stepUsage?.outputTokens?.total ?? 0);
    budget.used += inp + out;
    // 用 API 返回的精确 inputTokens 校准 TokenTracker——重置粗估增量
    if (inp > 0) tokenTracker.updateFromAPI(inp);
    const pct = Math.round(budget.used / budget.limit * 100);
    console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%) · tracker ~${tokenTracker.estimatedTokens}`);
    if (budget.used > budget.limit) {
      console.log('\n[Token 预算耗尽，强制停止]');
      break;
    }

    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log('  → 继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}