import fs from 'node:fs';
import path from 'node:path';
import { chunkDocument } from './chunker.ts';
import { embed, createMockEmbedder, createDashScopeEmbedder, type EmbeddingFn } from './embedder.ts';
import { SqliteVectorStore } from './sqlite-store.ts';

// ═══════════════════════════════════════════════════════════════════════════
// build-sqlite.ts：扫 docs → chunk → embed → 灌 SQLite
// ═══════════════════════════════════════════════════════════════════════════
//
// 跟 rag/index.ts（JSON 版）的区别：
//   - 存储：SQLite 三表（chunks / chunks_vec / chunks_fts）替代 index.json
//   - 增量判断：`store.has(id)` 替代 in-memory Map
//   - 返回值：SqliteVectorStore 实例（caller 用它做检索）
//
// 教学对比：**读者能看到"内存 JSON vs SQLite 三表"的两种实现**——同一份 chunker + embedder、
// 只换存储层。这个对比比"直接换掉"更有教学价值

const RAG_DIR = '.rag';
const DB_FILE = 'knowledge.db';

export interface BuildSqliteOptions {
  docsDir?: string;
  baseDir?: string;
  provider?: 'mock' | 'dashscope';
  apiKey?: string;
}

function chooseEmbedder(opts: BuildSqliteOptions): { fn: EmbeddingFn; name: string } {
  const provider = opts.provider ?? 'mock';
  if (provider === 'dashscope') {
    const key = opts.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!key) {
      console.warn('[RAG-SQLite] 未配置 DASHSCOPE_API_KEY——降级到 mock embedder');
      return { fn: createMockEmbedder(), name: 'mock' };
    }
    return { fn: createDashScopeEmbedder(key), name: 'dashscope' };
  }
  return { fn: createMockEmbedder(), name: 'mock' };
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// buildSqliteIndex：扫 docs、chunk、embed、灌 SQLite——返回 store 实例
// 增量：按 chunk.id 判断"数据库里有没有、有就跳过"
// 第一次全量、之后启动秒开（缓存命中率 100%）
export async function buildSqliteIndex(opts: BuildSqliteOptions = {}): Promise<SqliteVectorStore> {
  const docsDir = opts.docsDir ?? 'docs';
  const baseDir = opts.baseDir ?? '.';

  // 确保 .rag/ 目录存在
  const ragDir = path.join(baseDir, RAG_DIR);
  if (!fs.existsSync(ragDir)) fs.mkdirSync(ragDir, { recursive: true });

  const dbPath = path.join(ragDir, DB_FILE);
  const store = new SqliteVectorStore(dbPath);
  const { fn: embedder, name: provider } = chooseEmbedder(opts);

  // 扫描 markdown
  const files = walkMarkdown(docsDir);
  if (files.length === 0) {
    console.log(`[RAG-SQLite] ${docsDir}/ 下没有 .md 文件`);
    return store;
  }

  // Chunk 全部文件
  const allChunks: Array<ReturnType<typeof chunkDocument>[number]> = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8');
    const source = path.relative(baseDir, file);
    allChunks.push(...chunkDocument(source, raw));
  }
  console.log(`[RAG-SQLite] 扫描 ${files.length} 个文件、切出 ${allChunks.length} 个 chunk`);

  // 增量：按 id 过滤未 embed 的
  const missing = allChunks.filter(c => !store.has(c.id));
  const hits = allChunks.length - missing.length;

  if (missing.length > 0) {
    // 批量 embed——DashScope 支持一次多条、比逐条快
    const vectors = await embed(embedder, missing.map(c => c.text));
    // 灌进 SQLite（事务批量写、比逐条快 10x+）
    store.addBatch(missing.map((c, i) => ({ chunk: c, embedding: vectors[i] })));
  }

  console.log(`[RAG-SQLite] 索引完成：${allChunks.length} chunks（已有 ${hits}、新增 ${missing.length}）· provider=${provider} · db=${dbPath}`);
  return store;
}
