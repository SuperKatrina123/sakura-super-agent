import type { CommandHandler } from './index.ts';
import type { ModelMessage } from 'ai';
import { agentLoop } from '../agent/loop.ts';

// ═══════════════════════════════════════════════════════════════════════════
// memory.ts — 跨会话记忆的 REPL 快捷命令
// ═══════════════════════════════════════════════════════════════════════════
//
// - memory                列出所有记忆、按 type 分组
// - memory search <query> 关键词搜索
// - memory read <name>    读取单条记忆的完整内容
// - memory forget <name>  删除一条记忆
// - memory lint [prune]   体检 + 可选清理
// - memory dream / dream  Agent 自主整理记忆（Layer 3、prompt-driven）
//
// 支持两种前缀：`memory ...` 和 `/memory ...`——跟 Claude Code 的 slash 命令风格兼容

function stripPrefix(cmd: string, verb: string): string | null {
  const p1 = `memory ${verb} `;
  const p2 = `/memory ${verb} `;
  if (cmd.startsWith(p1)) return cmd.slice(p1.length).trim();
  if (cmd.startsWith(p2)) return cmd.slice(p2.length).trim();
  return null;
}

// memory / /memory: 列出所有记忆、按 type 分组
export const memoryListHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'memory' && cmd !== '/memory') return false;
  const entries = ctx.memoryStore.list();
  const stats = ctx.memoryStore.stats();
  console.log(`\n[记忆系统] 共 ${entries.length} 条 · 索引 ${stats.indexPath}`);
  if (entries.length === 0) {
    console.log('  (空——让 Agent 通过 memory 工具主动写入)\n');
    ctx.ask();
    return true;
  }
  const groups: Record<string, typeof entries> = { user: [], feedback: [], project: [], reference: [] };
  for (const e of entries) groups[e.type].push(e);
  for (const [type, list] of Object.entries(groups)) {
    if (list.length === 0) continue;
    console.log(`\n  [${type}]`);
    for (const e of list) {
      const desc = e.description.length > 60 ? e.description.slice(0, 60) + '…' : e.description;
      console.log(`    - ${e.name} — ${desc}`);
    }
  }
  console.log('');
  ctx.ask();
  return true;
};

// memory search <query>: 关键词搜索
export const memorySearchHandler: CommandHandler = (cmd, ctx) => {
  const query = stripPrefix(cmd, 'search');
  if (query === null) return false;
  if (!query) {
    console.log('[记忆搜索] 用法: memory search <关键词>');
    ctx.ask();
    return true;
  }
  const results = ctx.memoryStore.search(query);
  console.log(`\n[记忆搜索] "${query}" → ${results.length} 条结果`);
  for (const e of results) {
    console.log(`  [${e.type}] ${e.name} — ${e.description}`);
  }
  console.log('');
  ctx.ask();
  return true;
};

// memory read <name>: 读取单条记忆的完整内容
export const memoryReadHandler: CommandHandler = (cmd, ctx) => {
  const name = stripPrefix(cmd, 'read');
  if (name === null) return false;
  if (!name) {
    console.log('[记忆读取] 用法: memory read <name>');
    ctx.ask();
    return true;
  }
  const entries = ctx.memoryStore.list();
  const target = entries.find(e => e.name === name);
  if (!target) {
    console.log(`[记忆读取] 没找到名为 "${name}" 的记忆——用 memory 查看现有条目`);
    ctx.ask();
    return true;
  }
  console.log(`\n[记忆读取] ${target.name} (${target.type})`);
  console.log(`  ${target.description}`);
  console.log(`  ${target.filePath}${target.createdAt ? ` · ${target.createdAt}` : ''}`);
  console.log(`\n${target.content}\n`);
  ctx.ask();
  return true;
};

// memory forget <name>: 删除一条记忆
export const memoryForgetHandler: CommandHandler = (cmd, ctx) => {
  const name = stripPrefix(cmd, 'forget');
  if (name === null) return false;
  if (!name) {
    console.log('[记忆删除] 用法: memory forget <name>');
    ctx.ask();
    return true;
  }
  const ok = ctx.memoryStore.delete(name);
  console.log(ok
    ? `[记忆删除] 已删除 "${name}"`
    : `[记忆删除] 没找到名为 "${name}" 的记忆`);
  ctx.ask();
  return true;
};

// memory lint / memory lint prune: 体检 + 可选清理
export const memoryLintHandler: CommandHandler = (cmd, ctx) => {
  const trimmed = cmd.trim();
  const isLint = trimmed === 'memory lint' || trimmed === '/memory lint'
                 || trimmed === 'memory lint prune' || trimmed === '/memory lint prune';
  if (!isLint) return false;
  const prune = trimmed.endsWith('prune');

  const { reports, summary, pruned } = ctx.memoryStore.lintAndPrune('.', prune);
  console.log(`\n[Memory Lint] 共 ${summary.total} 条: ok=${summary.ok} / warn=${summary.warn} / toDelete=${summary.toDelete}`);
  console.log(`  分类: stale_path=${summary.byKind.stale_path} / expired=${summary.byKind.expired} / stale_content=${summary.byKind.stale_content} / duplicate_name=${summary.byKind.duplicate_name}`);

  if (prune) {
    console.log(`  已删除 ${pruned} 条`);
  } else if (summary.toDelete > 0) {
    console.log(`  提示: ${summary.toDelete} 条建议删除、跑 "memory lint prune" 才会实际清理`);
  }

  for (const r of reports) {
    if (r.issues.length === 0) continue;
    console.log(`\n  [${r.entry.type}] ${r.entry.name}:`);
    for (const i of r.issues) {
      console.log(`    ${i.severity === 'delete' ? '✗' : '⚠'} ${i.message}`);
    }
  }
  console.log('');
  ctx.ask();
  return true;
};

// dream / memory dream: Agent 自主整理记忆
// **prompt-driven**——不硬编码"什么该删/什么该合并"、把 lint 报告丢给 Agent、让它判断
// Layer 3 的最后一层——处理 lint 规则无法覆盖的复杂决策（"这两条重复、哪个内容更全"）
// 消耗：一次 agentLoop（多步 tool call）——用户显式触发、不自动跑
export const memoryDreamHandler: CommandHandler = async (cmd, ctx) => {
  const trimmed = cmd.trim();
  if (trimmed !== 'dream' && trimmed !== 'memory dream' && trimmed !== '/dream' && trimmed !== '/memory dream') {
    return false;
  }
  console.log('\n[dream] 开始记忆整理...');

  // 三阶段 prompt：定位（lint）→ 整理（Agent 自主决策）→ 报告
  // 不硬编码"如何处理"——只说"lint 报告是数据源、按 severity 判断动作"
  const dreamPrompt = [
    '请对记忆库做一次完整的整理（dream），按以下阶段执行：',
    '',
    '**阶段 1：定位** — 用 memory 工具 action=lint 扫描全库（报告已包含每条 issue 的严重性和描述、不需要逐条 read）。',
    '**阶段 2：整理** — 根据 lint 报告直接操作：',
    '  - severity=delete（expired）的条目直接 memory action=delete',
    '  - duplicate_name 的多条：memory action=read 对比内容后、保留更新的、delete 多余的',
    '  - stale_path / stale_content 的：如果内容仍有价值、用 memory action=save 覆盖修正（同名自动覆盖）',
    '**阶段 3：报告** — 用一段文字总结这次整理做了什么、哪些条目被删/被合并/被更新。',
    '',
    '注意：memory 工具的 delete 传 name（不是 filename）、save 时同名自动覆盖。',
  ].join('\n');

  const userMsg: ModelMessage = { role: 'user', content: dreamPrompt };
  ctx.messages.push(userMsg);
  ctx.sessionStore.append(userMsg);   // 落盘、跟正常对话一致——支持 --continue 看 dream 结果

  const dynamicSystem = ctx.builder.build(ctx.makePromptCtx());
  await agentLoop(ctx.model, ctx.registry, ctx.messages, dynamicSystem, ctx.budget, {
    usageTracker: ctx.tracker,
    modelInfo: ctx.modelInfo,
    cacheDisabled: ctx.cacheState.disabled,
  });

  console.log('\n[dream 完成]\n');
  ctx.ask();
  return true;
};
