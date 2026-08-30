import type { ToolDefinition } from './tool-registry.ts';
import type { EmbeddingFn } from '../rag/embedder.ts';
import type { SqliteVectorStore } from '../rag/sqlite-store.ts';

// ═══════════════════════════════════════════════════════════════════════════
// createRagSearchTool：把 SQLite 三表 RAG 检索暴露为一个工具
// ═══════════════════════════════════════════════════════════════════════════
//
// 参数从 EmbeddedChunk[] 升级为 SqliteVectorStore——获得两个能力：
//   1. **持久化**：进程重启后知识库还在、无需重新 embed
//   2. **快速检索**：sqlite-vec 用 HNSW 索引、FTS5 用倒排索引、比内存 O(n) 快很多
//
// description 里说明何时该调、返回什么

export function createRagSearchTool(
  store: SqliteVectorStore,
  embedder: EmbeddingFn,
): ToolDefinition {
  return {
    name: 'rag_search',
    description: `从项目的技术文档知识库里检索相关内容。

**何时用**：
  - 用户问"这个功能是怎么设计的"、"XX 机制是什么"这类关于项目本身的问题
  - 需要参考项目的历史决策、架构设计、踩过的坑
  - 需要引用文档里的具体表述（保持术语一致）

**不该用**：
  - 用户问"当前代码里 XX 函数在哪"——用 grep / read_file 更准
  - 用户问"最新的 issue 有哪些"——用 web_search 或 MCP 工具

返回：top-K 相关文档片段、包含 source（文件路径）+ score（0-1 融合分）+ text 内容`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词或完整问题——支持自然语言（"上下文压缩怎么设计的"）',
        },
        top_k: {
          type: 'number',
          description: '返回结果数量、默认 5、最大 10',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query, top_k }: { query: string; top_k?: number }) => {
      if (store.size() === 0) {
        return '知识库为空——启动时没索引到任何文档';
      }
      const k = Math.min(top_k ?? 5, 10);
      // hybridSearch 内部做了：向量 top-K×4 + 关键词 top-K×4 → min-max 归一 → 加权融合 → MMR 去重
      const results = await store.hybridSearch(embedder, query, k);
      if (results.length === 0) {
        return `没有找到跟 "${query}" 相关的文档片段`;
      }

      return results.map((r, i) => {
        // 完整返回 chunk 内容——chunk 已经是"合适大小的语义单元"（~256 tokens）、无需截断
        return [
          `[${i + 1}] ${r.chunk.source} · score=${r.score.toFixed(3)} (vec=${r.vectorScore.toFixed(2)} kw=${r.keywordScore.toFixed(2)})`,
          r.chunk.text,
        ].join('\n');
      }).join('\n\n---\n\n');
    },
  };
}
