import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry, MemoryType } from './store.ts';

// ═══════════════════════════════════════════════════════════════════════════
// Memory Validator：lint 体检 + TTL 分级
// ═══════════════════════════════════════════════════════════════════════════
//
// 应对 memory 系统的两个坏——**过期**和**爆炸**
//
// 三种诊断结果（返回 issues 数组、caller 决定动作）：
//   - **stale_path**   引用的路径不存在——代码变更、记忆没跟上
//   - **expired**      超过 type 对应 TTL——该删
//   - **stale_content**含推测词/时效性词——需要人工确认
//
// TTL 按 type 差异化——**"越久越有价值"的记忆永不过期**：
//   - user       无 TTL（用户画像稳定、几年不变）
//   - feedback   无 TTL（行为规则应长期遵守）
//   - project    30 天（进行中的工作衰减最快）
//   - reference  90 天（外部资源位置稳定但要定期验证）
//
// 关键设计：validator 只诊断、不执行删除
//   - 返回 issues 数组、caller（store.lintAndPrune）决定动作
//   - 单一职责、易测——纯函数、无 side effect

// TTL 阈值（天）——无穷大表示永不过期
// 参考 memory-system-design.md §6 的过期提醒策略
const TTL_BY_TYPE: Record<MemoryType, number> = {
  user: Infinity,       // 用户画像——永不过期
  feedback: Infinity,   // 行为规则——永不过期
  project: 30,          // 项目动态——衰减最快
  reference: 90,        // 外部资源——定期验证
};

// 结构性 lint 的三个正则——命中就打 stale 标记（不删、只警告）
// 中英混合、覆盖常见推测词和时效性词
const SPECULATIVE_PATTERN = /(可能|大概|应该|似乎|好像|probably|maybe|estimate|guess)/i;
const TEMPORAL_PATTERN = /(当前|目前|现在|今天|本周|这周|下周|this week|currently|nowadays|as of)/i;
// 代码路径：src/xxx/yyy.ts / lib/foo.js 等
// 用 \b 而不是 ^——正则要能在句子中间匹配
const CODE_PATH_PATTERN = /\b(?:src|lib|app|test|tests|scripts?)\/[\w/.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java)\b/g;

export type IssueKind = 'stale_path' | 'expired' | 'stale_content' | 'duplicate_name';

export interface ValidationIssue {
  kind: IssueKind;
  message: string;
  // severity 决定 caller 该采取什么动作：
  //   - 'warn'   保留 + 加提醒（stale_path / stale_content）
  //   - 'delete' 该删（expired）
  severity: 'warn' | 'delete';
}

// 主入口：诊断一条 memory
// baseDir 用于解析 content 里的相对路径——默认 '.'
export function validateEntry(entry: MemoryEntry, baseDir = '.'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ── 1. 路径过期检测——引用的路径不存在 ────────────────────────────────
  // 比"含路径就警告"更准——文件删了、rename 了都能立刻发现
  const paths = extractPaths(entry.content);
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
    if (!fs.existsSync(abs)) {
      issues.push({
        kind: 'stale_path',
        severity: 'warn',
        message: `引用的路径不存在：${p}`,
      });
    }
  }

  // ── 2. TTL 判断——按 type 差异化过期 ─────────────────────────────────
  // 用 lastReadAt 而不是 createdAt——**LRU 语义**：经常被读的记忆不该被清
  // fallback 到 lastWriteAt / createdAt——老文件可能没 lastReadAt
  // 都没 = 不判（宁可留、不误删）
  const anchorTime = entry.lastReadAt ?? entry.lastWriteAt ?? entry.createdAt;
  if (anchorTime) {
    const ttlDays = TTL_BY_TYPE[entry.type];
    if (Number.isFinite(ttlDays)) {
      const ageDays = (Date.now() - new Date(anchorTime).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > ttlDays) {
        issues.push({
          kind: 'expired',
          severity: 'delete',
          message: `已 ${Math.floor(ageDays)} 天没被读过、超过 ${entry.type} 类型的 ${ttlDays} 天 TTL`,
        });
      }
    }
  }

  // ── 3. 结构性 lint——含推测词/时效性词 ──────────────────────────────
  // 只 warn、不删——这些内容可能仍有价值、只是要人工确认
  const spec = entry.content.match(SPECULATIVE_PATTERN);
  if (spec) {
    issues.push({
      kind: 'stale_content',
      severity: 'warn',
      message: `含推测词"${spec[0]}"——建议改成事实性表述`,
    });
  }

  const temp = entry.content.match(TEMPORAL_PATTERN);
  if (temp) {
    issues.push({
      kind: 'stale_content',
      severity: 'warn',
      message: `含时效性词"${temp[0]}"——可能已过时、建议改成绝对日期`,
    });
  }

  return issues;
}

// 提取 content 里的所有代码路径——用 CODE_PATH_PATTERN 全局匹配
// 返回**去重后**的路径列表（同一路径多次出现只 lint 一次）
export function extractPaths(content: string): string[] {
  const matches = content.match(CODE_PATH_PATTERN) ?? [];
  return [...new Set(matches)];
}

// 批量诊断：扫一批 memory、返回诊断结果
// 每条 memory 附带自己的 issues 列表——空数组表示"没问题"
// caller（store.lintAndPrune）根据 severity=delete 决定删哪些
export interface EntryReport {
  entry: MemoryEntry;
  issues: ValidationIssue[];
}

// 批量诊断：跑单条 validateEntry + 额外的**跨记忆重名检测**
// 单条 validator 看不到"另一条同名"——重名要在批量层做
// Agent 在不同时间点存两条名字相同但内容不一样的记忆——这是冲突信号、需要人工合并
export function validateAll(entries: MemoryEntry[], baseDir = '.'): EntryReport[] {
  const reports = entries.map(entry => ({
    entry,
    issues: validateEntry(entry, baseDir),
  }));

  // 跨记忆检测：按 name 分组、找出出现多次的
  const nameCount = new Map<string, number>();
  for (const e of entries) nameCount.set(e.name, (nameCount.get(e.name) ?? 0) + 1);

  for (const report of reports) {
    const count = nameCount.get(report.entry.name) ?? 0;
    if (count > 1) {
      report.issues.push({
        kind: 'duplicate_name',
        severity: 'warn',
        // 不 delete——不知道该保留哪一条、让人来判断
        message: `名字"${report.entry.name}"出现 ${count} 次——可能是不同时间存的冲突条目、建议合并或删除其中一条`,
      });
    }
  }

  return reports;
}

// 汇总统计——REPL 命令 `memory lint` 用
export interface LintSummary {
  total: number;
  ok: number;
  warn: number;
  toDelete: number;
  byKind: Record<IssueKind, number>;
}

export function summarize(reports: EntryReport[]): LintSummary {
  const summary: LintSummary = {
    total: reports.length,
    ok: 0,
    warn: 0,
    toDelete: 0,
    byKind: { stale_path: 0, expired: 0, stale_content: 0, duplicate_name: 0 },
  };
  for (const r of reports) {
    if (r.issues.length === 0) {
      summary.ok++;
      continue;
    }
    const hasDelete = r.issues.some(i => i.severity === 'delete');
    if (hasDelete) summary.toDelete++;
    else summary.warn++;
    for (const i of r.issues) summary.byKind[i.kind]++;
  }
  return summary;
}
