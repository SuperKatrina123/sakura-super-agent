import type { CommandHandler } from './index.ts';
import type { ModelMessage } from 'ai';
import { agentLoop } from '../agent/loop.ts';

// /skill / /skill list：列出所有 skill
export const skillListHandler: CommandHandler = (cmd, ctx) => {
  const t = cmd.trim();
  if (t !== '/skill' && t !== '/skill list' && t !== 'skill' && t !== 'skill list') return false;

  const loader = ctx.skillLoader;
  if (!loader) {
    console.log('[Skill] SkillLoader 未挂载');
    ctx.ask();
    return true;
  }

  const skills = loader.list();
  if (skills.length === 0) {
    console.log(`\n[Skill] 当前没有 skill——放到 .skills/<name>/SKILL.md 就会被自动加载\n`);
    ctx.ask();
    return true;
  }

  console.log(`\n[Skill] 共 ${skills.length} 个:\n`);
  for (const s of skills) {
    const status = loader.isActive(s.name) ? '● 激活' : '○ 未激活';
    console.log(`  ${status}  ${s.name}`);
    console.log(`         ${s.description}`);
    if (s.whenToUse) console.log(`         适用场景: ${s.whenToUse}`);
    console.log('');
  }
  console.log('用法:');
  console.log('  /skill load <name>     激活');
  console.log('  /skill unload <name>   卸载');
  console.log('  /<name>                快捷激活 + 立即执行\n');
  ctx.ask();
  return true;
};

// /skill load <name>：激活
export const skillLoadHandler: CommandHandler = (cmd, ctx) => {
  const t = cmd.trim();
  const m = /^\/?skill load\s+(.+)$/.exec(t);
  if (!m) return false;

  const loader = ctx.skillLoader;
  if (!loader) { console.log('[Skill] SkillLoader 未挂载'); ctx.ask(); return true; }

  const name = m[1].trim();
  if (loader.isActive(name)) {
    console.log(`[Skill] "${name}" 已经激活了`);
  } else if (loader.activate(name)) {
    console.log(`[Skill] 已激活 "${name}"——下一轮对话 SYSTEM 会包含完整指令`);
  } else {
    const available = loader.list().map((s) => s.name).join(', ');
    console.log(`[Skill] 没找到 "${name}"。可用: ${available || '(空)'}`);
  }
  ctx.ask();
  return true;
};

// /skill unload <name>：卸载
export const skillUnloadHandler: CommandHandler = (cmd, ctx) => {
  const t = cmd.trim();
  const m = /^\/?skill unload\s+(.+)$/.exec(t);
  if (!m) return false;

  const loader = ctx.skillLoader;
  if (!loader) { console.log('[Skill] SkillLoader 未挂载'); ctx.ask(); return true; }

  const name = m[1].trim();
  console.log(loader.deactivate(name)
    ? `[Skill] 已卸载 "${name}"`
    : `[Skill] "${name}" 本来就不在激活列表里`);
  ctx.ask();
  return true;
};

// /<skill-name>：快捷方式——激活 + 立即让 Agent 按 SOP 执行
// 跟 dream handler 同 pattern——async、触发一次 agentLoop
// 参数：/<skill-name> 或 /<skill-name> <额外说明>
export const skillShortcutHandler: CommandHandler = async (cmd, ctx) => {
  const t = cmd.trim();
  if (!t.startsWith('/')) return false;

  // 排除已知的其他 slash 命令——避免抢
  const known = ['/skill', '/memory', '/dream', '/context', '/usage', '/help', '/exit'];
  if (known.some(k => t === k || t.startsWith(k + ' '))) return false;

  const loader = ctx.skillLoader;
  if (!loader) return false;

  // 匹配 /<name> 或 /<name> <extra text>
  const m = /^\/([\w-]+)(?:\s+(.+))?$/.exec(t);
  if (!m) return false;

  const name = m[1];
  const extra = m[2]?.trim() ?? '';

  const skill = loader.get(name);
  if (!skill) return false;   // 不是已知 skill——让下一个 handler 或正常路径处理

  // 激活 + 把 skill body 作为 user 消息注入
  // 这样 Agent 立刻在这一轮就按 skill 指令执行、不用等下轮 SYSTEM
  loader.activate(name);
  const promptLines = [`请按下面的 skill 指令执行任务。`];
  if (extra) promptLines.push(`用户额外说明: ${extra}`);
  promptLines.push('', `[Skill: ${name}]`, skill.content);
  const userMsg: ModelMessage = { role: 'user', content: promptLines.join('\n') };
  ctx.messages.push(userMsg);
  ctx.sessionStore.append(userMsg);

  console.log(`\n[/${name}] 激活 skill 并开始执行...\n`);
  const dynamicSystem = ctx.builder.build(ctx.makePromptCtx());
  await agentLoop(ctx.model, ctx.registry, ctx.messages, dynamicSystem, ctx.budget, {
    usageTracker: ctx.tracker,
    modelInfo: ctx.modelInfo,
    cacheDisabled: ctx.cacheState.disabled,
  });
  console.log(`\n[/${name} 完成]\n`);
  ctx.ask();
  return true;
};
