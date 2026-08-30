import type { ToolDefinition } from './tool-registry.ts';
import type { EmbeddedChunk } from '../rag/index.ts';
import type { EmbeddingFn } from '../rag/embedder.ts';
import { hybridSearch } from '../rag/search.ts';

// ═══════════════════════════════════════════════════════════════════════════
// createRagSearchTool：把 RAG 检索暴露为一个工具、Agent 需要时主动调
// ═══════════════════════════════════════════════════════════════════════════
//
// v1 决策：
//   - **只做 rag_search、不做 rag_ingest**——写入靠启动时自动扫 docs/
//     Agent 只查、不改索引——职责清晰、避免"内存 chunks 跟磁盘不同步"的复杂度
//   - **chunks 传引用**——假设启动后不变。v2 做 rag_ingest 时改成 getAllChunks(): () => Chunk[]
//   - **参数是 chunks + embedFn**——跟 hybridSearch 的签名对齐、不引入 VectorStore 抽象层
//
// description 里明确"何时调、返回什么"——让 Agent 判断"这个问题该查文档吗"

export function createRagSearchTool(
  chunks: EmbeddedChunk[],
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

返回：top-K 相关文档片段、包含 source（文件路径）+ score（0-1 融合分）+ text 内容摘要`,
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
      if (chunks.length === 0) {
        return '知识库为空——启动时没索引到任何文档';
      }
      const k = Math.min(top_k ?? 5, 10);
      const results = await hybridSearch(chunks, embedder, query, k);
      if (results.length === 0) {
        return `没有找到跟 "${query}" 相关的文档片段`;
      }

      // 每条结果：来源 + 分数（融合/向量/关键词）+ 文本预览
      // 保留 500 字符预览——够 Agent 判断"这条相关吗、要不要 read 完整内容"
      return results.map((r, i) => {
        const preview = r.chunk.text.length > 500
          ? r.chunk.text.slice(0, 500) + '\n... [truncated]'
          : r.chunk.text;
        return [
          `[${i + 1}] ${r.chunk.source} · score=${r.score.toFixed(3)} (vec=${r.vectorScore.toFixed(2)} kw=${r.keywordScore.toFixed(2)})`,
          preview,
        ].join('\n');
      }).join('\n\n---\n\n');
    },
  };
}
