import type { CommandHandler } from './index.ts';

// ═══════════════════════════════════════════════════════════════════════════
// cache.ts — Cache 实验开关的 3 个命令
// ═══════════════════════════════════════════════════════════════════════════
//
// - cache off     启用 nonce 让 cache 全 miss（对照实验用）
// - cache on      恢复正常（默认）
// - cache         查看当前状态
//
// 状态通过 ctx.cacheState.disabled 桥接（ref 语义）——handler 直接改这个字段、
// index.ts 传给 agentLoop 时读它就行

export const cacheOffHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'cache off') return false;
  ctx.cacheState.disabled = true;
  console.log(`[Cache] 已禁用——下轮开始 SYSTEM 加 nonce 破坏 cache（实验对照）`);
  ctx.ask();
  return true;
};

export const cacheOnHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'cache on') return false;
  ctx.cacheState.disabled = false;
  console.log(`[Cache] 已恢复——cache 正常工作`);
  ctx.ask();
  return true;
};

// 裸 'cache' 命令——查看当前状态
// 注意顺序：这个 handler 必须放在 cacheOff / cacheOn 之后，否则会先匹配到 'cache'
// dispatcher 靠 handler 数组顺序、handler 内部靠字符串精确匹配
export const cacheStatusHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== 'cache') return false;
  const state = ctx.cacheState.disabled ? 'OFF（cache 被禁用中）' : 'ON';
  console.log(`[Cache] 当前状态: ${state}`);
  console.log(`  切换用法: "cache off" / "cache on"`);
  ctx.ask();
  return true;
};
