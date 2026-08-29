# Sakura Super Agent — 项目约束

这个项目在探索"从零构建 Agent"的实现细节。以下约束在**这个项目里必须遵守**，因为 AI 在过去的对话里踩过对应的坑。

## 🔒 前端 CDN 必须锁精确版本

**触发场景**：任何时候写 `unpkg.com` / `esm.sh` / `cdn.jsdelivr.net` 的 URL。

**规则**：URL 里必须带**精确版本号**，禁止用 `latest`、`@18`（这只是 major）、或省略版本号。

```html
<!-- ❌ 错的 -->
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://esm.sh/react@18"></script>

<!-- ✅ 对的 -->
<script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script>
<script src="https://esm.sh/react@18.3.1"></script>
```

**理由**：CDN 的 `latest` / major-only 是移动目标——一次破坏性升级就让整个 demo 崩掉。已经踩过一次：Babel 8 移除 `allExtensions` / `isTSX` 选项，unpkg 的 latest 自动升到 8.x，`.tsx` 加载直接报错。

## 🔍 写前端代码前必须查当前文档

**触发场景**：写 Babel / webpack / Vite / React / Vue 等前端框架/工具的**配置代码**（不是业务代码），涉及具体 API 或选项名。

**规则**：**先用 WebFetch 拉一下官方最新文档，或 WebSearch 一下当前版本行为，再写代码**。禁止凭记忆写配置。

**理由**：AI 知识有截止日期，前端生态更新极快。凭记忆写的配置**看起来合理但可能已经过时**——最难 debug 的错误。

**破例**：极短的业务代码（比如"写一个 useState 计数器"）不用查，只有涉及**版本敏感的配置项**时才必须查。

## 🛡️ Vibe Coding：加载器必须有页面级错误兜底

**触发场景**：写浏览器内加载 TSX/JSX 的手写 loader（比如 `app/index.html` 里那段）。

**规则**：整个 loader 用 try/catch 包住，捕获后**把 err.message + stack 打到 DOM 上**，绝对不能让浏览器白屏。

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

**理由**：白屏无法定位问题、无法 debug、用户体验极差。哪怕是很粗糙的错误显示，也比白屏好 100 倍。

## 🧪 一次改一小步

**触发场景**：涉及"多层依赖 + 首次跑通"的场景（比如手写 loader、跨系统集成、脚手架搭建）。

**规则**：**先写最小可跑版本、跑通、再叠功能**。禁止一次堆 50+ 行的复杂逻辑然后期望一次跑通。

**理由**：一次堆太多逻辑，出错时不知道是哪一层挂了；分层验证能把"故障隔离"变成"故障定位"。

## 📎 遇到 mock 数据要主动说明

**触发场景**：`fetch_url` / `web_search` 等抓取工具返回的内容命中了 MOCK_PAGES 之类的预设字典。

**规则**：模型输出时**主动告诉用户"这个内容是演示预设、不是真实抓取"**，避免用户误以为是真实数据。

**理由**：MOCK_PAGES 是这个项目里给测试用的假数据，AI 拿到后如果没意识到、直接总结，会给用户传递错误信息。

## 🗂️ Vibe Coding 里 app/index.html 是脚手架

**触发场景**：Agent 在 Vibe Coding 场景下生成应用代码。

**规则**：
- **只允许写** `app/App.tsx`、`app/*.tsx`、`app/*.css`
- **绝对不允许写** `app/index.html`（这是预置的加载器脚手架，改了整个应用会跑不起来）
- 写完立即调 `start_preview` 起服务器

## 📚 相关文档

- [docs/code-agent-todo-practice.md](docs/code-agent-todo-practice.md) — 代码分析实践
- [docs/research-agent-practice.md](docs/research-agent-practice.md) — Research Agent 实践
- [docs/vibe-coding-practice.md](docs/vibe-coding-practice.md) — Vibe Coding 实践
- [docs/mcp-integration-practice.md](docs/mcp-integration-practice.md) — MCP 集成实践（stdio 传输、ToolRegistry 融合、三层降级）
- [docs/tool-search-design.md](docs/tool-search-design.md) — ToolSearch 延迟加载（Profile vs Lazy、Prompt Cache 权衡）
- [docs/session-persistence.md](docs/session-persistence.md) — Session 持久化（JSONL、崩溃安全、恢复语义）
- [docs/prompt-pipe-design.md](docs/prompt-pipe-design.md) — Prompt Pipe（模块化 SYSTEM、顺序即 cache 策略）
- [docs/context-compression.md](docs/context-compression.md) — 上下文压缩（Microcompact + Summarization 两层策略）
- [docs/instant-defenses.md](docs/instant-defenses.md) — 零 LLM 防线（TokenTracker + TTL + Truncate 三层协同）
- [docs/cost-visualization.md](docs/cost-visualization.md) — 成本可视化（Cache 三种模式 / `/context` / `/usage` / 31% 命中率的架构分析）
- [docs/deep-research-design.md](docs/deep-research-design.md) — Deep Research 延伸设计
- [docs/agent-loop-protections.md](docs/agent-loop-protections.md) — 三道防线
- [docs/tool-call-concurrency.md](docs/tool-call-concurrency.md) — 工具读写锁
