import { jsonSchema } from 'ai';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  // ↓ ToolSearch 相关的两个字段（详见 docs/tool-search-design.md）
  // shouldDefer: 默认不加载给模型看，只有 ToolSearch 命中后 ToolLoad 才激活
  // 用于压缩上下文——MCP 工具、低频专业工具都应该 defer
  shouldDefer?: boolean;
  // searchHint: 额外的检索关键词（不进 system prompt，只喂给 BM25）
  // 比如 "notion search pages documents" 能让模型说"查笔记"时也命中 notion 工具
  searchHint?: string;
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
    // 已通过 tool_search 发现的 defer 工具名——下轮 streamText 时它们会进入 tools
    // 语义：System prompt 里已列出所有 defer 工具名，模型主动 pick 名字调 tool_search →
    // 精确匹配后加入这个 Set，从此该工具对模型"可见"（进 prompt + 可调用）
    private discoveredTools = new Set<string>();

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
                // MCP 工具默认 defer——数量不可控、每次都全量喂给模型会污染 system prompt
                // 要立即加载可以注册后手动 `registry.get(name).shouldDefer = false` 覆盖
                shouldDefer: true,
                // hint = serverName + toolName + description
                // 让 BM25 能通过 server 分类（"github"）、原名（"create_issue"）、语义描述三条路都找到
                searchHint: `${serverName} ${tool.name} ${tool.description}`,
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

    // 精确名字匹配——支持逗号分隔一次查多个工具
    // 为什么精确匹配而不是模糊搜索：system prompt 已经把所有 defer 工具的名字告诉了模型
    // 模型看到 "mcp__github__list_issues" 就直接传这个名字过来，不需要模糊+打分
    // 精确匹配零误召回、零依赖、可预测
    searchTools(query: string): ToolDefinition[] {
        const q = query.trim();
        const names = q.includes(',')
            ? q.split(',').map(n => n.trim()).filter(Boolean)
            : [q];

        const results: ToolDefinition[] = [];
        for (const name of names) {
            const tool = this.tools.get(name);
            // tool_search 本身不能被"发现"——避免模型递归搜索自己
            if (tool && tool.name !== 'tool_search') {
                results.push(tool);
                this.discoveredTools.add(tool.name);
            }
        }
        return results;
    }

    // 当前对模型可见的工具集：eager + 已发现的 defer + tool_search 自身
    // toAISDKFormat 只序列化这里返回的工具，defer 工具的 schema 不进 prompt
    getActiveTools(): ToolDefinition[] {
        return this.getAll().filter(tool => {
            if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) return false;
            return true;
        });
    }

    // 返回当前未发现的 defer 工具列表（原始数据，不做格式化）
    // 让调用方（PromptBuilder segment）自己决定怎么呈现——registry 只提供数据
    getDeferredTools(): Array<{ name: string; hint?: string }> {
        return this.getAll()
            .filter(t => t.shouldDefer && !this.discoveredTools.has(t.name))
            .map(t => ({ name: t.name, hint: t.searchHint }));
    }

    // @deprecated 用 getDeferredTools() + PromptBuilder segment 代替
    // 保留是因为 index.ts 里的动态 SYSTEM 拼接过渡期还在用；接完 pipe 后可以删
    // 生成挂到 system prompt 尾巴的"隐藏工具目录"
    // 这是 ToolSearch 模式能工作的关键：模型必须"知道有哪些能力可用"，否则永远不会想到去搜
    // 只放 name + hint，不放完整 schema——这个列表本身也要省 token
    getDeferredToolSummary(): string {
        const deferred = this.getAll().filter(t => t.shouldDefer && !this.discoveredTools.has(t.name));
        if (deferred.length === 0) return '';

        const lines = deferred.map(t => {
            const hint = t.searchHint ? ` — ${t.searchHint}` : '';
            return `  - ${t.name}${hint}`;
        });
        return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`;
    }

    // 粗略的 token 估算：字符数 / 4（GPT tokenizer 的常见近似）
    // 用来直观展示 defer 机制到底省了多少 prompt 开销
    countTokenEstimate(): { active: number; deferred: number; total: number } {
        let active = 0;
        let deferred = 0;
        for (const tool of this.tools.values()) {
            const schemaSize = JSON.stringify({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }).length;
            const tokens = Math.ceil(schemaSize / 4);
            if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) deferred += tokens;
            else active += tokens;
        }
        return { active, deferred, total: active + deferred };
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
        // 只序列化 active 工具——defer 且未发现的直接跳过，schema 不进 prompt
        for (const tool of this.getActiveTools()) {
            const name = tool.name;
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
                    // console.log(`  [并发] ${name} 获取共享锁`);
                } else {
                    await registry.acquireExclusive();
                    // console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
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
