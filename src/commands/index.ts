import type { ModelMessage } from 'ai';
import type { ToolRegistry } from '../tools/tool-registry.ts';
import type { PromptBuilder, PromptContext } from '../context/prompt-builder.ts';
import type { UsageTracker } from '../session/usage-tracker.ts';
import type { SessionStore } from '../session/store.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { SkillLoader } from '../skills/loader.ts';
import type { BudgetState } from '../agent/loop.ts';

// ═══════════════════════════════════════════════════════════════════════════
// 快捷命令 dispatcher
// ═══════════════════════════════════════════════════════════════════════════
//
// index.ts 的 ask() 里原本堆了 8 个 if (trimmed === '...') 分支——散且难维护
// 拆成按功能域分组的 handler，用 dispatcher 串起来：
//   - view.ts     — 空间/成本可视化（context / usage / status）
//   - defense.ts  — 三层防线（sim / defend）
//   - cache.ts    — Cache 实验开关（cache on/off/裸）
//   - memory.ts   — 记忆管理（list / search / read / forget / lint / dream）
//
// 每个 handler 是一个函数：
//   - 认识这个命令 → 处理完 return true（dispatcher 停止 fallthrough）
//   - 不认识 → return false（dispatcher 试下一个 handler）
//
// 返回值只有 boolean——命令自己调不调 ask() 是它自己的事、不通过返回值区分

// dispatcher 和 handler 共用的上下文
// 明确列出所有依赖、不加 [key: string]: any——将来加字段时 TypeScript 会提醒 handler 更新
export interface CommandContext {
  messages: ModelMessage[];
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  sessionStore: SessionStore;
  memoryStore: MemoryStore;
  skillLoader: SkillLoader;
  makePromptCtx: () => PromptContext;
  ask: () => void;                        // 处理完命令后重新提示输入
  cacheState: { disabled: boolean };
  modelInfo: { provider: string; modelName: string };
  // ↓ dream 命令要触发 agent loop——需要 model + budget
  //   将来其他"命令能触发 loop"的场景可以复用（比如"帮我处理最新 issues"）
  //   model 类型走 any——跟 agentLoop 的签名对齐、避免 SDK v2/v3 类型不匹配
  model: any;
  budget: BudgetState;
}

export type CommandHandler = (cmd: string, ctx: CommandContext) => boolean | Promise<boolean>;

// 组合多个 handler、按顺序试
// 前面的 handler 认识就停止；都不认识返回 false，caller 走正常对话路径
// 支持 async handler——await 每一个、拿到 boolean 后再决定要不要 fallthrough
export function createDispatcher(handlers: CommandHandler[]): (cmd: string, ctx: CommandContext) => Promise<boolean> {
  return async (cmd, ctx) => {
    for (const h of handlers) {
      const result = await h(cmd, ctx);
      if (result) return true;
    }
    return false;
  };
}
