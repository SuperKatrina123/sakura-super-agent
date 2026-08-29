// ═══════════════════════════════════════════════════════════════════════════
// UsageTracker：Cache 可视化——把 token 消耗和实际花费分开算清
// ═══════════════════════════════════════════════════════════════════════════
//
// 上下文小 ≠ 花钱少。cache 命中率决定真实成本。
// 这个 tracker 把每步的 API usage 归一化成"四类 token"：
//   - inputTokens        真正的 cache miss（按 input 价算）
//   - cacheReadTokens    命中的部分（按 cacheRead 价算，通常 10-25% off）
//   - cacheWriteTokens   首次写入 cache 的部分（Anthropic 特有、通常贵 25%）
//   - outputTokens       模型生成的部分（按 output 价算）
//
// 然后基于价目表算：
//   - 真实成本 (cost)
//   - baseline 成本（假设无 cache、全按 input 价算）
//   - saved (= baseline - cost) 就是 cache 省下的钱

export interface ModelPricing {
  input: number;       // $/1M tokens (cache miss)
  output: number;
  cacheWrite: number;  // Anthropic 特有——首次写入价格（通常比 input 贵 25%）
  cacheRead: number;   // cache 命中价格（通常是 input 的 10-25%）
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
  'claude-sonnet-4-7': { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5':  { input: 1.00,  output: 5.00,  cacheWrite: 1.25,  cacheRead: 0.10 },
  'gpt-5':             { input: 5.00,  output: 15.00, cacheWrite: 5.00,  cacheRead: 1.25 },
  // DeepSeek 两个版本都覆盖——避免"忘了加价目表"的静默错误
  'deepseek-v3-2':     { input: 0.27,  output: 1.10,  cacheWrite: 0.27,  cacheRead: 0.027 },
  'deepseek-v4-flash': { input: 0.27,  output: 1.10,  cacheWrite: 0.27,  cacheRead: 0.027 },
  'qwen3-6-plus':      { input: 0.40,  output: 1.20,  cacheWrite: 0.40,  cacheRead: 0.04 },
  'mock-model':        { input: 1.00,  output: 5.00,  cacheWrite: 1.25,  cacheRead: 0.10 },
};

// 一步 API 调用归一化后的四类 token 计数
export interface StepUsage {
  inputTokens: number;       // 真正 cache miss 的部分（不含 cacheRead）
  outputTokens: number;
  cacheReadTokens: number;   // 命中的部分
  cacheWriteTokens: number;  // 首次写入 cache
}

// 一步的完整成本 breakdown——log 用
export interface StepCost {
  input: number;        // $
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;        // = input + output + cacheRead + cacheWrite
  baseline: number;     // 假设无 cache、全按 input 价算的成本（用来算 saved）
}

export interface StepRecord extends StepUsage {
  ts: number;
  model: string;
  cost: StepCost;
}

export interface UsageContext {
  provider?: string;         // 用来做 provider 特化归一化（OpenAI input 包含 cache）
  providerMetadata?: any;    // AI SDK 的 providerMetadata（Anthropic cache write 从这里挖）
}

// OpenAI 的 inputTokens **包含**了 cachedInputTokens——需要减去
// 其他 provider 的 inputTokens 是"纯 miss"——直接用
// 判断 provider 用可选 context.provider（否则默认 non-openai 语义）
export function normalizeUsage(usage: any, context: UsageContext = {}): StepUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  // AI SDK 标准字段：cachedInputTokens（命中）
  const cacheRead = usage.cachedInputTokens ?? 0;

  // cacheWrite 只 Anthropic 有——两个可能的挂载位置都检查
  const cacheWrite =
    usage.cacheCreationInputTokens                                     // Anthropic SDK 直接挂顶层
    ?? context.providerMetadata?.anthropic?.cacheCreationInputTokens   // AI SDK provider 元数据
    ?? 0;

  // OpenAI 特化：raw inputTokens 里已经含了 cachedInputTokens——减去避免重复算钱
  const rawInputTokens = usage.inputTokens ?? 0;
  const inputTokens = context.provider?.startsWith('openai')
    ? Math.max(0, rawInputTokens - cacheRead)
    : rawInputTokens;

  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

// 查价目表——找不到打 warn 返回 0
// 静默 fallback 会导致"以为在算钱、实际是 0"的隐性 bug，宁可显式抛信号
const missedModels = new Set<string>();
function getPricing(model: string): ModelPricing | null {
  const p = PRICE_TABLE[model];
  if (p) return p;
  if (!missedModels.has(model)) {
    missedModels.add(model);
    console.warn(`[UsageTracker] 未知模型 "${model}"——成本按 0 计算。请在 PRICE_TABLE 里补充`);
  }
  return null;
}

// 单价 × token / 1M = 成本
// 四类分别算、加起来 = 本步真实花费
// baseline = 假设全按 input 价算（把 cacheRead / cacheWrite 都拉平成 input 价）
export function computeCost(model: string, usage: StepUsage): StepCost {
  const p = getPricing(model);
  if (!p) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, baseline: 0 };
  }

  const input      = (usage.inputTokens      / 1_000_000) * p.input;
  const output     = (usage.outputTokens     / 1_000_000) * p.output;
  const cacheRead  = (usage.cacheReadTokens  / 1_000_000) * p.cacheRead;
  const cacheWrite = (usage.cacheWriteTokens / 1_000_000) * p.cacheWrite;
  const total = input + output + cacheRead + cacheWrite;

  // baseline：把 cacheRead + cacheWrite 的 tokens 也按 input 价算——展示 cache 全生态省了多少
  const cacheTokens = usage.cacheReadTokens + usage.cacheWriteTokens;
  const baseline = input + output + (cacheTokens / 1_000_000) * p.input;

  return { input, output, cacheRead, cacheWrite, total, baseline };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;               // 真实花费 $
  baselineCost: number;       // 假设无 cache 的花费 $
  savedCost: number;          // = baseline - cost（cache 省的钱）
  savedPct: number;           // savedCost / baselineCost
  cacheHitRate: number;       // cacheRead / (input + cacheRead) —— 不算 cacheWrite（那是"投入"不是"命中"）
  steps: number;
}

export class UsageTracker {
  private steps: StepRecord[] = [];

  record(model: string, usage: StepUsage): StepRecord {
    const cost = computeCost(model, usage);
    const record: StepRecord = { ts: Date.now(), model, cost, ...usage };
    this.steps.push(record);
    return record;
  }

  // 会话结束或 status 命令时打累计——展示 cache 到底省了多少
  totals(): UsageTotals {
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
    let cost = 0, baselineCost = 0;

    for (const s of this.steps) {
      inputTokens      += s.inputTokens;
      outputTokens     += s.outputTokens;
      cacheReadTokens  += s.cacheReadTokens;
      cacheWriteTokens += s.cacheWriteTokens;
      cost             += s.cost.total;
      baselineCost     += s.cost.baseline;
    }

    const savedCost = Math.max(0, baselineCost - cost);
    const savedPct = baselineCost > 0 ? savedCost / baselineCost : 0;
    // 命中率：cacheRead 只跟 miss 的 input 比——不算 cacheWrite（首次写入是"投入"不是命中）
    const hitDenom = inputTokens + cacheReadTokens;
    const cacheHitRate = hitDenom > 0 ? cacheReadTokens / hitDenom : 0;

    return {
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      cost, baselineCost, savedCost, savedPct, cacheHitRate,
      steps: this.steps.length,
    };
  }

  // 最近一步——给每轮 loop 的紧凑 log 用
  last(): StepRecord | null {
    return this.steps[this.steps.length - 1] ?? null;
  }
}
