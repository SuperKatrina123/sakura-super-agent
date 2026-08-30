# Skill 系统：把工作流从 Prompt 里抽出来

> 配套 [../README.md](../README.md) 的拓展阅读。前几篇讲的是**给 Agent 装能力**（工具、记忆、RAG）——这一篇讲**给 Agent 装工作流**：为什么一次性 SOP 该沉淀成可复用的 skill、YAML frontmatter + markdown 的组合为什么足够、progressive loading 三层怎么落地、以及 `/skill` + `/<skill-name>` 双入口的设计取舍。

## 目录

- [0. 为什么需要 skill](#0-为什么需要-skill)
- [1. 排除法：skill 不是什么](#1-排除法skill-不是什么)
- [2. 目录结构：一个 skill 一个文件夹](#2-目录结构一个-skill-一个文件夹)
- [3. Progressive Loading 三层](#3-progressive-loading-三层)
- [4. 两种激活入口：元工具 vs 快捷命令](#4-两种激活入口元工具-vs-快捷命令)
- [5. 注入 SYSTEM：skillsContext pipe](#5-注入-systemskillscontext-pipe)
- [6. `when_to_use`：本项目为什么保留](#6-when_to_use本项目为什么保留)
- [7. 已知的坑与后续方向](#7-已知的坑与后续方向)

## 0. 为什么需要 skill

**问题**：用户每次让 Agent 做"review 代码"、都要在 prompt 里重复交代"先看 git diff、再对每个文件检查安全性 / 一致性 / 测试覆盖、最后按报告模板输出"。

**痛点**：

- **重复交代成本高**——同一套 SOP 每次都要说一遍
- **质量不稳定**——同样的任务、prompt 稍微换个说法、Agent 执行流程就漂
- **组织资产流失**——团队里最资深工程师的经验（"review 时先看敏感文件、别用 `git add .`"）没沉淀下来、只在他们脑子里

**解决**：把工作流写成 markdown、放进 `.skills/<name>/SKILL.md`——Agent 启动时索引所有 skill、激活时把完整 SOP 注入 SYSTEM。

**这跟前面几个系统的定位区分**：

| 系统 | 沉淀的是 | 生命周期 | 触发方式 |
|---|---|---|---|
| Memory | 用户/项目/反馈**事实** | 跨会话长期 | 每次启动自动注入 |
| RAG | 大量**文档知识** | 长期 + 按需查 | rag_search 工具 |
| Session | 单次对话**过程** | 单会话 | --continue 恢复 |
| **Skill** | 可复用**工作流** | 跨会话长期 | 激活后注入 SYSTEM |

Skill 填的是"**流程模板**"这个空档——不是事实、不是知识、不是历史，而是"**遇到 X 类型的任务、按下面这套步骤办**"。

## 1. 排除法：skill 不是什么

跟 memory 一样、**做 skill 系统最容易犯的错是"什么都塞"**。先划清边界。

### 1.1 一次性任务不做 skill

- ❌ "帮我改 login.tsx 第 42 行的 bug"——一次性、下次不会再犯
- ✅ "code-review 工作流"——每次代码合并前都用

**判断标准**：**这套流程会不会在未来还用？**只用一次就是 prompt、用多次才是 skill。

### 1.2 单步操作不做 skill

- ❌ "运行 npm test"——一条命令、写工具就够
- ✅ "遇到测试失败时的完整调试流程"——多步、有分支、需要判断

**判断标准**：**能不能用一个 tool call 完成？**能的话直接做工具、不用 skill 包一层。

### 1.3 纯知识不做 skill

- ❌ "TypeScript 的类型系统怎么工作"——这是知识、放 RAG
- ✅ "定位 TypeScript 类型错误的 SOP"——这是流程、放 skill

**判断标准**：**输出是文档还是行动？**要 Agent 读完之后**做什么**、才是 skill 该做的事。

### 1.4 已被代码约束的不做 skill

- ❌ "别用 `git add .`"——已经在 CLAUDE.md 的项目约束里
- ✅ 完整的 commit 流程（含 message 格式、push 前二次确认）

**判断标准**：**这条规则跟具体流程绑定吗？**通用规则放 CLAUDE.md、流程绑定的规则放 skill。

**排除完再考虑做**——skill 一多、SYSTEM 里的"可用 Skills"列表也会膨胀、Agent 挑错的概率会上升。

## 2. 目录结构：一个 skill 一个文件夹

```
.skills/
├── code-review/
│   ├── SKILL.md          ← YAML frontmatter + body
│   └── checklist.md      ← 可选辅助文件（body 里引用相对路径）
├── commit/
│   └── SKILL.md
└── ...
```

**为什么是"一个 skill 一个文件夹"、不是"一个 md 文件"**：

- 一个 skill 常需要**多个辅助文件**——review 的 checklist、commit 的 message 模板、rag 的示例查询
- 文件夹给了 skill 一个"**根**"——body 里可以写相对路径（比如 `read_file ./checklist.md`）、结构清晰
- 添加 skill 只需要 `mkdir + touch SKILL.md`、删除只需要 `rm -rf` 整个目录——**没有共享状态、幂等**

**SKILL.md 的格式**：

```markdown
---
name: code-review
description: 按项目约束严格审查代码变更
when_to_use: 用户说"review"、"check"、"审代码"、或想合并 PR 之前
---

# Code Review 工作流

按以下顺序执行、每步都要明确告诉用户你在做什么：

## Step 1：明确审查范围
...
```

**frontmatter 里三个字段**：

- `name`——**从目录名取**、frontmatter 里就不重复了（避免"目录名和 frontmatter name 不一致"的祖传坑）
- `description`——一句话说这个 skill 是干什么的、必填、缺失就 skip
- `when_to_use`——**激活线索**、可选（本项目保留、见第 6 节）

**strict mode**：没 frontmatter 或 description 缺失 → 直接 skip、不加载。**这条比"宽松兜底"重要**——skill 元数据烂 = Agent 挑不出该激活谁 = skill 系统白搭。

## 3. Progressive Loading 三层

Skill 数量会随着团队沉淀增长——**不能全部塞进 SYSTEM**。这里跟 [ToolSearch 延迟加载](tool-search-design.md) 和 [Memory 索引 + markdown](memory-system-design.md) 是同一个模式：**轻索引先注入、重内容按需读**。

### Level 1：启动加载 frontmatter（约 100 tokens/skill）

`SkillLoader.load()` 扫 `.skills/*/SKILL.md`、只解析 frontmatter：

```ts
private skills = new Map<string, SkillDefinition>();
private activeSkills = new Set<string>();

load() {
  for (const entry of fs.readdirSync('.skills')) {
    const raw = fs.readFileSync(path.join('.skills', entry, 'SKILL.md'), 'utf-8');
    const parsed = this.parseFrontmatter(raw);
    if (!parsed) continue;  // strict: description 缺失 skip
    this.skills.set(entry, {
      name: entry,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      content: parsed.content,  // body 也存下、但不注入 SYSTEM
      dirPath: path.join('.skills', entry),
    });
  }
}
```

body 也一起读进内存（磁盘 io 一次搞定），但**只有元数据进 SYSTEM**。100 个 skill 约 10K tokens——预算的 1.5%、能接受。

### Level 2：激活后完整 body 进 SYSTEM

`activate(name)` 把 skill 名加进 `activeSkills`、下一轮 `buildPromptSection()` 就会把 body 塞进 SYSTEM：

```ts
buildPromptSection(): string | null {
  if (this.skills.size === 0) return null;
  const lines: string[] = [];

  // 已激活的完整注入
  for (const name of this.activeSkills) {
    const skill = this.skills.get(name);
    if (!skill) continue;
    lines.push(`[激活的 Skill: ${skill.name}]`);
    lines.push(skill.content);
    lines.push('');
  }

  // 未激活的只列名字 + 描述（+ whenToUse 如果有）
  const available = this.list()
    .filter(s => !this.activeSkills.has(s.name))
    .map(s => {
      const base = `  ${s.name} — ${s.description}`;
      return s.whenToUse ? `${base}（适用场景: ${s.whenToUse}）` : base;
    });
  if (available.length > 0) {
    lines.push('可用的 Skills（用 skill_load 工具激活获取完整指令）：');
    lines.push(...available);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}
```

**注入策略的两个细节**：

- **激活的 skill 用完整标题**（`[激活的 Skill: name]`）——SYSTEM 里视觉突出、模型不容易忽略
- **未激活的塞在一起**——一行一个、`name — description`、避免占太多空间

### Level 3：辅助文件按需 read_file

`SKILL.md` 的 body 里可以写：

```markdown
详细的 review checklist 见 `./checklist.md`——需要时用 read_file 打开
```

**这里最漂亮的设计**：**skill 的辅助文件就是普通文件、复用 read_file 工具、不需要额外抽象**。

- 生态里有些方案给 skill 单独做了资源管理系统（`skill_get_resource(name, resource)`）——**过度设计**
- 我们的方案：辅助文件放在 skill 目录里、body 里引用相对路径、Agent 用现成的 read_file 打开

**dirPath 字段存在的意义**：给 Agent 一个"skill 的根"、body 里可以说 `./checklist.md`、Agent 拿到 skill.dirPath 拼路径就能读。

## 4. 两种激活入口：元工具 vs 快捷命令

Skill 激活有两个入口、**不是冗余、是不同用户角色**。

### 4.1 `skill_load` 元工具：让 Agent 自主激活

跟 `tool_search` 一样、暴露成一个工具：

```ts
// src/tools/skill-tools.ts
export function createSkillLoadTool(loader: SkillLoader): ToolDefinition {
  return {
    name: 'skill_load',
    description: `激活一个 skill。传入 name（从 SYSTEM 的"可用 Skills"列表选）、下一轮 SYSTEM 就会包含该 skill 的完整指令。

**何时用**：用户的任务匹配某个 skill 的 when_to_use 描述——**别自己重复推理、直接激活让 skill 指导你怎么做**。

**不用重复激活**：skill 一旦激活就一直在 SYSTEM 里、别每次都调。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill 名（跟"可用 Skills"列表完全一致）' },
      },
      required: ['name'],
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ name }) => {
      if (loader.isActive(name)) return `[Skill] "${name}" 已经激活`;
      const ok = loader.activate(name);
      if (!ok) return `[Skill] 没找到 "${name}"`;
      const skill = loader.get(name)!;
      return `[Skill] 已激活 "${name}"（${skill.description}）。下一步：按下轮 SYSTEM 里的完整指令执行`;
    },
  };
}
```

**关键设计**：**tool 返回值不注入 body**——只返回一句确认、body 由**下一轮 SYSTEM 重建时**注入。

**为什么这么设计**：

- **语义清晰**——skill 是"系统级指令"、跟 SYSTEM 内容一起呈现比塞进 tool result 更符合模型的期望
- **省 tokens**——tool result 每轮都会带、SYSTEM 段落走 prompt cache、后者更便宜
- **激活状态在 loader 里**——工具本身无状态、每次调都是纯函数

### 4.2 `/skill` + `/<name>` 快捷命令：让用户直接控制

Agent 自主激活是异步的、有时**用户想立刻上手**——不用等 Agent 自己判断、直接说"用 code-review 这个 skill"。

四个 handler：

```
/skill                    → 列出所有 skill（含激活状态）
/skill load code-review   → 激活
/skill unload code-review → 卸载
/code-review              → 快捷激活 + 立刻按 SOP 执行
/code-review 顺便看看 PR   → 同上、附带额外说明
```

前三个是普通的同步 handler——改 `activeSkills` set 完就 return。

**第四个（`skillShortcutHandler`）最有意思**——**它是 async handler**：

```ts
export const skillShortcutHandler: CommandHandler = async (cmd, ctx) => {
  const t = cmd.trim();
  if (!t.startsWith('/')) return false;

  // 排除已知的其他 slash 命令
  const known = ['/skill', '/memory', '/dream', '/context', '/usage', '/help', '/exit'];
  if (known.some(k => t === k || t.startsWith(k + ' '))) return false;

  const loader = ctx.skillLoader;
  const m = /^\/([\w-]+)(?:\s+(.+))?$/.exec(t);
  if (!m) return false;
  const [, name, extra] = m;

  const skill = loader.get(name);
  if (!skill) return false;   // 不是已知 skill、交给下个 handler

  // 激活 + 把 skill body 作为 user 消息注入
  loader.activate(name);
  const promptLines = [`请按下面的 skill 指令执行任务。`];
  if (extra) promptLines.push(`用户额外说明: ${extra}`);
  promptLines.push('', `[Skill: ${name}]`, skill.content);
  const userMsg: ModelMessage = { role: 'user', content: promptLines.join('\n') };
  ctx.messages.push(userMsg);
  ctx.sessionStore.append(userMsg);

  const dynamicSystem = ctx.builder.build(ctx.makePromptCtx());
  await agentLoop(ctx.model, ctx.registry, ctx.messages, dynamicSystem, ctx.budget, {
    usageTracker: ctx.tracker,
    modelInfo: ctx.modelInfo,
    cacheDisabled: ctx.cacheState.disabled,
  });
  ctx.ask();
  return true;
};
```

**这里两个设计选择要展开**：

**① 为什么把 body 塞进 user message、而不是等下轮 SYSTEM？**

如果只做 `loader.activate(name)`、Agent 得等下一次输入触发下一轮 loop 才能看到 skill 内容——**用户体验很差**：`/code-review` 打完发现 Agent 没反应、还要再打一句"开始"。

**塞进 user message 让 Agent 在当轮就能看到指令、立刻开跑**——这是"快捷"两个字的核心。

**② 为什么 dispatcher 要 async 化？**

之前的 handler 都是同步的——写完就 return。但 shortcut 要 `await agentLoop(...)`——**整个 dispatcher 链条得改成 async**：

```ts
export type CommandHandler = (cmd: string, ctx: CommandContext) => boolean | Promise<boolean>;

export function createDispatcher(handlers: CommandHandler[]) {
  return async (cmd, ctx) => {
    for (const h of handlers) {
      const result = await h(cmd, ctx);  // await 每一个
      if (result) return true;
    }
    return false;
  };
}
```

**兼容性**：同步 handler 直接返回 `boolean`、await 会立即 resolve、没有性能损失。**这个改动为 dream / shortcut / 未来所有"能触发 loop 的命令"都铺好了路**。

### 4.3 handler 顺序：shortcut 必须放最后

```ts
const dispatcher = createDispatcher([
  ...其他 handler,
  skillLoadHandler,     // "/skill load <name>"
  skillUnloadHandler,   // "/skill unload <name>"
  skillListHandler,     // "/skill" 裸命令
  skillShortcutHandler, // "/<any>" —— 匹配任何 slash、放最后
]);
```

**理由**：`skillShortcutHandler` 会尝试匹配任何 `/xxx` 命令、放前面会**抢走**其他所有 slash 命令。它的排除列表（`known = ['/skill', '/memory', ...]`）是**兜底防线**、不是"主要防御"——真正的防御是**顺序**。

## 5. 注入 SYSTEM：skillsContext pipe

Skill 的 SYSTEM 注入走 [Prompt Pipe](prompt-pipe-design.md) 系统——跟 memory / rag 同一套机制：

```ts
// src/context/prompt-pipes.ts
export function skillsContext(loader: SkillLoader): PipeFn {
  return () => loader.buildPromptSection();
}
```

在 `index.ts` 里挂到 pipe 上：

```ts
promptBuilder
  .pipe('coreRules', coreRules)
  .pipe('toolGuide', toolGuide)
  .pipe('deferredTools', deferredTools)
  .pipe('memoryContext', memoryContext(memoryStore))
  .pipe('skillsContext', skillsContext(skillLoader))   // ← 这里
  .pipe('ragContext', ragContext(() => ragStoreRef.store))
  .pipe('sessionContext', sessionContext);
```

**pipe 位置的两个考量**：

**① 相对位置 = cache 友好度**

Prompt Pipe 的核心策略是"**静态在前、动态在后**"——静态部分（coreRules、toolGuide）走 cache、动态部分（sessionContext）每轮变。

skillsContext 属于**中等稳定**——skill 内容不常变、但 activeSkills set 会变。放在 memory 之后 / rag 之前的中间段、跟其他"启动加载"的内容一起、cache 友好度最佳。

**② 为什么用 `PipeFn` 而不是 `SegmentFn`？**

对比 [prompt-pipes.ts 里的注释](../src/context/prompt-pipes.ts)：

> - `segments.ts` — 只依赖 PromptContext 里的数据
> - `prompt-pipes.ts` — 依赖外部组件（闭包捕获）

skillLoader 是**启动时创建的组件、不放在 PromptContext 里**——放进 PromptContext 会让每轮 pipe 都得拿到 loader、耦合太重。用闭包捕获 loader 更干净。

## 6. `when_to_use`：本项目为什么保留

**Claude Code 原生只有 `name` + `description`**——"何时使用"就写在 description 本身里（`Use when reviewing code before merge`）。

**这个项目**引入了独立的 `when_to_use` 字段——教学 trade-off。

### 一开始想去掉

跟 Claude Code 对齐、只保留两个字段、少一个概念。清爽。

### 但保留有两个理由

**① 教学上"是什么/何时用"分开写更清晰**

- `description: 按项目约束严格审查代码变更` —— 说清"是什么"
- `when_to_use: 用户说"review"、"审代码"、或想合并 PR 之前` —— 说清"何时用"

初学者看到两个字段能立刻理解**两种信息的分工**——"这是什么能力"和"什么时候该调它"。合成一个字段虽然简洁、但学习曲线陡一些。

**② 未激活 skill 的展示更结构化**

`buildPromptSection` 里未激活 skill 显示为：

```
  code-review — 按项目约束严格审查代码变更（适用场景: 用户说"review"、想合并 PR 之前）
```

description 讲能力、when_to_use 讲触发时机——**Agent 挑 skill 时能看到更明确的匹配线索**。

### 兼容两种写法

parseFrontmatter 里同时接受 `when_to_use`（snake_case、Claude Code 风格）和 `whenToUse`（camelCase、JS 常见）——作者用哪个都行。

```ts
const whenToUse = meta.when_to_use || meta.whenToUse;
```

**这个 trade-off 的诚实结论**：**如果不做教学产品、直接对齐 Claude Code、去掉这个字段更省事**。教学场景多一个字段换更清晰的语义划分、划算。

## 7. 已知的坑与后续方向

### 7.1 frontmatter 解析太土

现在的 `parseFrontmatter` 只处理最简单的 `key: value`——不支持：

- 多行字符串（`description: >` 换行）
- 数组（`tags: [a, b, c]`）
- 引号嵌套

生产建议直接换 [gray-matter](https://github.com/jonschlinkert/gray-matter)。当前实现是"够跑就行"、优先把系统骨架跑起来。

### 7.2 没有 skill 组合 / 依赖

如果 code-review skill 想调 commit skill 呢？现在只能在 body 里说"完成后建议用户跑 `/commit`"——**Agent 得手动激活**。

生态里有些方案做了 skill dependencies（`depends_on: [commit]` 自动激活链）——**我们没做**、原因是激活链会让 SYSTEM 意外膨胀、可控性下降。要做也是先加"**软推荐**"（body 里的自然语言提示）、不做"**硬依赖**"。

### 7.3 快捷命令的 skill 名冲突

如果 skill 叫 `memory` / `dream`、`/memory` 会被 skillShortcutHandler 抢吗？

不会——`known` 列表把这些排除掉了。但**如果新增 slash 命令没更新 known**、就会出隐性 bug。

**改进方向**：把 known 列表变成"从 dispatcher 反查"——问 dispatcher 里有哪些前缀已经注册、自动排除。当前是硬编码、能跑但脆。

### 7.4 skill 加载没有热更新

改了 SKILL.md、得重启 REPL 才生效——因为 `loader.load()` 只在启动时调。

生产可以：

- 加 `/skill reload` 命令手动触发
- 用 chokidar 监听 `.skills/` 目录、自动 reload

当前不做——**开发心智：改完 skill 立刻能试**是重要，但重启也就两秒的事、优先级不高。

### 7.5 没有跨项目共享 skill

`.skills/` 是**项目本地**目录——`/Users/xxx/other-project/` 用不到这里的 code-review。

Claude Code 生态有两层：**项目 skill**（`.claude/skills/`）+ **全局 skill**（`~/.claude/skills/`）。**当前项目只做了项目 skill**、全局层没做。

要做也不复杂——loader 里加个 `globalDir`、`load()` 时先扫 global 再扫 project、后者覆盖前者。**没做的原因**：项目本地就够展示核心机制、跨项目共享是运维层的事、跟核心设计无关。

### 7.6 没有 skill 评估

一个 skill 好不好用、现在只能靠 review body 内容判断。Anthropic 内部有 `claude plugin eval`——跑一批测试 prompt、看 skill 激活后能不能按预期完成任务。

**这是生产级 skill 系统跟教学项目的最大差距**——skill 会随代码演化而漂、没有 eval 就没法防漂。演进方向明确、但工作量大、不在当前范围。

---

**回顾**：Skill 系统跟前面的所有系统共享同一个模式——**渐进式加载 + Prompt Pipe 注入**：

- 索引在 SYSTEM 里（`可用的 Skills` 列表）
- 完整内容按需激活（skill_load 工具 / `/skill load` 命令 / `/<name>` 快捷）
- 辅助文件用现成的 read_file 工具读

**核心洞察**：一旦你有了"轻索引 + 重按需"这个模式、给 Agent 装各种能力就变成填空——Tool、Memory、RAG、Skill 都是同一套骨架的不同肉。这是这个项目最想传递的东西之一。
