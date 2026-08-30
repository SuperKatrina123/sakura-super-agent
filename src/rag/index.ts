import fs from 'node:fs';
import path from 'node:path';
import { chunkDocument, type Chunk } from './chunker.ts';
import { embed, createMockEmbedder, createDashScopeEmbedder, type EmbeddingFn } from './embedder.ts';

// ═══════════════════════════════════════════════════════════════════════════
// RAG Indexer：扫描 docs → chunk → embed → 缓存到磁盘
// ═══════════════════════════════════════════════════════════════════════════
//
// 三步串起来的 orchestrator：
//   1. 扫 docs/ 下所有 .md 文件
//   2. 用 chunkDocument 切分
//   3. 用 embed 向量化（Mock 或 DashScope）+ 存磁盘
//
// 磁盘缓存：.rag/index.json
//   - 启动时读入内存做检索
//   - 版本 + provider 变化时自动作废（防止旧 embedding 跟新 model 不兼容）

const RAG_DIR = '.rag';
const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;

// EmbeddedChunk = chunk + 它的 embedding
export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

interface IndexFile {
  version: number;
  provider: string;      // 'mock' / 'dashscope' 等——不同 provider 的 embedding 不兼容
  dimensions: number;
  chunks: EmbeddedChunk[];
}

// ── 磁盘缓存：load / save ────────────────────────────────────────────────

export function loadIndex(baseDir: string = '.'): { chunks: EmbeddedChunk[]; provider: string } | null {
  const indexPath = path.join(baseDir, RAG_DIR, INDEX_FILE);
  if (!fs.existsSync(indexPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as IndexFile;
    if (data.version !== INDEX_VERSION) {
      console.warn(`[RAG] 索引版本 ${data.version} 跟当前 ${INDEX_VERSION} 不匹配——将重建`);
      return null;
    }
    return { chunks: data.chunks, provider: data.provider };
  } catch (err) {
    console.warn(`[RAG] 索引解析失败——将重建：${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// 原子写入：先写 .tmp、再 rename——避免中途崩溃损坏文件
function saveIndex(chunks: EmbeddedChunk[], provider: string, baseDir: string = '.'): void {
  const dir = path.join(baseDir, RAG_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const data: IndexFile = {
    version: INDEX_VERSION,
    provider,
    dimensions: chunks[0]?.embedding.length ?? 0,
    chunks,
  };

  const finalPath = path.join(dir, INDEX_FILE);
  const tmpPath = finalPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, finalPath);
}

// ── 扫描 docs 目录 ──────────────────────────────────────────────────────

function walkMarkdown(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

// ── 主入口：扫 docs → chunk → embed → 缓存 ──────────────────────────────

export interface BuildIndexOptions {
  docsDir?: string;       // 默认 "docs"
  baseDir?: string;       // 默认 "."——磁盘缓存的根
  provider?: 'mock' | 'dashscope';
  apiKey?: string;        // dashscope 时必填
}

// 选 embedding provider——mock 无需 key、dashscope 需要 DASHSCOPE_API_KEY
function chooseEmbedder(opts: BuildIndexOptions): { fn: EmbeddingFn; name: string } {
  const provider = opts.provider ?? 'mock';
  if (provider === 'dashscope') {
    const key = opts.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!key) {
      console.warn('[RAG] 未配置 DASHSCOPE_API_KEY——降级到 mock embedder');
      return { fn: createMockEmbedder(), name: 'mock' };
    }
    return { fn: createDashScopeEmbedder(key), name: 'dashscope' };
  }
  return { fn: createMockEmbedder(), name: 'mock' };
}

// buildIndex：全量或增量索引
// 语义：
//   - 无缓存 → 全量扫 + embed 所有 chunk
//   - 有缓存 + provider 匹配 → 增量（按 chunk.id 判断"已 embed 过跳过"）
//   - 有缓存但 provider 变了 → 全量重建（旧 embedding 不兼容）
export async function buildIndex(opts: BuildIndexOptions = {}): Promise<EmbeddedChunk[]> {
  const docsDir = opts.docsDir ?? 'docs';
  const baseDir = opts.baseDir ?? '.';
  const { fn: embedder, name: provider } = chooseEmbedder(opts);

  // 1. 扫所有 markdown
  const files = walkMarkdown(docsDir);
  if (files.length === 0) {
    console.log(`[RAG] ${docsDir}/ 下没有 .md 文件`);
    return [];
  }

  // 2. Chunk：每个文件切一批
  const allChunks: Chunk[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8');
    // source 用相对路径——便于跨机器移植（绝对路径每台机不一样）
    const source = path.relative(baseDir, file);
    allChunks.push(...chunkDocument(source, raw));
  }
  console.log(`[RAG] 扫描 ${files.length} 个文件、切出 ${allChunks.length} 个 chunk`);

  // 3. Embed：按缓存增量、provider 变了就作废
  const cached = loadIndex(baseDir);
  const cacheMap = new Map<string, number[]>();
  if (cached && cached.provider === provider) {
    for (const c of cached.chunks) cacheMap.set(c.id, c.embedding);
  } else if (cached && cached.provider !== provider) {
    console.warn(`[RAG] provider 从 "${cached.provider}" 变成 "${provider}"——旧 embedding 作废、全量重建`);
  }

  // 分组：命中的 vs 未命中的
  const hits: EmbeddedChunk[] = [];
  const misses: Chunk[] = [];
  for (const chunk of allChunks) {
    const cached = cacheMap.get(chunk.id);
    if (cached) hits.push({ ...chunk, embedding: cached });
    else misses.push(chunk);
  }

  // 批量 embed 未命中的
  let missResults: EmbeddedChunk[] = [];
  if (misses.length > 0) {
    const vectors = await embed(embedder, misses.map(c => c.text));
    missResults = misses.map((c, i) => ({ ...c, embedding: vectors[i] }));
  }

  // 合并 + 按原始 chunks 顺序还原
  const merged = new Map<string, EmbeddedChunk>();
  for (const c of [...hits, ...missResults]) merged.set(c.id, c);
  const result = allChunks.map(c => merged.get(c.id)!).filter(Boolean);

  // 4. 存磁盘
  saveIndex(result, provider, baseDir);
  console.log(`[RAG] 索引完成：${result.length} chunks（缓存命中 ${hits.length}、新增 ${misses.length}）· provider=${provider}`);

  return result;
}
