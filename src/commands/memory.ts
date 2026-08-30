import type { CommandHandler } from './index.ts';

// ═══════════════════════════════════════════════════════════════════════════
// memory.ts — 跨会话记忆的 REPL 快捷命令
// ═══════════════════════════════════════════════════════════════════════════
//
// - memory                列出所有记忆、按 type 分组
// - memory search <query> 关键词搜索
// - memory read <name>    读取单条记忆的完整内容
// - memory forget <name>  删除一条记忆
//
// 支持两种前缀：`memory ...` 和 `/memory ...`——跟 Claude Code 的 slash 命令风格兼容
// 命令解析放在 handler 内部：dispatcher 只做"字符串 → handler"路由、参数解析归 handler

// 内部工具：识别命令前缀并返回参数部分
// 支持 "memory X" 和 "/memory X" 两种写法
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
  // 按 type 分组打印
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
