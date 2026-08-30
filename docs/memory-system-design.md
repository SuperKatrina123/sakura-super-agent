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
- [7. 单一 `memory` 工具、五个 action](#7-单一-memory-工具五个-action)
- [8. 生产级进阶：我们没做的三件事](#8-生产级进阶我们没做的三件事)
- [9. 已知的坑与后续方向](#9-已知的坑与后续方向)

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

## 7. 单一 `memory` 工具、五个 action

代码在 [`src/tools/memory-tools.ts`](../src/tools/memory-tools.ts)——一个工具、五个 action：

```
save    保存新记忆（name/description/type/content）
list    列出所有记忆
search  按关键词搜索（query）
read    读取单条完整内容（name）
delete  删除一条记忆（name）
```

### 7.1 为什么单一工具、不拆五个

**成本**：五个独立工具 = 五份 schema 常驻 SYSTEM = 更多 tokens

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

## 8. 生产级进阶：我们没做的三件事

这一节讲**我们没做但生产系统会做的三件事**——不是遗憾、是**教学项目和生产系统的自然边界**。

### 8.1 精选注入：不是所有记忆都该塞进上下文

**问题**：当前把索引整个注入 SYSTEM。记忆少时没问题、但**积累 200 条时索引本身就几 KB**——其中大部分跟当前对话无关。

**Claude Code 的方案**：每轮对话开始前、用便宜的模型（Sonnet 或 Haiku）扫描所有记忆的 description、判断哪些跟当前任务相关、**最多选 5 个**。这个过程**异步**、不阻塞主流程响应。

**这就是为什么 description 字段那么重要**——精选模型看的就是这个字段、不是完整内容。**Description 写得好、精选就准**。

**我们为什么不做**：需要引入**异步 LLM 调用**基础设施。当前 memory 数量还没到瓶颈、教学项目里主动 save 的 memory 不会超过几十条——**过度工程**。

**朝这个方向走一小步**（不引入 LLM）：`buildPromptSection` 可以接收当前对话的 messages、做纯字符串 keyword extraction + search、只注入相关的几条。精度比 LLM 差、但零成本。留作后续。

### 8.2 后台自动提取：用户无感知的记忆写入

**问题**：当前依赖 Agent 主动调 `memory` action=save。但很多值得记的信息不是用户明确要求存的——"我上周升 Tech Lead 了"这句话出现在闲聊里、Agent 应该自己识别出来存为 user 类型记忆。

**Claude Code 的方案**：每次对话结束后、fork 一个后台 Agent 提取记忆。有严格限制：**最多 5 轮对话预算、只能读代码和写记忆文件、跟用户手动写互斥**。分析刚才的对话内容、提取值得长期保留的信息。

**关键机制**：因为 fork 出来的 Agent 和主 Agent 共享同一段 SYSTEM + tools、可以直接复用主 Agent 的 **Prompt Cache**——**成本极低**。

**我们为什么不做**：需要引入**"fork Agent + 独立 budget + 工具白名单"**基础设施。当前架构 Agent 是单例、无 fork 概念。

**一个非显然的坑**：**"什么该被提取"跟主 Agent 判断"什么该 save"是同一个问题**——只是把判断延后到对话结束。如果主 Agent 判断力不足、后台 Agent 大概率也不足。**前提是主 Agent 主动 save 的准确率已经测过、明显不够**。

### 8.3 AutoDream：记忆的睡眠整理

**Anthropic 给 Claude Code 加了一个叫 AutoDream 的功能**——在用户不活跃时、后台 Agent 整理记忆：合并重复信息、把相对日期转成绝对日期、删除矛盾的旧记忆、清理过时的条目。**类比人类的"睡眠记忆巩固"**——白天积累、晚上整理。

**我们为什么不做**：

1. **触发时机在 REPL 里没有对应概念**——用户可能几天不回来、"idle" 定义不清
2. **200 条以内手工整理就行**——用户偶尔 `memory forget` 一次
3. **合并矛盾记忆需要又一次 LLM 调用**——又一层复杂度和容错

**AutoDream 只在"7x24 running Agent"或"多用户 SaaS"场景值得做**。教学项目单进程 REPL 用不上。

### 8.4 共同前提：后台 Agent 基础设施

这三个特性看似不同、共享同一个基础设施——**能在后台 fork 一个"低成本 Agent"**。**引入这个基础设施的成本可能大于当前 memory 系统全部代码**。

**教学项目的定位是"看清核心机制"**：

- **精选注入的核心机制**：description 是相关性信号 → 我们**已经做了**（工具 description 强调 description 是检索关键字段）
- **后台提取的核心机制**：判断"值得记吗" → 我们**已经隐性做了**（Agent 主动 save 就是运行时判断）
- **AutoDream 的核心机制**：定期清理过时记忆 → 我们**已经隐性做了**（LRU 淘汰 + 24h 过时提醒）

**每个生产特性的"魂"我们都做了、只是没做"异步 + fork"那一层**——那一层是规模化优化、不是理解 memory 系统的必要。

## 9. 已知的坑与后续方向

**1. 关键词 search 精度有限**

当前 `search()` 是 `name + description + content` 做 OR 匹配。中文分词差、同义词不识别。生产该接 embedding 或 LLM 精选（见 §8.1）。

**2. 无冲突检测**

save 时同名 filename 直接覆盖。**没有"这条记忆跟已有的 X 矛盾"** 的检测——如果用户先说"喜欢 TypeScript"、又说"最近想学 Rust"、两条都会存下、Agent 看到两个可能觉得矛盾。

生产该做**语义冲突检测**——需要 LLM 或规则引擎、复杂度不匹配教学项目。

**3. LRU 淘汰只按顺序、不按"最近使用"**

真正的 LRU 应该按"最近被 read 或 search 命中"排序——当前只按"插入顺序"淘汰。**如果一条 3 年前存的、每天用一次的 user 类记忆、被 200 条最近的低价值 project 记忆挤掉**——语义上错。

修法：加 `lastAccessedAt` 字段、search/read 时更新。留作后续。

**4. 24h 过期提醒是硬编码**

不同 type 的过期速度不同——`user` 记忆几年不变、`project` 一周就过期。当前一刀切 24h、准确率有限。生产该按 type 差异化：

- `user`: 90 天以上才提醒
- `feedback`: 30 天
- `project`: 7 天甚至更短
- `reference`: 30 天（要提醒验证）

**5. 描述字段没做质量保证**

description 越精确、search 越准。但 Agent 写的 description 质量参差不齐——有的一句话精准、有的照抄 name。**没有反馈机制**告诉 Agent"你上次写的 description 太模糊"。

一个可能的改进：`memory` 工具 description 里加"description 应该 20-60 字符、包含关键动词和名词"这类具体约束。当前只强调"精确"、太抽象。

**6. 无 export / import**

memory 目前只能通过 markdown 文件手动看。**没有 dump 全部到一个 archive、或者 import 别的项目的 memory**。生产上应该有个 `memory export` / `memory import` 命令。

---

## 相关文档

- [session-persistence.md](session-persistence.md) — Session 是**短期工作记忆**、Memory 是**长期记忆**；两者存储格式完全不同（JSONL vs 索引+markdown）
- [prompt-pipe-design.md](prompt-pipe-design.md) — memoryContext segment 在 pipe 里的位置遵循"先静后动"原则
- [tool-search-design.md](tool-search-design.md) — memory 索引常驻、内容按需读——跟 defer 目录同 pattern
- [cost-visualization.md](cost-visualization.md) — memory 每轮 rebuild 会导致 cache 前缀失效、跟 sessionContext 是同类问题
- [context-compression.md](context-compression.md) — memory 是 SYSTEM 的一部分、不参与压缩（跟"三类内容"里的 SYSTEM 一致）
