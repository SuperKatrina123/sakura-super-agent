import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPClientLike } from '../tool-registry.ts';

// 官方 SDK 版本的 MCP client——生产环境推荐用这个
// 跟手写 client.ts 相比，SDK 帮你干了：
//   - 握手时序（initialize + notifications/initialized 自动串好）
//   - JSON-RPC id 分配 / 响应匹配 / 请求超时
//   - 协议版本自动协商（不用硬编码 protocolVersion）
//   - 更精细的错误分类（transport 错误 / 协议错误 / 应用错误）
//   - Zod schema 校验（response 结构不合 spec 会显式抛错，而不是静默错乱）
//
// 手写版本保留在 client.ts——是教学载体，说明"SDK 内部到底在做什么"
export class SDKMCPClient implements MCPClientLike {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private serverName: string;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    this.serverName = args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server';
  }

  async connect(): Promise<void> {
    // stderr: 'pipe' 让 SDK 把子进程的 stderr 通过 transport.stderr 暴露出来
    // 默认是 'inherit'——直接透传到父进程 stderr，也能看到日志但没法加前缀
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: { ...process.env, ...this.env } as Record<string, string>,
      stderr: 'pipe',
    });

    this.transport.stderr?.on('data', (chunk) => {
      process.stderr.write(`  [${this.serverName} stderr] ${chunk}`);
    });

    this.client = new Client(
      { name: 'super-agent', version: '0.5.0' },
      { capabilities: {} },
    );

    // 一行搞定 initialize + notifications/initialized——手写版本要 10 行
    await this.client.connect(this.transport);
  }

  async listTools() {
    if (!this.client) throw new Error('SDKMCPClient: not connected');
    const result = await this.client.listTools();
    // SDK 返回类型跟 spec 完全对齐，直接透传即可
    // 但要收窄到 MCPClientLike 的契约（inputSchema 强制成 Record<string, unknown>）
    return result.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error('SDKMCPClient: not connected');
    const result = await this.client.callTool({ name, arguments: args });

    // content 是数组，可能有多段——按 spec 只取 text 类型
    // isError 是应用层错误标志（跟 JSON-RPC error 不同），SDK 保留原样
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const texts = content.filter(c => c.type === 'text' && c.text).map(c => c.text!);
    return texts.join('\n') || '(无返回内容)';
  }

  async close(): Promise<void> {
    // Protocol.close() 会级联关闭 transport、清理 pending requests——比手写 client.kill() 干净
    if (this.client) await this.client.close();
    this.client = null;
    this.transport = null;
  }
}
