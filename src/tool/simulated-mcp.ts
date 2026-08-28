import type { ToolDefinition } from '../tool-registry.ts';

// 模拟制造环境：额外注入 11 个 MCP 工具，把总数推到 49
// 目的是复现"工具太多 → 模型选择准确率下降 + 上下文膨胀"的真实场景
//
// 所有工具都：
//   - shouldDefer: true    → 默认不喂给模型，只有 ToolSearch + ToolLoad 才激活
//   - searchHint: "..."    → 额外的检索关键词，帮 BM25 命中
//   - execute 返回带 Mock banner 的假数据 → 避免被误当真数据
//
// 覆盖三个高频领域：Notion（知识库）、Browser（浏览器自动化）、Supabase（数据库）
// 都是当下真实 MCP 生态里的热门 server

const MOCK_BANNER = '[Mock MCP] 演示预设数据，非真实 API 返回：\n';

function mock(payload: unknown): string {
  return MOCK_BANNER + (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

export const simulatedMcpTools: ToolDefinition[] = [
  // ── Notion（3 个）─────────────────────────────────────
  {
    name: 'mcp__notion__search_pages',
    description: '[MCP:notion] 搜索 Notion 页面',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'notion search pages documents 笔记 知识库',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query }: { query: string }) => mock([
      { title: `Mock: ${query} 相关页面 A`, id: 'page-001', last_edited: '2026-08-20' },
      { title: `Mock: ${query} 相关页面 B`, id: 'page-002', last_edited: '2026-08-15' },
    ]),
  },
  {
    name: 'mcp__notion__create_page',
    description: '[MCP:notion] 在指定数据库中创建新的 Notion 页面',
    parameters: {
      type: 'object',
      properties: {
        database_id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['database_id', 'title'],
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'notion create new page write document 新建 记录',
    isConcurrencySafe: true,
    isReadOnly: false,
    execute: async ({ title }: { title: string }) => mock(`已创建页面：${title}（id: page-mock-${Date.now()}）`),
  },
  {
    name: 'mcp__notion__list_databases',
    description: '[MCP:notion] 列出工作区所有可访问的 Notion 数据库',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    shouldDefer: true,
    searchHint: 'notion list databases workspace 数据库 列表',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async () => mock([
      { title: '产品需求库', id: 'db-prd' },
      { title: '技术文档库', id: 'db-tech' },
      { title: '会议记录库', id: 'db-meeting' },
    ]),
  },

  // ── Browser（5 个）────────────────────────────────────
  {
    name: 'mcp__browser__navigate',
    description: '[MCP:browser] 让浏览器导航到指定 URL',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'browser navigate goto url visit 打开 网页',
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ url }: { url: string }) => mock(`已导航到 ${url}（页面加载完成）`),
  },
  {
    name: 'mcp__browser__screenshot',
    description: '[MCP:browser] 截取当前浏览器页面的屏幕截图',
    parameters: {
      type: 'object',
      properties: { full_page: { type: 'boolean' } },
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'browser screenshot capture image 截图 屏幕',
    isConcurrencySafe: false,
    isReadOnly: true,
    execute: async () => mock('已保存截图：screenshot-mock.png（1280x720）'),
  },
  {
    name: 'mcp__browser__click',
    description: '[MCP:browser] 点击浏览器页面上匹配 CSS 选择器的元素',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'browser click element button link 点击 按钮',
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ selector }: { selector: string }) => mock(`已点击元素：${selector}`),
  },
  {
    name: 'mcp__browser__fill',
    description: '[MCP:browser] 向指定输入框填写文本内容',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['selector', 'value'],
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'browser fill input form text 输入 表单',
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ selector, value }: { selector: string; value: string }) => mock(`已向 ${selector} 填入：${value}`),
  },
  {
    name: 'mcp__browser__get_text',
    description: '[MCP:browser] 读取匹配选择器的元素文本内容',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'browser get text content read extract 读取 文本',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ selector }: { selector: string }) => mock(`${selector} 的文本："这是一段模拟的页面文本内容"`),
  },

  // ── Supabase（3 个）───────────────────────────────────
  {
    name: 'mcp__supabase__query',
    description: '[MCP:supabase] 执行 SQL 查询语句并返回结果集',
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'supabase sql query database postgres 查询 数据库',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ sql }: { sql: string }) => mock([
      { note: `SQL: ${sql}` },
      { id: 1, name: 'Mock Row A' },
      { id: 2, name: 'Mock Row B' },
    ]),
  },
  {
    name: 'mcp__supabase__list_tables',
    description: '[MCP:supabase] 列出当前数据库所有的表',
    parameters: {
      type: 'object',
      properties: { schema: { type: 'string' } },
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'supabase list tables schema 表 数据库结构',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async () => mock(['users', 'posts', 'comments', 'sessions']),
  },
  {
    name: 'mcp__supabase__describe_table',
    description: '[MCP:supabase] 查看指定表的 schema 结构（字段名、类型、约束）',
    parameters: {
      type: 'object',
      properties: { table: { type: 'string' } },
      required: ['table'],
      additionalProperties: false,
    },
    shouldDefer: true,
    searchHint: 'supabase describe table schema columns 表结构 字段',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ table }: { table: string }) => mock({
      table,
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'created_at', type: 'timestamptz', nullable: false },
        { name: 'name', type: 'text', nullable: true },
      ],
    }),
  },
];
