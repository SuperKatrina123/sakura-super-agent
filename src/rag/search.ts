import { embed, cosineSimilarity, type EmbeddingFn } from './embedder.ts';
import type { EmbeddedChunk } from './index.ts';

// ═══════════════════════════════════════════════════════════════════════════
// Hybrid Search：向量 + 关键词加权融合
// ═══════════════════════════════════════════════════════════════════════════
//
// 策略：7:3 加权融合（参考 OpenClaw）
//   - 70% 向量相似度——处理语义相近（"部署事故" ↔ "上线出问题"）
//   - 30% BM25 关键词——处理精确命中（专有名词、代码符号名）
//
// 为什么不用 RRF：
//   加权融合更直觉、教学友好——把两条路径的贡献可视化
//   RRF 对分数尺度不敏感、但也丢失了相对差异信息
//
// 关键预处理：min-max 归一化到 [0, 1]
//   BM25 分数天然不是 [0, 1]、必须归一化才能跟 cosine 加权
//   两条路径各自 min-max、然后按 0.7 * vec + 0.3 * kw 融合
//
// 候选池策略：CANDIDATE_MULTIPLIER = 4
//   最终要返回 topK 条、但从两条路径各取 topK × 4 条候选
//   给融合留操作空间——直接各取 topK 时两路完全不重叠可能错过真正相关的 chunk

const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const CANDIDATE_MULTIPLIER = 4;

// BM25 参数——业界默认值
const BM25_K1 = 1.5;   // 词频饱和度
const BM25_B = 0.75;   // 长度归一化

export interface SearchResult {
  chunk: EmbeddedChunk;
  score: number;         // 最终融合分（0-1）
  vectorScore: number;   // 归一化后的向量分（0-1）
  keywordScore: number;  // 归一化后的 BM25 分（0-1）
}

// ── 主入口 ────────────────────────────────────────────────────────────────

export async function hybridSearch(
  chunks: EmbeddedChunk[],
  embedFn: EmbeddingFn,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  if (chunks.length === 0) return [];

  const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, chunks.length);

  // 路径 1: 向量搜索——query 也 embed、跟所有 chunk 算 cosine
  const [queryVec] = await embed(embedFn, [query]);
  const vectorRanked = chunks
    .map(chunk => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount);

  // 路径 2: BM25——query 分词、对每个 chunk 算 BM25 分
  const queryTerms = tokenize(query);
  const corpus = chunks.map(c => c.text);
  const bm25Stats = precomputeBM25Stats(corpus);
  const keywordRanked = chunks
    .map(chunk => ({
      chunk,
      score: bm25Score(queryTerms, chunk.text, bm25Stats),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount);

  // 归一化两路分数到 [0, 1]——加权前必须同尺度
  // normalizeMinMax 是纯函数：接收分数数组、返回归一化分数数组
  // 归一化和"建 Map 用于按 id 合并"分开两步——单一职责、易测
  const vecScores = normalizeMinMax(vectorRanked.map(r => r.score));
  const kwScores = normalizeMinMax(keywordRanked.map(r => r.score));

  // 按 chunk.id 建索引、便于合并
  const vecById = new Map<string, { chunk: EmbeddedChunk; score: number }>();
  vectorRanked.forEach((r, i) => vecById.set(r.chunk.id, { chunk: r.chunk, score: vecScores[i] }));
  const kwById = new Map<string, { chunk: EmbeddedChunk; score: number }>();
  keywordRanked.forEach((r, i) => kwById.set(r.chunk.id, { chunk: r.chunk, score: kwScores[i] }));

  // 合并：union——任一路命中就保留、缺失路径分数记 0
  const allIds = new Set<string>([...vecById.keys(), ...kwById.keys()]);
  const merged: SearchResult[] = [];
  for (const id of allIds) {
    const v = vecById.get(id);
    const k = kwById.get(id);
    const chunk = v?.chunk ?? k!.chunk;
    const vs = v?.score ?? 0;
    const ks = k?.score ?? 0;
    merged.push({
      chunk,
      vectorScore: vs,
      keywordScore: ks,
      score: VECTOR_WEIGHT * vs + KEYWORD_WEIGHT * ks,
    });
  }

  // 最终排序：先按融合分排序、然后走 MMR 去重
  // 给 MMR 留 topK × 2 候选——它需要"更多选择"才能兼顾相关性和多样性
  const ranked = merged.sort((a, b) => b.score - a.score).slice(0, topK * 2);
  return mmrSelect(ranked, topK);
}

// ── 归一化 ────────────────────────────────────────────────────────────────
// min-max 到 [0, 1]——每条路径独立跑一次
// 空数组返回空、全部相同分数返回全 0（|| 1 兜底 range = 0 的除零）
// 纯函数——可以脱离 hybridSearch 单测
function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map(s => (s - min) / range);
}

// ── BM25 ─────────────────────────────────────────────────────────────────
// 公式：score(q, d) = Σ IDF(qi) × (f(qi, d) × (k1 + 1)) / (f(qi, d) + k1 × (1 - b + b × |d| / avgdl))
// - IDF(qi) = log((N - df(qi) + 0.5) / (df(qi) + 0.5) + 1)
// - f(qi, d) = qi 在文档 d 中的出现次数
// - |d| = 文档 d 的 token 数、avgdl = 语料库平均 token 数

interface BM25Stats {
  docFreq: Map<string, number>;   // token → 出现在多少文档
  docLengths: number[];            // 每个文档的 token 数
  avgDocLength: number;
  totalDocs: number;
}

function precomputeBM25Stats(corpus: string[]): BM25Stats {
  const docFreq = new Map<string, number>();
  const docLengths: number[] = [];
  let totalLength = 0;

  for (const doc of corpus) {
    const tokens = tokenize(doc);
    docLengths.push(tokens.length);
    totalLength += tokens.length;
    const uniqueTokens = new Set(tokens);
    for (const t of uniqueTokens) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
  }

  return {
    docFreq,
    docLengths,
    avgDocLength: totalLength / Math.max(1, corpus.length),
    totalDocs: corpus.length,
  };
}

// 用 tokenize 结果 + 预计算的 stats 算单个文档的 BM25 分
// query 和文档都要用同一个 tokenize——保证词形一致
function bm25Score(queryTerms: string[], docText: string, stats: BM25Stats): number {
  const docTokens = tokenize(docText);
  const docLength = docTokens.length;
  if (docLength === 0 || queryTerms.length === 0) return 0;

  // 文档内词频
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const qt of queryTerms) {
    const f = tf.get(qt) ?? 0;
    if (f === 0) continue;
    const df = stats.docFreq.get(qt) ?? 0;
    const idf = Math.log((stats.totalDocs - df + 0.5) / (df + 0.5) + 1);
    const norm = 1 - BM25_B + BM25_B * (docLength / stats.avgDocLength);
    score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * norm);
  }
  return score;
}

// ── Tokenize：中英混合 ────────────────────────────────────────────────────
// 跟 embedder 的 extractTokens 保持一致——保证词形对齐
// 中文按单字（\p{Script=Han}）、英文按小写单词（长度 >= 2）
// 已知损失：中文单字精度不如 jieba 分词、教学项目可接受
export function tokenize(text: string): string[] {
  const cjk = text.match(/\p{Script=Han}/gu) ?? [];
  const words = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(w => w.length >= 2);
  return [...cjk, ...words];
}

// ═══════════════════════════════════════════════════════════════════════════
// MMR (Maximal Marginal Relevance)：兼顾相关性和多样性
// ═══════════════════════════════════════════════════════════════════════════
//
// 混合检索之后 top-K 可能都来自同一话题的相邻段落——**内容高度重复**
// MMR 每次选下一个结果时同时考虑：
//   - 相关性（跟 query 的匹配度、就是 hybrid score）
//   - 多样性（跟已选结果的差异度）
//
// 公式：MMR = λ × relevance - (1 - λ) × maxSimilarity_with_selected
//   λ 越大越看重相关性、越小越看重多样性
//   0.7 是业界推荐值：不牺牲太多相关性、避免明显重复
//
// 相似度用 Jaccard（词集交/并）——零额外 API 成本
// 不用再跑一次 embedding cosine——**多样性度量不需要那么精确**

const MMR_LAMBDA = 0.7;

export function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
  if (results.length === 0) return [];
  if (results.length <= topK) return results;

  const selected: SearchResult[] = [results[0]];   // 第一名直接入选——它是分数最高的
  const remaining = results.slice(1);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      // 跟已选结果里"最像的那一个"算相似度——最保守估计
      const maxSim = Math.max(
        ...selected.map(s => jaccardSimilarity(s.chunk.text, remaining[i].chunk.text)),
      );
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

// Jaccard similarity = 交集大小 / 并集大小
// 用 tokenize 得到词集——跟 BM25 用同一个 tokenizer、保证行为一致
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
