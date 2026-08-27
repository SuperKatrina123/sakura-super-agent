import type { MCPClientLike } from '../tool-registry.ts';

// Mock MCP：没有 GITHUB_PERSONAL_ACCESS_TOKEN 或 spawn 失败时降级用
// 装成一个迷你 GitHub server——返回预设数据，让 Agent Loop 能端到端跑通
// 生产上肯定不用；调试和演示 MCP 注册链路很方便
export class MockMCPClient implements MCPClientLike {
  async connect(): Promise<void> {
    // no-op：Mock 不需要启子进程
  }

  async close(): Promise<void> {
    // no-op
  }

  async listTools() {
    return [
      {
        name: 'list_issues',
        description: '列出指定仓库的 issue（Mock 数据）',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '仓库拥有者' },
            repo: { type: 'string', description: '仓库名' },
          },
          required: ['owner', 'repo'],
          additionalProperties: false,
        },
      },
      {
        name: 'search_repositories',
        description: '搜索 GitHub 仓库（Mock 数据）',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // 主动标记 Mock——避免模型/用户把预设数据当真实抓取结果
    const banner = '[Mock MCP] 以下是演示预设数据，非真实 GitHub API 返回：\n\n';

    if (name === 'list_issues') {
      const { owner, repo } = args as { owner: string; repo: string };
      return banner + [
        `${owner}/${repo} 的开放 issue：`,
        '#42  修复登录页在 Safari 上的显示问题（open, 2 comments）',
        '#39  文档：补充 MCP 集成说明（open, 5 comments）',
        '#37  性能：Agent Loop 内存占用优化（open, 12 comments）',
      ].join('\n');
    }

    if (name === 'search_repositories') {
      const { query } = args as { query: string };
      return banner + [
        `关键词 "${query}" 的搜索结果：`,
        '1. modelcontextprotocol/servers — 官方 MCP server 集合（★ 8.2k）',
        '2. anthropics/claude-code — Claude Code CLI（★ 24k）',
        '3. sakura-agent/super-agent — 演示项目（★ 128）',
      ].join('\n');
    }

    return `[Mock MCP] 未知工具: ${name}`;
  }
}
