import { jsonSchema } from 'ai';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
}

// MCP client 的最小契约——用结构类型避免 tool-registry 反向依赖 mcp/ 目录
// 只要一个对象暴露这四个方法，就能被 registerMCPServer 接收（真实 client 和 mock 都能塞进来）
export interface MCPClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;
const MAX_TOOL_NAME_LEN = 64;   // OpenAI / Anthropic tool name 上限

export class ToolRegistry {
    private tools = new Map<string, ToolDefinition>();
    private mcpClients: MCPClientLike[] = [];

    // 三个状态变量构成一把读写锁
    private exclusiveLock = false;          // 当前是否有独占锁持有者
    private concurrentCount = 0;            // 当前共享锁持有数
    private waitQueue: Array<() => void> = [];  // 阻塞等待中的 resolve 函数

    register(...tools: ToolDefinition[]): void {
        for (const tool of tools) {
            this.tools.set(tool.name, tool);
        }
    }

    // 挂载一个 MCP server 的所有工具，加 mcp__<serverName>__ 前缀避免冲突
    // 顺序：connect → listTools → 逐个前缀化后 register
    // 每个工具的 execute 是闭包，调用时通过 JSON-RPC 转发给 server
    // 返回注册成功的前缀名列表（超长/已存在的会被跳过）
    async registerMCPServer(serverName: string, client: MCPClientLike): Promise<string[]> {
        await client.connect();
        this.mcpClients.push(client);

        const tools = await client.listTools();
        const registered: string[] = [];

        for (const tool of tools) {
            const prefixed = `mcp__${serverName}__${tool.name}`;

            if (prefixed.length > MAX_TOOL_NAME_LEN) {
                console.warn(`  [MCP] 跳过 ${prefixed}：名称超过 ${MAX_TOOL_NAME_LEN} 字符上限`);
                continue;
            }
            // 同名跳过——别静默覆盖已经存在的工具（本地或前一个 server 注册的同名）
            if (this.tools.has(prefixed)) {
                console.warn(`  [MCP] 跳过 ${prefixed}：同名工具已存在`);
                continue;
            }

            // 闭包锁定 client + 原始 tool.name——前缀只在本地生效，发给 server 时要脱掉
            const toolClient = client;
            const originalName = tool.name;

            this.register({
                name: prefixed,
                description: `[MCP:${serverName}] ${tool.description}`,
                parameters: tool.inputSchema,
                // MCP 是跨进程调用，本地读写锁保护不到 server 那边——默认按共享锁走
                // 工具是黑盒（可能改远端状态），isReadOnly 保守设 false
                isConcurrencySafe: true,
                isReadOnly: false,
                maxResultChars: DEFAULT_MAX_RESULT_CHARS,
                execute: async (input: any) => toolClient.callTool(originalName, input),
            });
            registered.push(prefixed);
        }

        return registered;
    }

    // 关闭所有已注册的 MCP client 子进程——应用退出前调用，避免留下孤儿进程
    async closeAllMCP(): Promise<void> {
        for (const client of this.mcpClients) {
            await client.close();
        }
        this.mcpClients = [];
    }

    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    getAll(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
    private async acquireConcurrent(): Promise<void> {
        while (this.exclusiveLock) {
            await new Promise<void>(r => this.waitQueue.push(r));
        }
        this.concurrentCount++;
    }

    private releaseConcurrent(): void {
        this.concurrentCount--;
        if (this.concurrentCount === 0) this.drainQueue();
    }

    // 获取独占锁：必须等所有共享锁释放、且没人持独占
    private async acquireExclusive(): Promise<void> {
        while (this.exclusiveLock || this.concurrentCount > 0) {
        await new Promise<void>(r => this.waitQueue.push(r));
        }
        this.exclusiveLock = true;
    }

    private releaseExclusive(): void {
        this.exclusiveLock = false;
        this.drainQueue();
    }

    // 锁释放时把等待队列全唤醒，让它们重新去抢锁
    private drainQueue(): void {
        const waiting = this.waitQueue.splice(0);
        for (const resolve of waiting) resolve();
    }

    toAISDKFormat(): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [name, tool] of this.tools) {
            const maxChars = tool.maxResultChars;
            const executeFn = tool.execute;
            const isSafe = tool.isConcurrencySafe === true;
            const registry = this;
            result[name] = {
                description: tool.description,
                inputSchema: jsonSchema(tool.parameters as any),
                execute: async (input: any) => {
                // 在真正执行前先按 isConcurrencySafe 获取锁
                if (isSafe) {
                    await registry.acquireConcurrent();
                    console.log(`  [并发] ${name} 获取共享锁`);
                } else {
                    await registry.acquireExclusive();
                    console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
                }
                try {
                    const raw = await executeFn(input);
                    const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
                    return truncateResult(text, maxChars);
                } finally {
                    // 不管成功还是抛异常，锁都要释放
                    if (isSafe) {
                    registry.releaseConcurrent();
                    } else {
                    registry.releaseExclusive();
                    }
                }
                },
            };
        }
        return result;
    }
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
    if (text.length <= maxChars) return text;

    const headSize = Math.floor(maxChars * 0.6);
    const tailSize = maxChars - headSize;
    const head = text.slice(0, headSize);
    const tail = text.slice(-tailSize);
    const dropped = text.length - headSize - tailSize;

    return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
