import type { ModelMessage } from 'ai';
import type { ToolRegistry } from '../tools/tool-registry.ts';
import type { PromptBuilder, PromptContext } from '../context/prompt-builder.ts';
import type { UsageTracker } from '../session/usage-tracker.ts';
import type { SessionStore } from '../session/store.ts';
import type { MemoryStore } from '../memory/store.ts';

// ═══════════════════════════════════════════════════════════════════════════
// 快捷命令 dispatcher
// ═══════════════════════════════════════════════════════════════════════════
//
// index.ts 的 ask() 里原本堆了 8 个 if (trimmed === '...') 分支——散且难维护
// 拆成按功能域分组的 handler，用 dispatcher 串起来：
//   - view.ts     — 空间/成本可视化（context / usage / status）
//   - defense.ts  — 三层防线（sim / defend）
//   - cache.ts    — Cache 实验开关（cache on/off/裸）
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
  memoryStore: MemoryStore;   // /context 命令要单独算 memory 字符数
  makePromptCtx: () => PromptContext;
  ask: () => void;                        // 处理完命令后重新提示输入
  // Cache 实验开关——handler 读写需要 getter/setter，直接暴露 ref 的状态桥接
  cacheState: { disabled: boolean };
  modelInfo: { provider: string; modelName: string };
}

export type CommandHandler = (cmd: string, ctx: CommandContext) => boolean;

// 组合多个 handler、按顺序试
// 前面的 handler 认识就停止；都不认识返回 false，caller 走正常对话路径
export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      if (h(cmd, ctx)) return true;
    }
    return false;
  };
}
