import type { ToolDefinition, ToolRegistry } from '../tool-registry.ts';

// tool_search: 元工具——不做业务操作，只根据工具名激活延迟工具
//
// 工作机制：
//   1. system prompt 里挂了一份 defer 工具目录（getDeferredToolSummary）
//   2. 模型判断需要某个 defer 工具时，直接传它的**精确名字**过来
//   3. registry.searchTools() 精确匹配 → 加入 discoveredTools
//   4. 下一轮 loop 里，该工具进入 toAISDKFormat → 模型可以直接调用
//
// 为什么不做模糊/BM25 检索：名字已经全告诉模型了，模型选好名字才调 tool_search
// —— 精确匹配零依赖、零误召回、行为可预测
//
// 隐式激活（vs 两步式 search + load）：
//   一步搞定，避免每次多一轮 round-trip
//   `isReadOnly: true` 是善意的谎言——有内部状态变更（discoveredTools），但不改外部
//
// 工厂函数：闭包 registry，避免 registry 直接依赖工具定义、造成循环依赖
export function createToolSearchTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: 'tool_search',
    description: '获取延迟工具的完整定义。传入工具名（从 system prompt 的延迟工具列表中选取），返回该工具的完整参数 schema。支持逗号分隔一次查多个',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '工具名，如 "mcp__github__list_issues"。多个工具用逗号分隔："a, b, c"',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,   // 严格说改了 discoveredTools，但对外部世界只读——语义上归为安全操作
    execute: async ({ query }: { query: string }) => {
      const results = registry.searchTools(query);
      if (results.length === 0) {
        return `没有找到匹配 "${query}" 的工具。请从 system prompt 的延迟工具列表里选一个精确名字，多个用逗号分隔`;
      }
      // 返回完整 schema——模型据此构造下一轮的 tool_call
      return JSON.stringify(
        results.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        null,
        2,
      );
    },
  };
}
