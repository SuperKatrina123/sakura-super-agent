import type { MemoryStore } from '../memory/store.ts';
import type { SqliteVectorStore } from '../rag/sqlite-store.ts';
import type { SkillLoader } from '../skills/loader.ts';
import type { PromptContext } from './prompt-builder.ts';

// ═══════════════════════════════════════════════════════════════════════════
// prompt-pipes.ts — 依赖运行时组件的 pipe（区别于 segments.ts 里的纯 ctx pipe）
// ═══════════════════════════════════════════════════════════════════════════
//
// 分工：
//   segments.ts       只依赖 PromptContext 里的数据
//                     coreRules / toolGuide / deferredTools / sessionContext
//   prompt-pipes.ts   依赖外部组件（闭包捕获）
//                     memoryContext(store) / ragContext(store)
//
// 为什么"闭包依赖 vs ctx 字段"分开：
//   - PromptContext 里放"每轮变的运行时状态"（tool count、message count）
//   - 闭包捕获"启动时初始化的组件"（store、chunks）——**避免 Context 越来越臃肿**

type PipeFn = (ctx: PromptContext) => string | null;

// memoryContext: 把 MemoryStore 的索引注入 SYSTEM
// 让 Agent 一进 loop 就看到"我有哪些记忆"、无需 tool call 就能用
export function memoryContext(memoryStore: MemoryStore): PipeFn {
  return () => memoryStore.buildPromptSection();
}

// ragContext: 声明"知识库存在、可以用 rag_search 查"
// 参数是 **getter 函数** 而不是 store 实例——避免"pipe 声明时 store 还没建好"的顺序问题
// caller 在 main() 里创建 store、通过闭包引用即可（`ragContext(() => store)`）
export function ragContext(getStore: () => SqliteVectorStore | null): PipeFn {
  return () => {
    const store = getStore();
    if (!store) return null;
    const size = store.size();
    if (size === 0) return null;
    // sources 稳定排序——cache 前缀友好
    const sources = store.sources().sort();
    return `[知识库] 已索引 ${sources.length} 个文档、共 ${size} 个片段。用 rag_search 工具按语义搜索。
可用文档：${sources.join('、')}`;
  };
}

// skillsContext: 把 skill 索引 + 激活的 body 注入 SYSTEM
// 渐进式加载三层：
//   未激活 → 只显示 name + description（+ when_to_use 如果有）
//   激活   → 完整 body 注入、Agent 一进 loop 就看到详细指令
// **不注入 = SYSTEM 里没有 [激活的 Skill] 标记 = Agent 需要主动 skill_load**
//
// 空 skill 时不出现——避免"可用 Skills: 无"这种噪音
export function skillsContext(loader: SkillLoader): PipeFn {
  return () => loader.buildPromptSection();
}
