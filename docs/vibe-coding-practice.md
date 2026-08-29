# Vibe Coding 实践：一句话生成多文件 React 应用

一次完整的 Vibe Coding 端到端实践——从"输入一句话"到"浏览器打开就能跑"。这是三大 Agent 实践的第三个，目的不是产出 React 组件，而是**用一个网页生成场景把 Agent 的多工具串行调用、脚手架与应用代码的分工、浏览器直接跑 TSX 的原理**都跑一遍。

> 前置阅读：[code-agent-todo-practice.md](code-agent-todo-practice.md)（Code Agent 实践）· [research-agent-practice.md](research-agent-practice.md)（Research Agent 实践）· [tool-call-concurrency.md](tool-call-concurrency.md)（工具读写锁）

## 实践目标

用户输入一句话（例如"做一个待办清单的网页应用"），Agent 应该：

1. **只写应用代码**，不动脚手架（`app/index.html` 由模板预置）
2. **拆多文件**（组件、样式、入口分开——演示"多文件应用"）
3. **写完立即调 `start_preview`**，返回可访问 URL
4. **浏览器直接跑**：零安装、零 build、零配置

## 一、浏览器里直接跑 TSX 的原理

预置的 `app/index.html` 是这个 demo 除了 Agent 之外真正的精髓——**没有 webpack、没有 Vite、没有任何 build step，纯静态 HTML 直接把 TSX 在浏览器里跑起来**。

原理分三层：

### 第一层：importmap（浏览器原生支持）

告诉浏览器"`react` 这个 bare specifier 解析到 `https://esm.sh/react@18`"。

```html
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18",
    "react-dom/client": "https://esm.sh/react-dom@18/client"
  }
}
</script>
```

**esm.sh** 能把 npm 包重新打包成 ES module，相当于一个**免构建的 npm 替代**。所以 `import { createRoot } from 'react-dom/client'` 这样的写法在浏览器里能直接跑。

### 第二层：Babel Standalone（浏览器版编译器）

Babel 的浏览器版本，能在运行时把 TSX 代码翻译成浏览器能跑的 ES module：

```html
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
```

TSX 里的 JSX 语法、TypeScript 类型标注，都由它在浏览器里现场编译。

### 第三层：手写的小型加载器

- fetch 一个 `.tsx` 文件
- 用 Babel 编译成 JS
- 处理里面的 `from './X.tsx'` 这类相对路径 import（递归编译被引用的文件）
- 把每个编译结果包成 **Blob URL** 给浏览器加载
- 最后用动态 `import()` 跑入口模块

**这个加载器是"loader"层**——把"多文件 TSX 项目"翻译成"浏览器能加载的 ES module 图"。

## 二、为什么需要模板？为什么不让 Agent 自己生成？

**它是纯基础设施**——每个 Vibe Coding 项目的 bootstrap 都长一样，让模型每次重新生成既慢又不可靠（一个 typo 就让整个 demo 跑不起来）。

**v0、Bolt.new 这些 Vibe Coding 产品的实现方式都是同一套思路**：**固定脚手架 + 模型只负责生成应用代码**。把基础设施和应用代码分开，让模型专注做它擅长的事——根据需求写 React 组件，而不是去维护脚手架。

**整个方案的亮点**：**零安装、零配置、所见即所得**。生成出来的项目用编辑器打开就是几个普通的 `.tsx` 和 `.css` 文件，浏览器直接能跑。

### 脚手架 vs 应用代码的分工

```
app/
├── index.html     ← 预置脚手架（固定内容）：importmap + Babel + loader
├── App.tsx        ← Agent 写：主入口，必须有 createRoot
├── Button.tsx     ← Agent 写：可被 App.tsx import 的组件
└── styles.css     ← Agent 写：样式
```

- **`index.html`（模板）**：三层加载机制 + 固定的 loader 代码 + `<div id="root">`
- **应用代码（Agent 写）**：只关心业务逻辑，不用管 build/依赖/加载

## 三、场景步骤

### Step 0：前置改动

三处：

1. **预置 `app/index.html`**（importmap + Babel + 手写 loader）
2. **修 [src/tools/index.ts](../src/tools/index.ts) 里 MIME 表**：`.tsx` 和 `.ts` 改成 `text/plain`，让 Babel 拿到原文本自己编译（不是让浏览器尝试执行 JSX）
3. **SYSTEM prompt 加 Vibe Coding 引导**：
   - 只能写 `app/*.tsx` 和 `app/*.css`
   - **不要动 `index.html`**
   - `App.tsx` 必须 `createRoot(...).render(...)`
   - 组件间 `import` 必须写全 `.tsx` 后缀（浏览器不做后缀补全）
   - 写完立即调 `start_preview`

### Step 1：一句话触发生成

REPL 输入：

```
做一个待办清单的网页应用
```

真实 DeepSeek 的行为：

```
Step 1:
  [串行] write_file 获取独占锁，等待其他工具完成
  [调用: write_file({"path":"app/styles.css", ...})]
  [结果: 已写入 1386 字符到 app/styles.css]

  [串行] write_file 获取独占锁，等待其他工具完成
  [调用: write_file({"path":"app/Button.tsx", ...})]
  [结果: 已写入 336 字符到 app/Button.tsx]

  [串行] write_file 获取独占锁，等待其他工具完成
  [调用: write_file({"path":"app/App.tsx", ...})]
  [结果: 已写入 1627 字符到 app/App.tsx]

  [串行] start_preview 获取独占锁，等待其他工具完成
  [调用: start_preview({})]
  [结果: ✓ 预览服务器已启动 → http://localhost:8080]

Step 2:
  模型总结：
  搞定！我已经在 app/ 目录下生成了一个待办清单应用：
    - styles.css  样式（紫色渐变背景、卡片式布局）
    - Button.tsx  可复用的按钮组件
    - App.tsx     主应用入口（用 createRoot 渲染到 #root）
  
  模板自带的 app/index.html 是固定的 ESM bootstrap，不需要重新生成。
```

### Step 2：验证浏览器直接跑

打开 `http://localhost:8080`：

- 浏览器请求 `index.html` → 拿到预置模板
- 模板里的 loader 开始工作：fetch `App.tsx` → Babel 编译 → 遇到 `import Button from './Button.tsx'` → 递归 fetch + 编译 → 全部包成 Blob URL → 动态 `import()` 跑入口
- React 从 esm.sh 加载
- 页面渲染出来

**整个过程零构建**——用户看到的是浏览器直接跑的完整 React 应用。

## 四、四次 `[串行]` 是最完美的读写锁演示

看 Step 1 的输出结构：

```
write_file (styles.css) → 独占锁
write_file (Button.tsx) → 等前面完成
write_file (App.tsx)    → 等前面完成
start_preview           → 等所有 write_file 完成
```

**关键**：模型这一步**输出了 4 个 tool-call**（想同时发出去），但因为 `write_file` 和 `start_preview` 都声明 `isConcurrencySafe: false`，Registry 全部按顺序放行。

对比 TODO 场景的 4 个 `read_file` 全部 `[并发]`——**同一个 Agent Loop、同样的 tool-call 数组、完全不同的执行策略**，纯粹取决于工具的声明。这就是"声明即纪律"最完整的演示。

### 为什么写文件必须串行？

想象两个 `write_file` 并发写**同一个文件**——会有竞态条件：

- 进程 A 打开文件、开始写、写到一半
- 进程 B 打开同一个文件、覆盖 A 写了一半的内容
- 最终文件里的内容不完整

即使不写同一个文件，`writeFileSync` 也涉及**系统级 I/O**——某些文件系统（如 macOS 的 APFS）在高并发写入下有性能衰减。**Registry 的保守选择：一律串行**。

### 模型不能被信任判断并发安全

真实模型可能觉得"3 个 write 写 3 个不同文件，应该能并发"——**这判断本身没错**，但 Registry 不信任这个判断。理由：

- 模型可能判断错（比如 3 个 write 路径实际指向同一个文件的软链）
- 模型可能有 bug（比如 args 里的路径拼接错了）
- **一个错误的并发写就是数据损坏**，比"多花 50ms 串行"代价大得多

**Registry 用工具的静态声明兜底**，把并发决策从"模型的运行时判断"移到"工具设计时的静态声明"——这是防御式设计的核心。

## 五、模型主动识别了"哪些文件不该写"

看 Step 2 的输出：

> 模板自带的 app/index.html 是固定的 ESM bootstrap，不需要重新生成。

模型**没有生成 index.html**——它读懂了 SYSTEM 里"不要动 index.html"的约束，还在最后主动说明"为什么没写"。**元认知诚实**又出现了——不是默默跳过，而是明确告诉用户"这个我知道不该写"。

这跟 Research Agent 里的"这俩根本不是同一类东西"是同一种能力——**主动澄清自己的判断**。

## 六、模型自己决定了组件拆分

三个文件的分工是模型自己决定的：

- `styles.css` —— 样式（不是 CSS-in-JS，走独立文件）
- `Button.tsx` —— 可复用组件（演示"多文件"的价值）
- `App.tsx` —— 主入口 + `createRoot`

**你没在 prompt 里说"必须拆一个 Button 组件出来"**。模型自己判断"待办清单里有按钮 → 拆出一个组件更合理 → 演示项目复用性"。

**Button.tsx 大概率只被 App.tsx 用了一次**——纯工程角度这是"过度设计"。但模型知道你的场景是**演示**，做出了合理的**演示性设计**。这个"看场景做设计"的判断本身就是能力体现。

## 注意事项

### ⚠️ 1. `.tsx` 的 MIME type 必须是 `text/plain`

看 [src/tools/index.ts](../src/tools/index.ts) MIME 表：

```ts
'.tsx': 'text/plain; charset=utf-8',
'.ts': 'text/plain; charset=utf-8',
```

**为什么不是 `application/javascript`**：Babel standalone 加载 `.tsx` 时，需要浏览器**把它当纯文本读**（Babel 自己会编译）。如果设成 `application/javascript`，浏览器会**尝试执行**，遇到 `<Button />` 这种 JSX 语法直接 SyntaxError。

**这个坑很隐蔽**——初次跑起来看着都对，直到某个文件里出现 JSX，才炸。

### ⚠️ 2. import 必须写全 `.tsx` 后缀

浏览器不做后缀补全：

```tsx
// ❌ 错的（浏览器 404）
import Button from './Button';

// ✅ 对的
import Button from './Button.tsx';
```

这跟 Node.js 的 CommonJS 完全不同——**浏览器原生 ES module 严格按 URL 加载**，没有 resolver 猜后缀。

**真实模型可能会踩这个坑**——它训练数据里的 React 项目 99% 都是走 build 工具的，习惯性写 `from './Button'`。SYSTEM prompt 里必须明确约束。

### ⚠️ 3. Vibe Coding 是纯串行工具场景

跟 Code Agent（大量并发只读工具）和 Research Agent（fetch_url 并发）不同，Vibe Coding **只写文件、只起服务**，都是串行工具。这意味着：

- **wall-clock 时间受 write_file 顺序限制**：20 个文件的应用大概要 1-2 秒才写完
- **成本无差异**：并发 vs 串行不影响 token 消耗
- **优化方向不在读写锁**：想优化 Vibe Coding 应该优化输出质量（一次写对，不需要 edit_file 迭代）

### ⚠️ 4. 脚手架和应用代码的边界要写死

如果 SYSTEM 里没说"不要动 index.html"，模型有一定概率**重新生成 index.html**——它可能觉得"用户没说不动，我完整生成才规范"。一旦覆盖了预置的 loader，整个应用就跑不起来。

**教训**：涉及"预置基础设施"的场景，SYSTEM prompt 里必须**明确列出哪些文件不能动**，不能靠"惯例"。

### ⚠️ 5. 生成质量取决于模型对无 build 栈的熟悉度

真实模型的训练数据里，React 项目 99% 都是 Vite / Next.js / CRA。它对"esm.sh + Babel standalone + importmap"这套组合的熟悉度不高。

## 真实踩坑复盘

这次实践里 AI 自己踩了三个连环坑，值得单独复盘——**它们不是模型能力问题，是"AI 助手协作"的典型失败模式**。

### 🐛 坑 1：CDN 版本没锁，`@babel/standalone` 自动升到 Babel 8

**现象**：页面显示 `@babel/preset-typescript: The .allExtensions and .isTSX options have been removed`。

**根因**：写 loader 时用了 `https://unpkg.com/@babel/standalone/babel.min.js`（没锁版本），unpkg 默认拿 latest。Babel 8 移除了 `allExtensions` / `isTSX` 选项，用旧写法直接崩。

**AI 犯错模式**：**知识过时 + 没主动验证**。写代码时凭 2024 年记忆里的 Babel 7 配置，没意识到 Babel 8 已经发布。**AI 对"过时了但看起来还合理的知识"特别自信**。

**修复**：
- 短期：改成 Babel 8 兼容的写法（去掉 `allExtensions` / `isTSX`，Babel 8 用 filename 后缀自动识别 JSX）
- 长期：**CDN URL 全部锁精确版本**（`@babel/standalone@7.24.7`、`react@18.3.1`）
- 更长期：写进 [CLAUDE.md](../CLAUDE.md)，让下次 AI 开工前自动读到

**教训**：`unpkg` / `esm.sh` 的 `latest` 是**移动目标**，一次破坏性升级就崩。**这不是 AI 的错，是通用坑**——但 AI 更容易犯，因为它对"锁版本"这件事没直觉。

### 🐛 坑 2：错误兜底救了整个 debug 流程

**现象**：加载失败时，页面上直接显示了完整的错误信息 + stack trace，而不是白屏。

**这不是坑，是这次实践里做对的最重要一件事**：

```javascript
try {
  const entryUrl = await compile('./App.tsx');
  await import(entryUrl);
} catch (err) {
  document.getElementById('root').innerHTML =
    `<pre style="color:#c00;padding:20px;white-space:pre-wrap;font-family:monospace">加载失败：\n${err.message}\n\n${err.stack || ''}</pre>`;
  console.error(err);
}
```

**没有这个兜底的话**：坑 1 就是白屏 → 打开 DevTools → 翻 console → 才能定位到 Babel 报错。有了兜底：一眼看到具体错误。

**教训**：Vibe Coding 的 loader **必须有页面级错误兜底**。白屏是最糟糕的错误状态。

### 🐛 坑 3：CSS import 让 loader 崩了

**现象**：`Failed to resolve module specifier "./styles.css". Invalid relative url or base scheme isn't hierarchical.`

**根因**：loader 的 import 改写正则**没排除非 JS 资源**——它把 `import './styles.css'` 当作模块编译，Blob URL 化后浏览器无法识别。

**AI 犯错模式**：**只考虑了 happy path**。写 loader 时脑子里只想着"处理 `.tsx` 相对路径 import"，完全没想过 `.css` 这类非 JS 资源的场景。

**修复**：**在 Babel 编译前**先剔除 CSS import（编译后 import 格式会变，正则可能失效），编译后再兜底一次跳过 `.css/.json/.svg/.png` 后缀。

**教训**：AI 写复杂 loader / codegen 这类"边界不清晰"的代码时，容易**只覆盖示例场景**。用户跑真实项目一定会出边界情况——写代码时应该主动问自己"如果输入是 X 会怎样？如果输入是 Y 会怎样？"

### 🐛 坑 4：浏览器缓存 + 我急着改代码

**现象**：坑 3 修完，用户看到的还是同样的错误信息。

**根因**：浏览器缓存了旧的 `index.html`。硬刷（Cmd+Shift+R）就好了。

**AI 犯错模式**：**没确认现象就急着改代码**。看到同样的错误信息，我立刻假设"我的正则写错了"，又改了一轮 loader——结果是白改的。

**正确响应应该是**：
1. 先问用户"硬刷过了吗？"
2. 硬刷后如果还错，再动代码

**教训**：**AI 拿到"同样的错误"信号时，第一反应不该是"代码没改对"，而是"用户真的看到了新代码吗？"**。缓存 / 服务重启 / 环境变量刷新，这些都是常见的"看起来没变化"的原因。

**这条比坑 3 重要**——因为 AI 一犯就白花一轮 token + 你的时间。

### 一个共通的教训：AI 需要 "先验证、再动手"

四个坑的根源都指向同一件事：**AI 在"看到问题 → 立刻动手改"这条路径上跑得太快**。CLAUDE.md 里"一次改一小步"、"先查文档"、"先验证现象"这些约束，就是给这个毛病打补丁的。

**用户能做的事**：
- 主动喊"先查一下当前版本"（触发 WebFetch / WebSearch）
- 主动喊"硬刷了/重启了/清缓存了"（排除环境变量）
- 主动喊"先写最小版本跑通"（防止一次堆太多逻辑）

**这些不是照顾 AI，是让 AI 少犯错——你省下的是自己的时间**。

如果不加 SYSTEM 引导，模型很可能生成：

- `import React from 'react'` 后跟 Node.js 风格的 CJS require（浏览器不支持）
- 用了 `useState` 却没 `import { useState } from 'react'`（自动补全通常靠 IDE，浏览器不会）
- 引入了第三方库但没在 importmap 里注册

**SYSTEM prompt 的引导是 Vibe Coding 的关键**——不是可选优化，是必须。

## 关键代码路径

| 关注点 | 文件 |
|---|---|
| REPL 入口、SYSTEM prompt | [src/index.ts](../src/index.ts) |
| Agent Loop while 循环 | [src/agent/loop.ts](../src/agent/loop.ts) |
| write_file / start_preview / MIME 表 | [src/tools/index.ts](../src/tools/index.ts) |
| 读写锁（串行放行）| [src/tools/tool-registry.ts](../src/tools/tool-registry.ts) |
| 预置脚手架 | [app/index.html](../app/index.html) |

## 收获清单

- **脚手架 vs 应用代码的分工是 Vibe Coding 的核心设计**——v0/Bolt.new 都是这个思路，Agent 不该维护基础设施
- **浏览器直接跑 TSX 靠三层原理**：importmap（bare specifier → esm.sh URL）+ Babel Standalone（浏览器版编译器）+ 手写 loader（多文件递归加载）
- **零安装、零配置、所见即所得**——生成的项目就是普通 `.tsx` 和 `.css` 文件，编辑器打开就能改
- **`[串行] × 4` 是读写锁最完美的演示**——同样的 tool-call 数组，跟 Code Agent 场景的 `[并发] × 4` 形成鲜明对比
- **Registry 不信任模型的并发判断**——防御式设计把并发决策从"运行时判断"移到"工具静态声明"
- **模型能看场景做设计**——自己拆 Button 组件、自己判断脚手架不该动，这些都是**演示性设计**判断
- **无 build 栈 + SYSTEM 引导是必须的**——训练数据里 99% 是 Vite 项目，不引导模型会踩 CJS/后缀补全/importmap 各种坑
- **Vibe Coding 场景 wall-clock 时间受串行限制**——但这不是瓶颈，瓶颈在生成质量和 token 消耗

## 三大实践对比

|维度| Code Agent | Research Agent | Vibe Coding |
|---|---|---|---|
| 主工具 | grep + read_file | fetch_url | write_file + start_preview |
| 并发/串行 | 并发只读 | 并发只读 | 强制串行 |
| 输出形态 | 结构化总结（表格 + 优先级） | 对比报告（表格 + 引用） | 多文件应用（可运行代码） |
| 副作用 | 无（只读） | 无（只读） | 有（写文件、起服务）|
| 元认知场景 | 识别 mock 假 TODO | 质疑用户前提 | 识别脚手架不该动 |
| 训练数据熟悉度 | 高 | 高 | 低（无 build 栈少见）|
| SYSTEM 引导必要性 | 低 | 低 | **高（否则会用 Vite）** |

## 下一步实践

三大实践全部跑通。可以继续的方向：

- **Deep Research Agent**（延伸）：从"给 URL"演化到"只给主题词"，加 `web_search` 工具 —— 设计方案见 [deep-research-design.md](deep-research-design.md)
- **Vibe Coding 迭代**：让 Agent 支持"用户看完预览提改动 → 用 edit_file 精确修改"的多轮迭代（真正的 v0 体验）
- **多 Agent 协作**：让"研究员 Agent"和"编码 Agent"配合——先研究待办清单的最佳实践、再生成代码
