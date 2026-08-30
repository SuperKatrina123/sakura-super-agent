import type { MemoryStore } from '../memory/store.ts';
import type { EmbeddedChunk } from '../rag/index.ts';
import type { PromptContext } from './prompt-builder.ts';

// ═══════════════════════════════════════════════════════════════════════════
// prompt-pipes.ts — 依赖运行时组件的 pipe（区别于 segments.ts 里的纯 ctx pipe）
// ═══════════════════════════════════════════════════════════════════════════
//
// 分工：
//   segments.ts       只依赖 PromptContext 里的数据
//                     coreRules / toolGuide / deferredTools / sessionContext
//   prompt-pipes.ts   依赖外部组件（闭包捕获）
//                     memoryContext(store) / ragContext(chunks)
//
// 为什么"闭包依赖 vs ctx 字段"分开：
//   - PromptContext 里放"每轮变的运行时状态"（tool count、message count）
//   - 闭包捕获"启动时初始化的组件"（store、chunks）——**避免 Context 越来越臃肿**
//
// 一致性：所有依赖外部组件的 pipe 都是"有参工厂函数"——signal 依赖显式
//   memoryContext(memoryStore) → PipeFn
//   ragContext(chunks)         → PipeFn

type PipeFn = (ctx: PromptContext) => string | null;

// memoryContext: 把 MemoryStore 的索引注入 SYSTEM
// 让 Agent 一进 loop 就看到"我有哪些记忆"、无需 tool call 就能用
// store.buildPromptSection() 内部处理"空 / 有条目 / 超 24h 过期提醒"三种情况
export function memoryContext(memoryStore: MemoryStore): PipeFn {
  return () => memoryStore.buildPromptSection();
}

// ragContext: 声明"知识库存在、可以用 rag_search 查"
// **不注入检索结果**——那是每次 rag_search 调用时才做
// 只声明能力：让 Agent 知道"有个知识库、里面有 N 个片段、想查就用工具"
//
// 为什么加这个 pipe：
//   - 光注册 rag_search 工具是不够的——Agent 可能不知道"知识库里有什么"
//   - 告诉它规模和来源、Agent 判断"这问题该不该查文档"更准
//   - 空知识库（size=0）不出现、避免 Agent 调空工具
export function ragContext(chunks: EmbeddedChunk[]): PipeFn {
  return () => {
    if (chunks.length === 0) return null;
    // 提取所有独立来源——用 Set 去重、按字母排序稳定输出（cache 友好）
    const sources = [...new Set(chunks.map(c => c.source))].sort();
    return `[知识库] 已索引 ${sources.length} 个文档、共 ${chunks.length} 个片段。用 rag_search 工具按语义搜索。
可用文档：${sources.join('、')}`;
  };
}
