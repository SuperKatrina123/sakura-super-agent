# RAG 系统设计：从内存数组到 SQLite 三表

> 配套 [../README.md](../README.md) 的拓展阅读。前面几篇讲的是 Agent 在**单会话内**变强、**跨会话记忆**内化——这一篇讲 Agent 怎么**从外部文档获取知识**。为什么 grep 不够、六步 RAG 管线、混合检索的归一化和 MMR、以及从内存 JSON 演化到生产级 SQLite 三表架构的完整推理。

## 目录

- [0. 为什么需要 RAG](#0-为什么需要-rag)
- [1. 六步 RAG 管线](#1-六步-rag-管线)
- [2. 三层检索候选池：漏斗式缩窄](#2-三层检索候选池漏斗式缩窄)
- [3. 归一化 + MMR：让两种分数能加权、让 top-5 有多样性](#3-归一化--mmr让两种分数能加权让-top-5-有多样性)
- [4. 混合检索：向量 + BM25、7:3 加权融合](#4-混合检索向量--bm257-3-加权融合)
- [5. SQLite 三表架构：从内存到持久化](#5-sqlite-三表架构从内存到持久化)
- [6. Agentic RAG：Agent Loop 是 RAG 的决策者](#6-agentic-ragagent-loop-是-rag-的决策者)
- [7. 生产 gap 与已知的坑](#7-生产-gap-与已知的坑)

## 0. 为什么需要 RAG

前面 tool system 章节已经有 `grep` / `read_file` / `web_search` 等工具——**它们能拿到内容、为什么还要 RAG**？

**因为字面匹配 ≠ 语义匹配**。看几个真实例子：

- 用户问"**部署事故**"——项目文档里写的是"**上线出问题**"——`grep` **零命中**、RAG 能匹配（向量空间里两者距离很近）
- 用户问"**压缩机制怎么设计**"——文档里的关键词是"`microcompact` / `summarize`"——`grep` **只能字面命中"压缩"**、可能漏掉真正相关的技术细节段落
- 用户问"**MCP 集成流程**"——需要跨多个文件综合回答——`read_file` **一次只读一个**、Agent 得手动决定读哪些

**RAG 补的是"语义检索"这一层**。跟其他工具的分工：

| 工具 | 适合场景 |
|---|---|
| `grep` | 字面精确命中（函数名、变量名、error 消息） |
| `read_file` | 已知文件路径、要读完整内容 |
| `web_search` | 外部世界的实时信息 |
| **`rag_search`** | **跨多文档的语义检索、含义相近但字面不同** |

**这四个工具是互补的、不是替代**。Agent 判断"这个问题该用哪个"是 loop 的核心决策。

## 1. 六步 RAG 管线

从原始文档到 Agent 用上、一共六步：

```
1. 加载    读入 docs/**/*.md
2. 分块    切成语义完整的小段（~256 tokens）
3. 向量化  每段调 embedding API → number[]
4. 存储    chunks + 向量 → SQLite 三表
5. 检索    query → 向量搜 + 关键词搜 → 融合 → MMR
6. 注入    top-K 塞进 Agent 上下文
```

**这六步的分工在项目里的落点**：

| 步骤 | 文件 | 关键设计 |
|---|---|---|
| 1. 加载 | [`build-sqlite.ts`](../src/rag/build-sqlite.ts) `walkMarkdown()` | 只做 `.md`、递归子目录 |
| 2. 分块 | [`chunker.ts`](../src/rag/chunker.ts) `chunkDocument()` | 递归段落分块（不是"语义分块"） |
| 3. 向量化 | [`embedder.ts`](../src/rag/embedder.ts) `embed()` | Provider 可插拔（Mock / DashScope） |
| 4. 存储 | [`sqlite-store.ts`](../src/rag/sqlite-store.ts) `add()` | SQLite 三表联动写入 |
| 5. 检索 | [`sqlite-store.ts`](../src/rag/sqlite-store.ts) `hybridSearch()` | 向量 + BM25 + 归一化 + MMR |
| 6. 注入 | [`rag-tools.ts`](../src/tools/rag-tools.ts) + [`prompt-pipes.ts`](../src/context/prompt-pipes.ts) | 工具 + 声明 pipe 双通道 |

### 1.1 分块策略：**递归段落**、不是"语义分块"

一个容易踩的坑：**"语义分块"（按 embedding 相似度切）听起来更聪明、但实测更差**。

- 递归段落分块（按空行→句号→硬切）：准确率 **69%**
- 语义分块（按 embedding 相似度）：准确率 **54%**

**原因**：语义分块的**误差会累积**——一个切分点判断错、后面的都跟着错。递归段落分块的边界是**结构性的**（段落/句子）、不会累积。

### 1.2 分块目标：~256 tokens（~1000 字符）

课程演示值——生产通常用 **512 tokens**。**为什么小**：

- **单个 chunk 里语义焦点集中**——向量能准确表达"这段讲什么"
- **top-K 能覆盖更多文档**——K=5 时能覆盖 5 个话题、不是 1 个话题的 5 段

**为什么不能太小**（< 100 tokens）：

- **单词/短语级别没有足够上下文**——embedding 表达不出完整意思
- **top-K 结果碎片化**——Agent 拼不出连贯回答

### 1.3 三层递归策略

看 [`chunker.ts`](../src/rag/chunker.ts) 的 `chunkDocument`：

```
Layer 1: 按空行分段落
Layer 2: 段落太长 → 按句子边界（。！？.!?\n）切
Layer 3: 单句还超上限 → 按字符硬切（兜底，极少走到）
```

**大部分文档都停在 Layer 1**——空行是天然的语义边界。**Layer 2/3 是防御性设计**、保证任何输入都能被切成合规大小。

## 2. 三层检索候选池：漏斗式缩窄

一个非显然的实现：**检索是分三层的漏斗、不是一步到位**。

```
全部 chunks（178）
  ↓
向量 top-20 + BM25 top-20        ← 各路径独立、宽召回
  ↓
union 合并、加权融合、归一化      ← 融合后取 top-10
  ↓
MMR 去重                          ← 兼顾相关性和多样性
  ↓
返回 topK=5                       ← Agent 消费
```

**每层缩窄的意义**：

**Layer 1（180 → 20+20）**：**宽召回**——两条路径各取 topK × 4 候选。**为什么 ×4**：如果直接各取 5、两路完全不重叠时融合池只有 10 条——**MMR 没有操作空间**。取 ×4 让"融合和多样性调整"有余量。

**Layer 2（合并 → 10）**：**融合**——归一化两路分数、加权。得到"综合最相关"的 top-10。

**Layer 3（10 → 5）**：**MMR**——从 top-10 里选出既相关又多样的 top-5、避免"top-5 全是同一节的相邻段落"。

**这个漏斗结构跟前面的分层压缩 / 分层防线一脉相承**——**"便宜的方法先做宽召回、贵的方法在小池里精选"**。

## 3. 归一化 + MMR：让两种分数能加权、让 top-5 有多样性

### 3.1 归一化：BM25 分数和 cosine 相似度不是同一尺度

- **cosine similarity**：`[-1, 1]`——归一化后是 `[0, 1]`
- **BM25 rank**：绝对值、可能 `0.5` 到 `30+`——取决于文档长度、语料库统计

**直接加权 = 错**——BM25 分数会碾压 cosine。**必须先归一化到同尺度**。

**min-max 归一化**（[`search.ts`](../src/rag/search.ts) 里）：

```ts
function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map(s => (s - min) / range);
}
```

**每条路径独立归一化**——top1 → 1.0、bottom → 0.0。**相对差异保留、绝对尺度对齐**、加权就干净了。

**为什么用 min-max 不用 z-score**：
- min-max 保证结果 `[0, 1]`、直觉最强
- z-score 可能出负数、加权时符号问题
- top1 恒为 1.0——**融合分的上界稳定**

### 3.2 MMR：解决"top-5 都是同一话题"

**没有 MMR 时的典型失败**：

假设查"上下文压缩怎么做"、top-5 可能是：

```
1. context-compression.md §2.1 (0.95)
2. context-compression.md §2.2 (0.92)
3. context-compression.md §2.3 (0.90)
4. context-compression.md §3.1 (0.88)
5. context-compression.md §3.2 (0.87)
```

**全是同一篇的相邻章节**——模型看完还是不知道压缩系统的全景。

**MMR 的核心思路**：**每次选下一个结果时、既看相关性、也看跟已选的差异度**。

```
MMR = λ × relevance - (1 - λ) × maxSimilarity_with_selected
```

- **λ = 0.7**：70% 看相关性、30% 看多样性（业界推荐值）
- **maxSimilarity_with_selected**：跟已选结果里"最像的那一个"算相似度——最保守估计

**有 MMR 之后的输出**：

```
1. context-compression.md §2.1 (0.95)     ← 相关性最高、直接入选
2. instant-defenses.md §0 (0.85)          ← 相关但换个视角
3. context-compression.md §5 (0.83)       ← 同一篇但换个话题
4. cost-visualization.md §6 (0.80)        ← 相关文档
5. tool-search-design.md §5 (0.75)        ← 更远的视角
```

**每条都相关、彼此差异大**——模型能拼出全景图。

### 3.3 Jaccard 而不是 cosine：多样性度量的选择

MMR 的相似度用 **Jaccard**（词集交/并）、不是再算一次 embedding cosine。

**为什么**：

- **零额外 API 成本**——不用再调 embedding
- **多样性度量不需要那么精确**——"两段字面重合度高"就是"多样性低"、Jaccard 已经够用
- **计算便宜**——一次 tokenize + Set 交并

## 4. 混合检索：向量 + BM25、7:3 加权融合

### 4.1 为什么要"向量 + BM25 混合"

**向量搜索的强项**：语义相似（"部署事故" ↔ "上线出问题"）
**向量搜索的弱项**：**专有名词/代码符号**——`microcompact` 这类词、embedding 不认识、算出来两个都不相关的 chunk 也可能距离很近

**BM25 的强项**：**字面精确命中**——`microcompact` 出现在哪个 chunk 里、BM25 一算就对
**BM25 的弱项**:**换个说法就废**——"压缩" ≠ "compact"、"部署" ≠ "上线"

**两者互补**——混合检索是让 RAG 稳定的关键。

### 4.2 为什么 7:3 而不是 5:5 或纯向量

**OpenClaw 的经验值：70% 向量 + 30% 关键词**。我们对齐。

**7:3 的直觉**：

- 大部分时候**语义相似度更能反映"用户真正想问什么"**——所以向量权重高
- 但**专有名词/代码符号**是"绝对不能漏的信号"——所以 BM25 有 30% 保底
- **纯向量（10:0）** 会漏掉"用户输入了一个精确名字"的场景（比如 `mcp__github__list_issues`）——BM25 30% 保护这个 case

### 4.3 Union 合并（不是 intersection）

**intersection**：两路都命中才保留——精度高、召回率低
**union**：任一路命中就保留、缺失路径分数记 0——**平衡**

**推荐 union**：如果一条 chunk 只在向量路径命中（同义词、字面不同）、也应该出现在结果里、只是分数会低一些。**打分自然反映"两路都命中的更高、只一路命中的次之"**。

看 [`sqlite-store.ts`](../src/rag/sqlite-store.ts) 的 hybridSearch：

```ts
// 路径 1 结果先塞进 candidates
for (const r of vectorResults) {
  candidates.set(r.chunk.id, {
    chunk: r.chunk,
    score: vecScore * 0.7,
    vectorScore: vecScore,
    keywordScore: 0,   // 缺失路径分数 = 0
  });
}
// 路径 2 结果：已存在的加分、不存在的新建
for (const r of keywordResults) {
  const existing = candidates.get(r.chunk.id);
  if (existing) {
    existing.keywordScore = kwScore;
    existing.score += kwScore * 0.3;   // 两路都命中——加权累加
  } else {
    candidates.set(r.chunk.id, { chunk: r.chunk, score: kwScore * 0.3, ... });
  }
}
```

## 5. SQLite 三表架构：从内存到持久化

内存数组能跑、但**进程一退出、知识库就没了**——每次启动都要重新分块、重新调 embedding API。文档少无所谓、多了就不行。

**生产方案：SQLite + sqlite-vec + FTS5 三表架构**（OpenClaw 也是这个）。

### 5.1 三张表各管什么

想象你有 1 万个 chunks、每个 chunk 有三样东西：原文、embedding、元数据。**直觉做法是一张表全存了**。但检索时会遇到两个问题：

**问题 1：向量搜索慢**——1 万个 128 维向量、逐条算 cosine 是 O(n)。**需要专门的向量索引结构**（HNSW 之类）。

**问题 2:关键词搜索慢**——用 `LIKE '%部署%'` 全表扫描是 O(n × len)。**需要倒排索引**。

**SQLite 本身的 B-Tree 索引处理不了这两种查询**——所以要用**虚表**：

```sql
-- 主表：存"事实"
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding TEXT NOT NULL,      -- JSON 序列化的向量、备份用
  updated_at INTEGER NOT NULL
);

-- 向量虚表：sqlite-vec 提供、支持 MATCH 语法的最近邻查询
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[128]           -- 128 维、Float32
);

-- 全文虚表：FTS5 提供、内置 BM25 打分
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, id UNINDEXED, source UNINDEXED
);
```

**三表共享同一个 `id`**——查询时按 id JOIN 拿完整数据。

### 5.2 三表联动写入

看 [`sqlite-store.ts`](../src/rag/sqlite-store.ts) 的 `add()`：

```ts
add(chunk: Chunk, embedding: number[]): void {
  // 1. 主表
  this.db.prepare(`INSERT OR REPLACE INTO chunks (...) VALUES (...)`)
    .run(chunk.id, chunk.text, chunk.source, chunk.index, JSON.stringify(embedding), now);

  // 2. 向量索引（Float32Array → Buffer）
  this.db.prepare(`INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)`)
    .run(chunk.id, Buffer.from(new Float32Array(embedding).buffer));

  // 3. 全文索引
  this.db.prepare(`INSERT OR REPLACE INTO chunks_fts (id, text, source) VALUES (?, ?, ?)`)
    .run(chunk.id, chunk.text, chunk.source);
}
```

**三张表都得写、三个 SQL**。这就是"分表的运维成本"——但**换来的是 O(log n) 检索、值得**。

### 5.3 事务批量写：10x+ 加速

看 `addBatch()`：

```ts
addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
  const tx = this.db.transaction(() => {
    for (const { chunk, embedding } of items) this.add(chunk, embedding);
  });
  tx();   // 事务批量提交
}
```

**为什么快 10x+**：SQLite 每次 `INSERT` 默认都在事务里、fsync 一次。178 条独立 INSERT = 178 次 fsync。用事务包住 = **一次 fsync**。**磁盘 IO 是数量级差异**。

### 5.4 增量索引：按 id 判断"已 embed 过"

看 [`build-sqlite.ts`](../src/rag/build-sqlite.ts)：

```ts
const missing = allChunks.filter(c => !store.has(c.id));
if (missing.length > 0) {
  const vectors = await embed(embedder, missing.map(c => c.text));
  store.addBatch(missing.map((c, i) => ({ chunk: c, embedding: vectors[i] })));
}
```

**关键**：`chunk.id = source + index`——**内容变了、切片位置变、id 变、按 id 判断"已存在"就跳过**。

**实测**：
- **第一次启动**：`已有 0、新增 178`——全量 embed
- **第二次启动**：`已有 178、新增 0`——**秒开、跳过 embed**

**这就是从 JSON → SQLite 换来的最大好处**：知识库跨进程持久。

### 5.5 中文分词：FTS5 用 unicode61

FTS5 默认 tokenizer 是英文空格分词——**对中文不友好**（"上下文压缩" 会被当成一个词、grep 时反而搜不到"压缩"）。

我们**没有显式设置 tokenizer**——用的是 FTS5 默认。**已知损失**：中文 BM25 精度不够。生产该加 `tokenize='unicode61'`（内置、把中文按 unicode 切）或 jieba tokenizer（更精、需要扩展编译）。

## 6. Agentic RAG：Agent Loop 是 RAG 的决策者

**传统 RAG**：用户提问 → 搜一次 → 注入结果 → 生成回答。**一次性、无法迭代**。

**Agentic RAG**：**Agent 自己决定搜什么、搜几次、怎么组合**。

一个具体例子：**"对比 API 设计规范和部署指南中关于错误处理的差异"**——

- **传统 RAG**：整个问题作为一个 query 去搜、可能两个方面都搜不到
- **Agentic RAG**：Agent 先搜"API 错误处理"、再搜"部署 错误处理"、把两次结果放一起分析

**这不需要改 RAG 管线的代码**——**Agent Loop 本身就支持多步工具调用**。Agent 调一次 `rag_search`、看到结果不够、再调一次换个关键词。

**核心洞察**：**RAG 管线是工具、Agent Loop 是使用工具的决策者**。工具设计得好、Agent 自然会用。

### 6.1 实测：Agent 会自己决定读全文

一次真实的 vercel/ai 会话里、Agent 的行为链路：

```
Step 1: rag_search("上下文压缩")            → 拿到 top-5 chunks
Step 2: 根据 chunks 判断"文档 context-compression.md 值得读全文"
Step 3-4: read_file("docs/context-compression.md")    → 补充完整内容
Step 5-6: 交叉引用其他 chunks                  → 综合回答
```

**Agent 把 rag_search 当"发现工具"、把 read_file 当"精读工具"**——**不用我们在 prompt 里教、它自己判断**。这是 tool 设计的正确姿态：**description 说清"何时用、返回什么"、剩下交给 Agent**。

## 7. 生产 gap 与已知的坑

**1. Mock embedder 只做词频、不做真语义**

当前默认 mock——把每个词映射到 3 个稳定维度、加权累加。**同义词不会近**（"部署" vs "上线"）——**语义相似度检索退化成"关键词分布相似度"**。

**生产必做**：接 DashScope / OpenAI / Voyage 的真 embedding。项目已经写了 `createDashScopeEmbedder`——**加环境变量 `DASHSCOPE_API_KEY` 就自动切**。

**2. Embedding 维度硬编码 128**

真实 embedding API 通常是 1024 / 1536 维——**跟当前 SQLite schema `FLOAT[128]` 不兼容**。切真 embedding 时要**改建表 SQL、重建索引**。可以做成配置项、留作后续。

**3. 中文 FTS5 精度不够**

默认 tokenizer 对中文不友好。修法：`CREATE VIRTUAL TABLE ... USING fts5(text, tokenize='unicode61')`——单字切分、跟 embedder 保持一致。

**4. sqlite-vec 的最近邻是暴力扫描**

sqlite-vec 目前**没有 HNSW 索引**——是逐条算距离的 O(n)。178 chunks 毫秒级、但 100 万 chunks 就慢了。生产大规模用 Chroma / Qdrant / LanceDB 更合适。

**5. 索引不 watch 文件变化**

`buildSqliteIndex` 只在启动时跑一次。如果启动后 docs/ 里加了新文件、Agent 查不到——**要手动重启**。修法：`fs.watch(docsDir)` 监听变化、增量更新。

**6. 没有 chunk 级别的元数据检索**

比如"只搜 `docs/session-persistence.md` 里的内容"——当前只能全库搜。修法：在 chunks 表加 filter 条件、`WHERE source = ?`。

**7. `updated_at` 字段没用起来**

写入时记录了、但从没查过。生产可以用它做：
- **文件 mtime vs chunk updated_at**——判断文件改了、这些 chunk 要重建
- **老 chunks 优先清理**——LRU / TTL 淘汰

**8. Rag_ingest 工具没做**

只做了 `rag_search`——Agent 不能主动"把这个 PDF 加进知识库"。想做的话：`rag_ingest(path)` 工具、调 chunker + embedder + store.addBatch。**但要处理**"内存 chunks 跟 SQLite 不同步"的复杂度——留作 v2。

---

## 相关文档

- [tool-search-design.md](tool-search-design.md) — RAG 的元索引跟 ToolSearch 的 defer 目录同 pattern：**索引常驻、内容按需读**
- [memory-system-design.md](memory-system-design.md) — Memory 用简单 keyword search、RAG 用向量 + BM25——**同一个"检索"问题、不同规模、不同方案**
- [context-compression.md](context-compression.md) — RAG 读回来的大段文本会触发 microcompact——**长 read_file 结果的自动压缩**
- [prompt-pipe-design.md](prompt-pipe-design.md) — `ragContext` segment 声明"知识库有哪些文档"、跟 `memoryContext` 分工一致
- [cost-visualization.md](cost-visualization.md) — RAG 增大 SYSTEM tools schema、但结构稳定——**对 cache 命中率是加分项**
