import type { PromptContext } from './prompt-builder.ts';

// 每个 segment 是一个"工厂函数"——返回真正的 PipeFn
// 工厂化是为了将来给 segment 传"构造时参数"（比如 coreRules(persona) 定制人格）
// 现在没参数，一个函数调用而已，语法上稍显啰嗦；但接口一致，加参数不用回来改 index.ts

type PipeFn = (ctx: PromptContext) => string | null;

// 身份 + 工具搜索引导——永远不变，最先出现（cache 命中率最高）
export function coreRules(): PipeFn {
  return () => `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。
如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。`;
}

// 工具数量提示——让模型对当前可用能力有个数
// 工具数为 0（极端情况：注册全失败）时不出现，避免误导
export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null;
    return `当前 registry 里有 ${ctx.toolCount} 个工具可用。`;
  };
}

// 会话上下文——只在恢复历史时出现（sessionMessageCount > 0）
// 新会话时返回 null，pipe 里完全不占位置——这就是 Pipe 模式的价值：
// 条件逻辑和内容在同一个模块里，加新 section 零摩擦
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 会话 ${ctx.sessionId} 已有 ${ctx.sessionMessageCount} 条历史消息。`;
  };
}

// 延迟工具目录——每轮变（discoveredTools 每次都可能不同）
// 放最后，让前面的 segment 尽量保持 cache 命中
export function deferredTools(): PipeFn {
  return (ctx) => {
    if (ctx.deferredTools.length === 0) return null;
    const lines = ctx.deferredTools.map(t => {
      const hint = t.hint ? ` — ${t.hint}` : '';
      return `  - ${t.name}${hint}`;
    });
    return `以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`;
  };
}
