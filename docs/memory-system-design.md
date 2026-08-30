# 跨会话记忆：从存什么到怎么注入

> 配套 [../README.md](../README.md) 的拓展阅读。前面几篇讲的是 Agent 在**单次会话**内怎么变强，这一篇讲 Agent 怎么**跨会话变懂你**——为什么"什么不该存"比"什么该存"更重要、四种记忆类型的语义、YAML frontmatter + 索引的存储结构、buildPromptSection 的注入策略、以及生产级方向的坦诚 gap。

## 目录

- [0. 为什么需要跨会话记忆](#0-为什么需要跨会话记忆)
- [1. 排除法：什么不该存](#1-排除法什么不该存)
- [2. 四种记忆类型的语义分工](#2-四种记忆类型的语义分工)
- [3. 存储结构：索引 + 分散 markdown](#3-存储结构索引--分散-markdown)
- [4. 两个硬性约束：MAX_INDEX_LINES + MAX_FILE_CHARS](#4-两个硬性约束max_index_lines--max_file_chars)
- [5. 注入 SYSTEM：buildPromptSection + memoryContext segment](#5-注入-systembuildpromptsection--memorycontext-segment)
- [6. "记忆是线索、不是事实"——过期提醒](#6-记忆是线索不是事实过期提醒)
- [7. 单一 `memory` 工具、六个 action](#7-单一-memory-工具六个-action)
- [8. 记忆会坏——四种坏 × 三层手段](#8-记忆会坏四种坏--三层手段)
- [9. Layer 2：lint 体检 + TTL 分级](#9-layer-2lint-体检--ttl-分级)
- [10. Layer 3：dream——prompt-driven 自主整理](#10-layer-3dreamprompt-driven-自主整理)
- [11. 生产级进阶：还没做的两件事](#11-生产级进阶还没做的两件事)
- [12. 已知的坑与后续方向](#12-已知的坑与后续方向)

## 0. 为什么需要跨会话记忆

前一篇 [session-persistence.md](session-persistence.md) 让对话历史能续——`--continue` 加载 messages、Agent 从上次的位置继续。**但这解决的是"记住上次说了什么"**、不解决**"跨多个会话记住这个用户是谁"**。

三个具体场景 session 无法覆盖：

**a. 用户偏好跨项目稳定**——"我喜欢简洁输出、不要长解释"、这条规则应该在**任何** session 里都生效。

**b. 纠正反馈应该长期遵守**——用户上周说过"测试不要 mock 数据库"、这周开新会话时 Agent 就"忘了"→ 再犯同样错误。

**c. 决策背景需要保留**——"选 JSONL 而不是 SQLite 是因为崩溃安全"、几个月后回看代码谁都不记得为什么、只能重新调研一次。

**核心目标**：把这些"跨会话有效"的信息存起来、每次启动都让 Agent 立刻知道。**Memory 是 Agent 的长期记忆、Session 是短期工作记忆**——两者不是同一层。

## 1. 排除法：什么不该存

**做记忆系统最容易犯的错是"什么都存"**——看起来信息越多越好、实际上，无差别存储是记忆系统最大的坑。

Mem0 2026 年的报告给了一个数据：**33% 的记忆事实在 90 天内变得不准确**。存的越多、过期的越多、Agent 基于错误信息做决策的概率越高。

**先定义什么不该存、剩下的才考虑存**：

### 1.1 能从代码推导的不存

- ❌ "项目用 TypeScript + AI SDK 5" —— grep `package.json` 就知道
- ❌ "compressor.ts 在 src/session/ 目录下" —— `ls` 一下就有
- ❌ "getDeferredTools() 返回 name+hint 数组" —— 看代码就懂

**代码改了、记忆还指着老路径、Agent 会基于错误信息做出自信的错误决策**——这是最难 debug 的失败模式。

### 1.2 能从 git 推导的不存

- ❌ "上次发布是 8 月 20 日" —— `git log` 是权威来源
- ❌ "谁改了 compressor.ts" —— `git blame` 有

**记忆里存的是快照、git 里的是实时数据**——快照永远追不上实时。

### 1.3 文档里已有的不存

- ❌ CLAUDE.md 里写过的规则
- ❌ README 里已经说清楚的架构

**同一份信息两个地方存、更新时忘了同步一处、就制造出矛盾**——比不存更糟。

### 1.4 时效性太强的不存

- ❌ "vercel/ai 现在有 42 个 open issues" —— 一小时后就过时
- ❌ "GitHub server 26 个工具" —— server 版本一变就变

**只存"只存在于对话中、无法从其他地方获取"的信息**——用户的偏好、纠正反馈、项目决策的背景原因、外部资源的位置。这些信息只在对话里出现过一次、如果不存下来、就永远丢了。

## 2. 四种记忆类型的语义分工

知道"什么不该存"、接下来是"该存的怎么分类"。跟 Claude Code 一致、我们分四种类型、每种触发时机和使用方式不同。

### 2.1 `user`——用户画像

**关于用户是谁的信息**：角色、偏好、技术背景、工作习惯。

例：`"用户是后端工程师、Go 十年、第一次做 Agent 教学项目"`

**价值**：有了这条、解释前端/AI 概念时可以用后端类比、不需要从零讲起。**这类记忆变化最慢**——用户身份稳定、几年内基本不变。

### 2.2 `feedback`——行为反馈

**用户对 Agent 行为的纠正和确认**。

- 纠正例：`"不要在测试里 mock 数据库"`
- 确认例：`"大 PR 比拆多个小 PR 好"`

**这类记忆最重要、因为它直接影响 Agent 的行为模式**。

**一个非显然的洞察**：**纠正的内容和后续确认的内容都要存**。只存纠正会让 Agent 越来越保守——它只知道"什么不该做"、不知道"什么做法被验证过了"。同时存"用户确认过 X 做法可以"、Agent 才有**边界感**——知道禁区在哪、也知道安全区在哪。

### 2.3 `project`——项目动态

**进行中的工作、决策、截止日期**。

例：`"下周四之前冻结非核心合并、移动端要切分支"`

**这类记忆衰减最快**——过了截止日期就没用了。

**一个必守的规则**：**存的时候要把相对日期转成绝对日期**——"下周四"存成 `"2026-05-07"`。不然一个月后看到"下周四"、完全不知道指的是哪一天。

在工具设计上、这条规则**必须写进 memory_remember 工具的 description**——让 Agent 每次调用时都看到这个约束。

### 2.4 `reference`——外部资源

**指向外部系统的一个渠道**。

例：`"bug 跟踪在 GitHub 看板的 backlog 栏目里"`、`"oncall 看 Grafana 的 api-latency 面板"`

**关键区分**：**存路径、不存内容**——

- ❌ `"当前 open issues 有 #42、#39"` —— 内容会变、快速过期
- ✅ `"issues 跟踪在 GitHub 看板的 backlog 栏目"` —— 位置信息、稳定

**把 memory 当元数据存储、不是知识存储**。

## 3. 存储结构：索引 + 分散 markdown

代码在 [`src/memory/store.ts`](../src/memory/store.ts)。结构：

```
.memory/
├── MEMORY.md                          ← 索引：一行一条元数据
├── user_typescript-preference.md     ← 每条 memory 是独立 markdown
├── feedback_no-mock-db.md
├── project_migration.md
└── reference_grafana.md
```

### 3.1 单个 memory 文件的 YAML frontmatter

```markdown
---
name: 用户偏好 TypeScript
description: 用户偏好 TypeScript，不喜欢 Python
type: user
createdAt: 2026-08-29T12:34:56.789Z
---

用户明确表示偏好 TypeScript、在需要写示例代码时优先用 TypeScript。
```

**为什么用 frontmatter 而不是 JSON**：**给人读也给模型读**。Markdown 是可扫描的、YAML 元数据是结构化的。JSON 只机读友好。

**`description` 字段不是装饰**——后续做记忆检索时、就是根据这个字段判断"这条记忆跟当前对话有没有关"。**写得越精确、检索质量越高**。

**`createdAt` 是 v2 加的**——用来判断过期（见 §6）。

### 3.2 索引文件 MEMORY.md

```markdown
# Memory Index

- user_typescript-preference.md: 用户偏好 TypeScript，不喜欢 Python
- feedback_no-mock-db.md: 用户反馈过：测试里不要 mock 数据库
- project_migration.md: 2026-08-31 前完成 memory 系统章节
- reference_grafana.md: DeepSeek V4 Flash 的 cache read 是 $0.027/M
```

**索引常驻 SYSTEM prompt、内容按需读**——跟 [tool-search-design.md](tool-search-design.md) 的 defer 目录同 pattern。

### 3.3 filename 的三条规则

`{type}_{slug}.md`：

1. **`type` 前缀**——`ls .memory/` 一眼看到分类
2. **slug 支持中文**——正则 `/[^a-z0-9一-鿿]+/` 保留中文字符范围
3. **可移植**——filePath 相对 `.memory/`（不含绝对路径）、整个目录 `mv` 走也不会坏

### 3.4 为什么"索引 + 分散文件"、不用单个 JSONL

对比 [session-persistence.md](session-persistence.md) 的 JSONL 选型、这里选完全不同的存储：

| 维度 | 单个 JSONL（session） | 索引 + 分散文件（memory） |
|---|---|---|
| 加载方式 | 一次读全部 | 索引常驻、内容按需 |
| 修改单条 | 重写整个文件 | 只改一个小文件 |
| 可读性 | JSON 单行、要 jq | Markdown、肉眼看 |
| 单条大小 | 单行 JSON、不适合长文本 | 独立 md、能存长决策背景 |

**session 是"append-only、崩溃安全"**——JSONL 完美匹配。
**memory 是"选择性读、内容可能较长、人肉能审"**——索引+分散更匹配。

**存储格式的选择要跟数据的使用模式对齐**、不能为一致性硬套。

## 4. 两个硬性约束：MAX_INDEX_LINES + MAX_FILE_CHARS

```ts
const MAX_INDEX_LINES = 200;
const MAX_FILE_CHARS = 4000;
```

**这两个数字都不是技术限制、是设计约束**——跟 Claude Code 一致的选择。

### 4.1 MAX_INDEX_LINES = 200：强制淘汰机制

**满了必须删旧的**——逼 Agent 只保留真正高价值的记忆、低价值的自然被淘汰。

实现是 LRU：

```ts
while (entryLines.length >= MAX_INDEX_LINES - 1) {
  const evicted = entryLines.shift()!;
  // 顺便 rm 对应内容文件、避免孤儿
  const orphanPath = path.join(this.memoryDir, evicted.filePath);
  if (fs.existsSync(orphanPath)) fs.unlinkSync(orphanPath);
}
```

**为什么是 200 而不是 20 或 2000**：

- **20 太紧**——Agent 会频繁淘汰、教学项目里跑几天就会撞上限
- **2000 太松**——积累了 2000 条噪音、检索精度直接崩
- **200 是"够用一年、但迫使精选"的甜蜜区**——Claude Code 的经验值

### 4.2 MAX_FILE_CHARS = 4000：单条读取硬上限

**读取时超限截断**——防止一条记忆把上下文预算吃光。

```ts
return content.length > MAX_FILE_CHARS
  ? content.slice(0, MAX_FILE_CHARS) + '\n\n[...truncated at read]'
  : content;
```

**跟 `truncateResult` / `microcompact` 是同一个思路**——**任何单条数据都有硬上限**、防止极端 case 撑爆 context。

## 5. 注入 SYSTEM：buildPromptSection + memoryContext segment

memory 有存储、还需要**注入 SYSTEM 让 Agent 每次都看到**——否则 Agent 只能主动调工具查、每轮都要多一次 round-trip。

### 5.1 buildPromptSection：store 自己决定怎么展示

看 [`store.ts`](../src/memory/store.ts) 的 `buildPromptSection()`：

```ts
buildPromptSection(): string {
  const entries = this.list();
  if (entries.length === 0) {
    return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。';
  }

  // 过期判断——超 24h 的附加验证提示
  const staleCount = entries.filter(e =>
    e.createdAt && Date.now() - new Date(e.createdAt).getTime() > 24 * 60 * 60 * 1000
  ).length;

  const lines = [
    `[记忆系统] 共 ${entries.length} 条记忆`,
    '',
    '记忆索引：',
    this.loadIndex(),
    '',
    '使用 memory 工具的 read 操作来读取具体记忆内容。',
    '**记忆是线索，不是事实——使用前先验证其准确性。**',
  ];

  if (staleCount > 0) {
    lines.push(`\n⚠ 其中 ${staleCount} 条记忆超过 24 小时——涉及代码行为或 file:line 引用的信息可能已经过时。`);
  }

  return lines.join('\n');
}
```

**关键设计**：**store 自己决定"我该怎么展示给模型"**——segment 只负责"要不要出现"。这样过期提醒、格式变化都内聚在 store 里、不用改 segment。

### 5.2 memoryContext segment 在 pipe 里的位置

看 [`src/index.ts`](../src/index.ts) 的 pipe 声明：

```ts
const promptBuilder = new PromptBuilder()
  .pipe('coreRules', coreRules())            // 永远不变
  .pipe('toolGuide', toolGuide())            // 工具数量基本固定
  .pipe('memoryContext', memoryContext())    // 两轮之间可能变、一轮内稳定  ← memory 位置
  .pipe('deferredTools', deferredTools())    // 一轮内可能变（tool_search 激活）
  .pipe('sessionContext', sessionContext()); // 每轮变（messageCount）——最后
```

**顺序即 cache 策略**（详见 [prompt-pipe-design.md](prompt-pipe-design.md#2-顺序即-cache-策略)）：

- **memoryContext 变频**：两轮之间（用户存新记忆时）
- **deferredTools 变频**：一轮内（tool_search 激活时）

**memory 变频比 deferredTools 低、更稳定**——放在它之前。

### 5.3 每轮 rebuild：让新记忆立即生效

一个容易忽略的细节：**每轮对话调 API 时，system prompt 应该包含最新的记忆内容**。

如果用户在第 3 轮存了一条记忆、第 4 轮的 SYSTEM 里就应该能看到它。

看 [`src/index.ts`](../src/index.ts) 的 `ask()`：

```ts
const promptCtx = {
    // ...
    memoryStore,   // 传引用而不是快照
};
const dynamicSystem = promptBuilder.build(promptCtx);
```

**关键**：`promptCtx` 是**每轮新建**、`memoryStore.buildPromptSection()` 每次都扫磁盘——所以新存的记忆下一轮立即可用、删掉的记忆立即消失。

**Cache 代价**：memory 变了、这一轮的 SYSTEM 前缀会 miss。但**记忆变化的频率远低于对话频率**（大部分轮次记忆不变）、整体 cache 命中率影响不大。**这是我们主动接受的 trade-off**。

## 6. "记忆是线索、不是事实"——过期提醒

**这一句是 memory 系统的核心哲学**、值得单独一节。

Mem0 报告的 **33% / 90 天不准确率**——记忆会过期是必然。**面对不可避免的过期、正确的做法不是"消灭过期"、是"提醒验证"**。

### 6.1 两层过期防御

**Layer 1: buildPromptSection 每次都提醒**

```
使用 memory 工具的 read 操作来读取具体记忆内容。
**记忆是线索，不是事实——使用前先验证其准确性。**
```

**每次都提醒一次**——比在工具 description 里说更有效。Agent 每次读 SYSTEM 都会看到这句、行为受影响的概率更高。

**Layer 2: 超 24h 附加过期警告**

参考 Claude Code 的做法——对超过一天的记忆自动附加提醒：

```
⚠ 其中 3 条记忆超过 24 小时——涉及代码行为或 file:line 引用的信息可能已经过时。
```

**24 小时的选择**：代码/项目状态一天内变化概率低、超过一天就该验证。这个数字可以按场景调（生产可能用 1 小时、教学项目 24h 够用）。

### 6.2 为什么用 createdAt 而不是 mtime

`createdAt` 从 frontmatter 读、不是从 `fs.statSync().mtimeMs`。

- **`git clone` 会重置 mtime**——记忆时间戳全变成 clone 时刻
- **`mv .memory/` 也会重置**——文件系统时间不可靠
- **frontmatter 里的 ISO 时间戳**——跟着文件走、任何 `mv`/`clone` 都不受影响

**"时间戳应该跟数据在一起、不该依赖文件系统"**——这是 v2 加 `createdAt` 字段的核心考虑。

## 7. 单一 `memory` 工具、六个 action

代码在 [`src/tools/memory-tools.ts`](../src/tools/memory-tools.ts)——一个工具、六个 action：

```
save    保存新记忆（name/description/type/content）
list    列出所有记忆
search  按关键词搜索（query）
read    读取单条完整内容（name）
delete  删除一条记忆（name）
lint    体检 + 可选清理（prune=true 才动手删）
```

### 7.1 为什么单一工具、不拆六个

**成本**：六个独立工具 = 六份 schema 常驻 SYSTEM = 更多 tokens

**认知**：Agent 一次学会"记忆管理"这一个 mental model、比学会五个分别的操作简单

**代价**：参数变多——需要在 description 里**分 action 说明每个需要哪些参数**

对应实现的：

```
参数按 action 区分：
  save   → 必填: name, description, type, content
  list   → 无参数
  search → 必填: query
  read   → 必填: name
  delete → 必填: name
```

### 7.2 description 里嵌入分类规则和排除法

这是这个工具最关键的设计——**把 §1 §2 的所有分类规则、排除法、日期归一化要求都塞进工具 description**：

```ts
description: `...
type 分四类：
  ● user       — 用户画像（角色、偏好、背景、技能）
  ● feedback   — 用户对 Agent 行为的纠正 **或** 确认（两种都要存）
  ● project    — 进行中的工作/决策/截止日期（**必须绝对日期**）
  ● reference  — 外部资源的位置（**不是内容快照**）

**不要 save 以下信息**（排除法比什么该存更重要）：
  ❌ 能从代码 grep 出来的
  ❌ 有权威来源的
  ❌ 时效性强的当前状态`,
```

**这是 prompt engineering 补足模型判断力的关键**——依赖 Agent 每次调用工具时都重新读 description、做正确判断。

**Enum 强制归类**：`type: enum ['user', 'feedback', 'project', 'reference']`——Agent 无法归类的信息就不该存。**这是分类的隐性守门员**。

## 8. 记忆会坏——四种坏 × 三层手段

前面所有设计都是**入口过滤**——让好的进来、坏的进不来。但**已经进来的记忆也会变坏**：

**四种坏**：

| 坏法 | 表现 | 后果 |
|---|---|---|
| **污染** | 把推测当事实存了（"项目用 MySQL"—— 实际迁到 PostgreSQL 了） | Agent 基于错误信息决策 |
| **爆炸** | 只存不删、信噪比越来越低 | 500 条挑 5 条相关的、搜出来基本没用 |
| **过期** | 代码变了、记忆没跟上 | **最隐蔽、最危险**——Agent 不会怀疑自己的记忆 |
| **冲突** | 新旧记忆互相矛盾 | Agent 不知道信谁、行为漂移 |

**三层手段**：

| 手段 | 应对 | 何时跑 | 成本 |
|---|---|---|---|
| **不存清单**（Layer 1） | 污染 | Agent 存记忆时 | 零成本（prompt + validator 规则） |
| **lint + TTL 分级**（Layer 2） | 过期 + 爆炸 | 手动或定期跑 | 低成本（纯规则、无 LLM） |
| **dream 自动整理**（Layer 3） | 冲突 + 残留 | 用户显式触发 | 高成本（一次 agent loop） |

**核心哲学跟前面几层一致**：**能用 prompt 教育解决的用教育、能用规则清理的用规则、需要判断的交给 Agent**。**从便宜到贵、层层递进**。

### 8.1 Layer 1：不存清单 = SYSTEM 里的原则

前面 §5 讲的 `buildPromptSection` 输出、末尾已经嵌了：

```
记忆使用原则：
- 记忆是线索，不是事实——使用前先用工具验证（read_file、grep 确认）
- 不存代码能推导的、git 能查的、文档已经写了的
- 只存对话中出现的、其他地方推导不出来的信息
```

**这是"教育"而不是"拦截"**：

- Agent 每轮进 loop 时都看到这段原则
- **在"决定要不要 save"之前**、已经知道不该存什么
- 依赖 Agent 遵守——**教育式比拦截式更前置、零 tool call 浪费**

**"教育原则 vs 拦截规则"的区别**：
- Rule（拦截规则）**只能捕获能编码的模式**——关键词、正则
- Principle（原则）**能应对没预料到的场景**——Agent 判断"这是不是事实"、比 validator 灵活

## 9. Layer 2：lint 体检 + TTL 分级

Layer 1 是"入口不让脏东西进"。**已经进来的呢**？——**过期防御、爆炸清理**——都归 Layer 2。

代码在 [`src/memory/validator.ts`](../src/memory/validator.ts) + [`src/memory/store.ts`](../src/memory/store.ts) 的 `lintAndPrune()`。

### 9.1 四种 type 的差异化 TTL

**"越久越有价值"的记忆永不过期**——这是最重要的设计选择：

| Type | TTL | 逻辑 |
|---|---|---|
| **`user`** | 永不过期 | 用户画像稳定、几年不变 |
| **`feedback`** | 永不过期 | 行为规则应长期遵守 |
| **`project`** | 30 天 | 进行中的工作衰减最快 |
| **`reference`** | 90 天 | 外部资源位置稳定但要定期验证 |

**为什么 user / feedback 永不过期**：**这两类是"越久越有价值"的记忆**——用户三年前告诉你的偏好、你今天还应该遵守。**随便清就废了 Agent 的长期学习**。

### 9.2 三种诊断结果 + LRU 语义

validator 对每条 memory 输出**issue 数组**、每个 issue 有 severity：

| Issue kind | severity | 语义 | 处理 |
|---|---|---|---|
| **stale_path** | warn | 引用的代码路径不存在 | 保留、附警告 |
| **stale_content** | warn | 含推测词 / 时效性词 | 保留、附警告 |
| **duplicate_name** | warn | 跨记忆重名（同一 name 出现多次） | 保留、让人合并 |
| **expired** | delete | 超过 type 对应 TTL | 建议删除 |

**关键的 LRU 语义**：TTL 判断用 **`lastReadAt`**（不是 `createdAt`）——**经常被读的记忆不会被清**。真正有价值的信息自动幸存。

**实现**：
- `save()` 记 `lastWriteAt` + `createdAt`
- `markRead()` 记 `lastReadAt`——`read` / `search` 命中时主动调
- `parseFile()` 不改磁盘（性能）、`markRead` 才写

### 9.3 "体检"和"手术"分开

`lintAndPrune(baseDir, pruneExpired = false)` —— **默认只诊断**：

```
memory lint             → 只诊断、列出问题
memory lint prune       → 真删过期条目
```

**分开是设计选择**：

- **前者是"体检"**——每次都可以跑、无副作用、纯读
- **后者是"手术"**——需要用户确认

**Agent 收到诊断报告后能自主判断**"这条我要保留、那条建议删"——比盲目清理稳。

### 9.4 duplicate_name 只 warn、不 delete

Agent 有时候会在不同时间点存两条名字相同但内容不一样的记忆——**这是冲突信号、不是简单的重复**。

- 内容 A：一个月前存的"用户偏好 TypeScript"
- 内容 B：昨天存的"用户偏好 TypeScript、但项目允许时用 Rust"

**这两条自动 delete 谁都不对**——**让人（或 Agent 通过 dream）来判断**。所以 lint 只警告、不动手。

### 9.5 三个结构性 lint 规则

除了 TTL、validator 还检查**结构性问题**（跟时间无关）：

```ts
const SPECULATIVE_PATTERN = /(可能|大概|应该|似乎|好像|probably|maybe|estimate|guess)/i;
const TEMPORAL_PATTERN = /(当前|目前|现在|今天|本周|这周|下周|this week|currently|nowadays|as of)/i;
const CODE_PATH_PATTERN = /\b(?:src|lib|app|test|tests|scripts?)\/[\w/.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java)\b/g;
```

- **推测词命中** → warn "含推测词、建议改成事实性表述"
- **时效性词命中** → warn "可能已过时、建议改成绝对日期"
- **代码路径命中** → **动态检测**：`fs.existsSync(path)`——路径不存在就 warn

**动态检测比正则更准**——文件被删了、rename 了都能立刻发现。

## 10. Layer 3：dream——prompt-driven 自主整理

Layer 2 是**规则**——能覆盖 80% 的清理需求。但**"这两条重复、哪个内容更全"** 这类判断、规则表达不了。

Layer 3 是**dream**——**把 lint 报告丢给 Agent、让它自主判断**。

代码在 [`src/commands/memory.ts`](../src/commands/memory.ts) 的 `memoryDreamHandler`。

### 10.1 核心洞察：dream 是 prompt、不是 hardcoded 逻辑

**Rule-driven（硬编码）** 会长这样：

```ts
if (duplicate) merge();
else if (staleTTL) delete();
else if (stalePathAndOld) delete();
```

- 每种 case 都要提前想到、写死
- 复杂决策（"哪个内容更全"）**规则表达不了**
- 修一个决策要改代码

**Prompt-driven** 长这样：

```ts
const dreamPrompt = [
  '阶段 1: memory action=lint 扫描全库',
  '阶段 2: 按 severity 判断动作',
  '  - delete 的直接删',
  '  - duplicate 的对比后保留更新的',
  '  - stale 的 save 覆盖修正',
  '阶段 3: 总结这次做了什么',
].join('\n');
```

**修决策 = 改 prompt、不改代码**。**这是 Claude Code AutoDream 的核心思路**——dream 本质是 prompt、不是一段写死的代码。

### 10.2 三阶段编排

Dream prompt 明确指导三个阶段：

**阶段 1：定位** —— Agent 调 `memory action=lint`、拿到全库诊断报告
- 报告已包含每条 issue 的 severity + description
- **不需要逐条 read**——lint 输出已经够 Agent 判断

**阶段 2：整理** —— Agent 根据 severity 决定动作：
- `severity=delete`（expired）→ 直接 `memory action=delete`
- `duplicate_name` → `memory action=read` 对比 → 保留新的、删旧的
- `stale_path / stale_content` → 内容仍有价值就 `memory action=save` 覆盖修正

**阶段 3：报告** —— Agent 用一段文字总结这次做了什么

**关键**：阶段 1 已经给 Agent 结构化数据（lint 报告）、**阶段 2 的具体决策交给 Agent**——**编排管顺序、决策交给智能**。

### 10.3 为什么让 dream 用全部工具、不限制

一个非显然的决策——Agent 走 dream 时**保留全部工具**（grep / read_file / bash / rag_search 等），不只限制在 memory 工具。

**理由**：dream 是"整理任务"、复杂决策可能需要**外部验证**：

- 判断 stale_path 时——`grep` 或 `ls` 确认文件真的不存在
- 判断 duplicate 时——`read_file` 看看代码是不是真的用了这条记忆里说的东西
- 判断 stale_content 时——`rag_search` 找文档看现在的说法

**限制工具集会让 dream 决策变差**——**"trust the Agent"** 的哲学在这里落地。

### 10.4 dream 是"手动触发"、不是自动

我们没做"Claude Code AutoDream 那种 idle detection"——**用户显式跑 `dream` 命令才触发**。

**理由**：

- dream 会跑一次完整的 agentLoop——**几秒到几十秒、几分钱**
- 自动触发的时机很难设——太频繁贵、太稀疏没效果
- **让用户决定"什么时候整理"更简单**——就像手动 `git gc` 而不是自动跑

生产上想做自动触发、有两种方向：
- **idle detection**：用户 5 分钟没输入就跑
- **阈值触发**：`lint` 里 warn + toDelete 数量超阈值时提示"该 dream 了"

留作后续。

## 11. 生产级进阶：还没做的两件事

这一节讲**我们没做但生产系统会做的两件事**——不是遗憾、是**教学项目和生产系统的自然边界**。

（**AutoDream 我们已经做了**——见 §10、Layer 3、prompt-driven 版本。区别在于我们不自动触发、要用户手动 `dream`。）

### 11.1 精选注入：不是所有记忆都该塞进上下文

**问题**：当前把索引整个注入 SYSTEM。记忆少时没问题、但**积累 200 条时索引本身就几 KB**——其中大部分跟当前对话无关。

**Claude Code 的方案**：每轮对话开始前、用便宜的模型（Sonnet 或 Haiku）扫描所有记忆的 description、判断哪些跟当前任务相关、**最多选 5 个**。这个过程**异步**、不阻塞主流程响应。

**这就是为什么 description 字段那么重要**——精选模型看的就是这个字段、不是完整内容。**Description 写得好、精选就准**。

**我们为什么不做**：需要引入**异步 LLM 调用**基础设施。当前 memory 数量还没到瓶颈、教学项目里主动 save 的 memory 不会超过几十条——**过度工程**。

**朝这个方向走一小步**（不引入 LLM）：`buildPromptSection` 可以接收当前对话的 messages、做纯字符串 keyword extraction + search、只注入相关的几条。精度比 LLM 差、但零成本。留作后续。

### 11.2 后台自动提取：用户无感知的记忆写入

**问题**：当前依赖 Agent 主动调 `memory` action=save。但很多值得记的信息不是用户明确要求存的——"我上周升 Tech Lead 了"这句话出现在闲聊里、Agent 应该自己识别出来存为 user 类型记忆。

**Claude Code 的方案**：每次对话结束后、fork 一个后台 Agent 提取记忆。有严格限制：**最多 5 轮对话预算、只能读代码和写记忆文件、跟用户手动写互斥**。分析刚才的对话内容、提取值得长期保留的信息。

**关键机制**：因为 fork 出来的 Agent 和主 Agent 共享同一段 SYSTEM + tools、可以直接复用主 Agent 的 **Prompt Cache**——**成本极低**。

**我们为什么不做**：需要引入**"fork Agent + 独立 budget + 工具白名单"**基础设施。当前架构 Agent 是单例、无 fork 概念。

**一个非显然的坑**：**"什么该被提取"跟主 Agent 判断"什么该 save"是同一个问题**——只是把判断延后到对话结束。如果主 Agent 判断力不足、后台 Agent 大概率也不足。**前提是主 Agent 主动 save 的准确率已经测过、明显不够**。

### 11.3 共同前提：后台 Agent 基础设施

这两个特性共享同一个基础设施——**能在后台 fork 一个"低成本 Agent"**。**引入这个基础设施的成本可能大于当前 memory 系统全部代码**。

**教学项目的定位是"看清核心机制"**：

- **精选注入的核心机制**：description 是相关性信号 → 我们**已经做了**（工具 description 强调 description 是检索关键字段）
- **后台提取的核心机制**：判断"值得记吗" → 我们**已经隐性做了**（Agent 主动 save 就是运行时判断）
- **AutoDream 的核心机制**：定期清理过时记忆 → 我们**已经完整做了**（Layer 3、只是手动触发）

**每个生产特性的"魂"我们都做了、只是没做"异步 + fork"那一层**——那一层是规模化优化、不是理解 memory 系统的必要。

## 12. 已知的坑与后续方向

**1. 关键词 search 精度有限**

当前 `search()` 是 `name + description + content` 做 OR 匹配。中文分词差、同义词不识别。生产该接 embedding 或 LLM 精选（见 §11.1）。

**2. 无冲突检测**

save 时同名 filename 直接覆盖。**没有"这条记忆跟已有的 X 矛盾"** 的检测——如果用户先说"喜欢 TypeScript"、又说"最近想学 Rust"、两条都会存下、Agent 看到两个可能觉得矛盾。

Layer 3 dream **能间接处理**——Agent 看到 duplicate_name 或语义矛盾时判断合并。但 lint 层面没有"语义矛盾检测"——是规则表达不了的。

**3. LRU 淘汰只按 lastReadAt——不算 write**

当前 TTL 判断只看 `lastReadAt`。**如果 Agent 频繁 update 但没 read** 的记忆——按 LRU 会被误清。

修法：TTL 用 `max(lastReadAt, lastWriteAt)`——只要有更新或访问就算"活着"。留作后续小修。

**4. 24h 过期提醒硬编码**（跟 TTL 分级独立）

`buildPromptSection` 里的"超 24 小时附加验证提示"跟 §9 的 TTL 分级是**两套系统**：

- 24h 提醒：提示 Agent"验证"、不删——**用侧策略**
- TTL 分级：满足条件的直接删——**存侧策略**

两者互补、但可以更精细。生产可以按 type 差异化 24h 提醒——`user` 30 天才提醒、`project` 1 天就提醒。

**5. dream 没有 dry-run 模式**

现在 dream 一跑就是完整 loop——Agent 直接动手删/合并。**没法"先看看它想干什么、再决定要不要执行"**。

修法：加 `dream --preview` 参数、prompt 里改成"只输出计划、不执行任何修改"。留作后续。

**6. dream 触发是完全手动、无自动化**

见 §10.4——**用户显式跑 `dream`**。生产可以做：
- **idle detection**：用户 5 分钟没输入就跑
- **阈值触发**：`lint` warn + toDelete 超阈值时提示

**7. 描述字段没做质量保证**

description 越精确、search 越准。但 Agent 写的 description 质量参差不齐——有的一句话精准、有的照抄 name。**没有反馈机制**告诉 Agent"你上次写的 description 太模糊"。

一个可能的改进：`memory` 工具 description 里加"description 应该 20-60 字符、包含关键动词和名词"这类具体约束。当前只强调"精确"、太抽象。

**8. 无 export / import**

memory 目前只能通过 markdown 文件手动看。**没有 dump 全部到一个 archive、或者 import 别的项目的 memory**。生产上应该有个 `memory export` / `memory import` 命令。

---

## 相关文档

- [session-persistence.md](session-persistence.md) — Session 是**短期工作记忆**、Memory 是**长期记忆**；两者存储格式完全不同（JSONL vs 索引+markdown）
- [prompt-pipe-design.md](prompt-pipe-design.md) — memoryContext segment 在 pipe 里的位置遵循"先静后动"原则
- [tool-search-design.md](tool-search-design.md) — memory 索引常驻、内容按需读——跟 defer 目录同 pattern
- [cost-visualization.md](cost-visualization.md) — memory 每轮 rebuild 会导致 cache 前缀失效、跟 sessionContext 是同类问题
- [context-compression.md](context-compression.md) — memory 是 SYSTEM 的一部分、不参与压缩（跟"三类内容"里的 SYSTEM 一致）
