import type { CommandHandler } from './index.ts';
import { estimateTokens } from '../session/compressor.ts';
import { renderContextMatrix, buildSnapshot, renderUsageSummary } from '../context/view.ts';

// ═══════════════════════════════════════════════════════════════════════════
// view.ts — 空间/成本可视化的 3 个命令
// ═══════════════════════════════════════════════════════════════════════════
//
// - status   一行紧凑状态（消息数 + tokens + cache 命中率简报）
// - context  16×16 网格看空间分布
// - usage    四类 token + 进度条 + 三行成本对比

// status: 紧凑状态——不是完整报告、够看当前"有多满"就行
export const statusHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'status') return false;
  const { messages, tracker, ask } = ctx;

  const tokens = estimateTokens(messages);
  console.log(`[Status] ${messages.length} 条消息, ~${tokens} tokens (含中文 1.2x 安全系数)`);

  const t = tracker.totals();
  if (t.steps > 0) {
    const hitPct = Math.round(t.cacheHitRate * 100);
    const savedPct = Math.round(t.savedPct * 100);
    console.log(`[Usage] ${t.steps} 步 · 命中率 ${hitPct}%`);
    console.log(`  tokens: input=${t.inputTokens} cached=${t.cacheReadTokens} write=${t.cacheWriteTokens} output=${t.outputTokens}`);
    console.log(`  cost: $${t.cost.toFixed(4)} (baseline $${t.baselineCost.toFixed(4)}, saved $${t.savedCost.toFixed(4)} = ${savedPct}%)`);
  } else {
    console.log(`[Usage] 还没有 API 调用记录（跑几轮对话就有了）`);
  }
  ask();
  return true;
};

// context: 16×16 网格可视化——空间占用一目了然
// 分类从 registry 挖：mcp__ 前缀 → MCP tools，其他 active → System tools
export const contextHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'context') return false;
  const { messages, registry, builder, modelInfo, makePromptCtx, ask } = ctx;

  let systemToolsChars = 0;
  let mcpToolsChars = 0;
  for (const tool of registry.getActiveTools()) {
    const schemaLen = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }).length;
    if (tool.name.startsWith('mcp__')) mcpToolsChars += schemaLen;
    else systemToolsChars += schemaLen;
  }
  // defer 目录：name + hint 列表的字符数（"  - " + " — " ≈ 6 字符 overhead）
  const deferredChars = registry.getDeferredTools().reduce((sum, t) => {
    return sum + t.name.length + (t.hint?.length ?? 0) + 6;
  }, 0);

  const systemPromptText = builder.build(makePromptCtx());

  // 上下文窗口：DeepSeek V4 是 128k、Mock 就当 1M 演示效果
  const contextWindow = modelInfo.provider === 'mock' ? 1_000_000 : 128_000;

  const snapshot = buildSnapshot({
    modelDisplayName: modelInfo.provider === 'mock'
      ? 'Mock Model'
      : `${modelInfo.provider}/${modelInfo.modelName}`,
    contextWindow,
    systemPromptText,
    messages,
    tools: { systemToolsChars, mcpToolsChars, deferredChars },
  });
  console.log('\n' + renderContextMatrix(snapshot) + '\n');
  ask();
  return true;
};

// usage: 完整成本 breakdown——比 status 详细，有进度条和对比
export const usageHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'usage') return false;
  console.log('\n' + renderUsageSummary(ctx.tracker.totals()) + '\n');
  ctx.ask();
  return true;
};
