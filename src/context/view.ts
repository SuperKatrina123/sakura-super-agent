import type { ModelMessage } from 'ai';
import { countMessagesChars, countMessageChars } from '../session/token-count.js';
import type { UsageTotals } from '../session/usage-tracker.js';

// ═══════════════════════════════════════════════════════════════════════════
// 上下文可视化：仿 Claude Code 的 /context 快捷命令
// ═══════════════════════════════════════════════════════════════════════════
//
// 输出示例（16×16 网格 + 分类图例）：
//   ● ● ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    Mock Model
//   ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    1.7k/1.0M tokens (0.2%)
//   ...
//   ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ● System prompt: 1.1k (0.1%)
//   ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ● Messages:      600 (0.06%)
//   ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○    ○ Free space:    948k (94.8%)
//                                        ▢ Buffer:        50k (5.0%)
//
// 设计要点：
//   - 16×16 = 256 格，每格 ≈ 1/256 = 0.4% 的窗口
//   - 各类别按"分配到的格子数"填充——比按纯百分比更符合直觉
//   - Buffer 是预留给 autocompact/summarize 的应急空间——总是显示

// 用不同符号区分类别（终端友好、不依赖颜色）
const SYMBOL = {
  systemPrompt: '●',      // 实心圆——固定系统开销
  systemTools:  '◐',      // 半实心——工具 schema
  mcpTools:     '◑',      // 反半实心——MCP 工具 schema
  deferred:     '◒',      // 底半实心——延迟工具目录
  messages:     '◉',      // 双圈实心——对话历史
  buffer:       '▢',      // 空心方块——应急缓冲
  free:         '○',      // 空心圆——空闲
} as const;

// 应急 buffer：预留 5% 给 autocompact/summarize 触发时的临时膨胀
// 太小会让触发时"没地方摆摘要"、太大会低估可用空间
const BUFFER_RATIO = 0.05;

// 图例的输出顺序——把有内容的往前排，free/buffer 垫底
const LEGEND_ORDER: Array<keyof typeof SYMBOL> = [
  'systemPrompt', 'systemTools', 'mcpTools', 'deferred', 'messages', 'free', 'buffer',
];

const LEGEND_LABEL: Record<keyof typeof SYMBOL, string> = {
  systemPrompt: 'System prompt',
  systemTools:  'System tools',
  mcpTools:     'MCP tools',
  deferred:     'Deferred tools',
  messages:     'Messages',
  buffer:       'Buffer',
  free:         'Free space',
};

// 输入给渲染器的语义化数据——由 caller 从 registry / messages 里挖出来
export interface ContextSnapshot {
  modelDisplayName: string;
  contextWindow: number;        // 模型上下文窗口的 token 数（比如 1_000_000）
  // 各类别的 token 估算（字符数 / 4）——由 caller 拆分
  systemPromptTokens: number;
  systemToolsTokens: number;
  mcpToolsTokens: number;
  deferredTokens: number;
  messagesTokens: number;
}

// 主入口：把 snapshot 渲染成两栏 ASCII 图
export function renderContextMatrix(snapshot: ContextSnapshot): string {
  const {
    modelDisplayName, contextWindow,
    systemPromptTokens, systemToolsTokens, mcpToolsTokens,
    deferredTokens, messagesTokens,
  } = snapshot;

  const usedTokens =
    systemPromptTokens + systemToolsTokens + mcpToolsTokens +
    deferredTokens + messagesTokens;
  const bufferTokens = Math.floor(contextWindow * BUFFER_RATIO);
  const freeTokens = Math.max(0, contextWindow - usedTokens - bufferTokens);

  // ── 计算各类别应该占多少格 ────────────────────────────────
  // 每格 = contextWindow / 256 tokens
  // 用 Math.round 分配、保证总和不超 256（超了截断最后一类）
  const TOTAL_CELLS = 256;
  const perCell = contextWindow / TOTAL_CELLS;
  const alloc: Record<keyof typeof SYMBOL, number> = {
    systemPrompt: Math.round(systemPromptTokens / perCell),
    systemTools:  Math.round(systemToolsTokens  / perCell),
    mcpTools:     Math.round(mcpToolsTokens     / perCell),
    deferred:     Math.round(deferredTokens     / perCell),
    messages:     Math.round(messagesTokens     / perCell),
    buffer:       Math.round(bufferTokens       / perCell),
    free:         0,   // free 填剩余
  };
  const allocated = Object.values(alloc).reduce((a, b) => a + b, 0);
  alloc.free = Math.max(0, TOTAL_CELLS - allocated);

  // ── 构造 256 格的符号序列（按图例顺序填）────────────────
  const cells: string[] = [];
  for (const key of LEGEND_ORDER) {
    for (let i = 0; i < alloc[key]; i++) cells.push(SYMBOL[key]);
  }
  // 万一因为 rounding 超了 256、截断
  cells.length = TOTAL_CELLS;

  // ── 拼 16 行、每行 16 个格子 ──────────────────────────────
  const rows: string[] = [];
  for (let r = 0; r < 16; r++) {
    const row = cells.slice(r * 16, (r + 1) * 16).join(' ');
    rows.push(row);
  }

  // ── 右侧图例 ──────────────────────────────────────────────
  const usedPct = (usedTokens / contextWindow * 100);
  const legend: string[] = [];
  legend.push(modelDisplayName);
  legend.push(`${fmtTokens(usedTokens)}/${fmtTokens(contextWindow)} tokens (${usedPct.toFixed(1)}%)`);
  legend.push('');   // 空行

  // 按 LEGEND_ORDER 输出、但只显示 tokens > 0 的类别（free/buffer 例外，永远显示）
  for (const key of LEGEND_ORDER) {
    const t = tokensFor(key, snapshot, freeTokens, bufferTokens);
    if (t === 0 && key !== 'free' && key !== 'buffer') continue;
    const pct = (t / contextWindow * 100);
    legend.push(`${SYMBOL[key]} ${padRight(LEGEND_LABEL[key], 14)} ${padLeft(fmtTokens(t), 6)} (${pct.toFixed(pct < 1 ? 2 : 1)}%)`);
  }

  // ── 左右两栏合并 ─────────────────────────────────────────
  // 每行 16 格 × 2 字符宽（符号 + 空格）= 32 字符
  const gutter = '    ';
  const output: string[] = [];
  for (let i = 0; i < 16; i++) {
    const left = rows[i];
    const right = legend[i] ?? '';
    output.push(`  ${left}${gutter}${right}`);
  }
  // 如果 legend 比 16 行长（大概不会）——继续追加、左侧空白对齐
  const emptyLeft = ' '.repeat(rows[0].length);
  for (let i = 16; i < legend.length; i++) {
    output.push(`  ${emptyLeft}${gutter}${legend[i]}`);
  }

  return output.join('\n');
}

// ── 辅助函数 ────────────────────────────────────────────────

function tokensFor(
  key: keyof typeof SYMBOL,
  s: ContextSnapshot,
  freeTokens: number,
  bufferTokens: number,
): number {
  switch (key) {
    case 'systemPrompt': return s.systemPromptTokens;
    case 'systemTools':  return s.systemToolsTokens;
    case 'mcpTools':     return s.mcpToolsTokens;
    case 'deferred':     return s.deferredTokens;
    case 'messages':     return s.messagesTokens;
    case 'buffer':       return bufferTokens;
    case 'free':         return freeTokens;
  }
}

// 格式化 tokens：1000 → 1.0k、1_000_000 → 1.0M
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}


// ═══════════════════════════════════════════════════════════════════════════
// buildSnapshot：从项目实际状态构造 snapshot
// ═══════════════════════════════════════════════════════════════════════════
//
// 输入 caller 已有的三样：
//   - systemPromptText: promptBuilder.build(ctx) 的结果
//   - messages: 当前 messages 数组
//   - toolCategories: 分类好的工具（内置/MCP/defer 目录）——caller 从 registry 挖
//
// 输出可以直接喂给 renderContextMatrix 的 snapshot

export interface ToolBreakdown {
  systemToolsChars: number;    // 立即加载的内置工具 schema 总字符数
  mcpToolsChars: number;       // 已发现的 MCP 工具 schema 总字符数
  deferredChars: number;       // defer 目录的字符数（name + hint 列表）
}

// 字符数 / 4 —— 跟其他 layer 一致的粗估（低估中文、加 1.2x 安全系数太重、这里保守一点用纯 4）
// view 只是"可视化"、精度到 5% 就够——不要跟 TokenTracker 的精确基准竞争
function charsToTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function buildSnapshot(input: {
  modelDisplayName: string;
  contextWindow: number;
  systemPromptText: string;
  messages: ModelMessage[];
  tools: ToolBreakdown;
}): ContextSnapshot {
  return {
    modelDisplayName: input.modelDisplayName,
    contextWindow: input.contextWindow,
    systemPromptTokens: charsToTokens(input.systemPromptText.length),
    systemToolsTokens:  charsToTokens(input.tools.systemToolsChars),
    mcpToolsTokens:     charsToTokens(input.tools.mcpToolsChars),
    deferredTokens:     charsToTokens(input.tools.deferredChars),
    messagesTokens:     charsToTokens(countMessagesChars(input.messages)),
  };
}

// 单条消息也可以粗估（给 debug 用）
export function estimateMessageTokens(msg: ModelMessage): number {
  return charsToTokens(countMessageChars(msg));
}


// ═══════════════════════════════════════════════════════════════════════════
// Usage Summary 可视化：仿 /context 的风格、把成本 breakdown 变可读
// ═══════════════════════════════════════════════════════════════════════════
//
// 输出示例：
//   Usage Summary
//     3 步累计
//
//     ◎ Input             67 tokens
//     ◈ Cache write     1.1k tokens
//     ◉ Cache read      2.3k tokens   (65.4% hit)
//     ◇ Output            69 tokens
//
//     Cache hit rate  ████████████████████░░░░░░░░░░  65.4%
//
//     Cost            $0.0021
//     Without cache   $0.0039
//     Saved           $0.0018 (46.1% off)
//
// 设计要点：
//   - Cache write 单独一行——它是"投入"（首次写入贵 25%），不算命中
//   - hit rate 分母只算 miss input + cache read，不含 write（跟 UsageTracker 一致）
//   - 进度条 30 格——满格 100%，能一眼看出命中程度

const USAGE_SYMBOL = {
  input:      '◎',   // 圆圈中心点——真正的 miss
  cacheWrite: '◈',   // 菱形嵌方块——写入 cache（投入）
  cacheRead:  '◉',   // 双圈实心——命中 cache（收益）
  output:     '◇',   // 空心菱形——生成
} as const;

// 进度条：n 格总长、按 pct 填充
const BAR_WIDTH = 30;
function progressBar(pct: number): string {
  const filled = Math.round(BAR_WIDTH * Math.max(0, Math.min(1, pct)));
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

// 主入口：把 UsageTracker.totals() 的结果渲染成一段可读文本
export function renderUsageSummary(totals: UsageTotals): string {
  if (totals.steps === 0) {
    return 'Usage Summary\n  还没有 API 调用记录（跑几轮对话就有了）';
  }

  const lines: string[] = [];
  lines.push('Usage Summary');
  lines.push(`  ${totals.steps} 步累计`);
  lines.push('');

  // 四类 tokens——按语义分组、cache read 那行带命中率
  const hitPct = (totals.cacheHitRate * 100).toFixed(1);
  lines.push(`  ${USAGE_SYMBOL.input}      Input        ${padLeft(fmtTokens(totals.inputTokens), 8)} tokens`);
  lines.push(`  ${USAGE_SYMBOL.cacheWrite} Cache write  ${padLeft(fmtTokens(totals.cacheWriteTokens), 8)} tokens`);
  lines.push(`  ${USAGE_SYMBOL.cacheRead}  Cache read   ${padLeft(fmtTokens(totals.cacheReadTokens), 8)} tokens   (${hitPct}% hit)`);
  lines.push(`  ${USAGE_SYMBOL.output}      Output       ${padLeft(fmtTokens(totals.outputTokens), 8)} tokens`);
  lines.push('');

  // 命中率进度条
  lines.push(`  Cache hit rate  ${progressBar(totals.cacheHitRate)}  ${hitPct}%`);
  lines.push('');

  // 三行成本对比：实际 / 假设无 cache / 省下
  const savedPct = (totals.savedPct * 100).toFixed(1);
  lines.push(`  Cost            $${totals.cost.toFixed(4)}`);
  lines.push(`  Without cache   $${totals.baselineCost.toFixed(4)}`);
  lines.push(`  Saved           $${totals.savedCost.toFixed(4)} (${savedPct}% off)`);

  return lines.join('\n');
}
