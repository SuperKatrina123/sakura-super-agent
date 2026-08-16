import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { ToolDefinition } from '../tool-registry.ts';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

// 模拟真实 I/O 延迟：让并发窗口可见（配合 `测试并发` 观察读写锁）。测完可删或调回 0
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const MOCK_IO_DELAY = 300;

export const weatherTool: ToolDefinition = {
    name: 'get_weather',
    description: '查询指定城市的天气信息',
    parameters: {
        type: 'object',
        properties: {
        city: { type: 'string', description: '城市名称，如"北京"、"上海"' },
        },
        required: ['city'],
        additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
        const data: Record<string, string> = {
        '北京': '晴，15-25°C，东南风 2 级',
        '上海': '多云，18-22°C，西南风 3 级',
        '深圳': '阵雨，22-28°C，南风 2 级',
        };
    return data[city] || `${city}：暂无数据`;
  },
};

export const calculatorTool: ToolDefinition = {
    name: 'calculator',
    description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
    parameters: {
        type: 'object',
        properties: {
        expression: { type: 'string', description: '数学表达式，如 "2 + 3 * 4"' },
        },
        required: ['expression'],
        additionalProperties: false,
    },
    execute: async ({ expression }: { expression: string }) => {
        try {
        // 生产环境不要用 eval，这里纯粹为了演示
        const result = new Function(`return ${expression}`)();
        return `${expression} = ${result}`;
        } catch {
        return `无法计算: ${expression}`;
        }
    },
};

export const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: '读取指定路径的文件内容',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    // 这就是为什么 Anthropic 在 Context Engineering 博客 里把「工具结果管理」列为 Agent 开发的核心挑战之一。
    maxResultChars: 500,  // 演示用，生产环境通常 50000+
    execute: async ({ path }: { path: string }) => {
        await sleep(MOCK_IO_DELAY);   // 模拟真实文件读取延迟，让并发窗口可见
        return readFileSync(resolve(path), 'utf-8');
    },
};

export const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: '写入内容到指定文件',
    parameters: {
        type: 'object',
        properties: {
        path: { type: 'string', description: '文件路径' },
            content: { type: 'string', description: '要写入的内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
    },
    isConcurrencySafe: false,  // 写操作不能并行
    isReadOnly: false,
    execute: async ({ path, content }: { path: string; content: string }) => {
        await sleep(MOCK_IO_DELAY);
        writeFileSync(resolve(path), content, 'utf-8');
        return `已写入 ${content.length} 字符到 ${path}`;
    },
};

export const listDirectoryTool: ToolDefinition = {
    name: 'list_directory',
    description: '列出指定目录下的文件和子目录',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '目录路径，默认为当前目录' },
        },
        required: [],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ path = '.' }: { path?: string }) => {
        await sleep(MOCK_IO_DELAY);
        const resolved = resolve(path);
        return readdirSync(resolved).map(name => {
        const stat = statSync(join(resolved, name));
        return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`;
        }).join('\n');
    },
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: '精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ path, old_string, new_string }) => {
    const resolved = resolve(path);
    if (!existsSync(resolved)) return `文件不存在: ${path}`;

    const content = readFileSync(resolved, 'utf-8');
    const count = content.split(old_string).length - 1;

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
    }

    const updated = content.replace(old_string, new_string);
    writeFileSync(resolved, updated, 'utf-8');
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
  },
};

export const globTool: ToolDefinition = {
  name: 'glob',
  description: '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
    const start = resolve(path);
    if (!existsSync(start)) return `路径不存在: ${path}`;
    if (!statSync(start).isDirectory()) return `路径不是目录: ${path}`;

    const segments = pattern.split('/').filter(seg => seg !== '');
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
    const MAX_RESULTS = 100;
    const results: string[] = [];
    let truncated = false;

    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 把「*」翻译成正则的单层通配（不跨 /），「**」单独处理
    const segToRegex = (seg: string) => new RegExp(`^${seg.split('*').map(escapeRe).join('[^/]*')}$`);

    const walk = (dir: string, depth: number) => {
      if (results.length >= MAX_RESULTS) { truncated = true; return; }
      if (depth === segments.length) {           // 模式消费完了，命中
        results.push(relative(start, dir) || '.');
        return;
      }
      const seg = segments[depth];
      if (seg === '**') {
        walk(dir, depth + 1);                    // ** 匹配零层目录
        if (results.length >= MAX_RESULTS) { truncated = true; return; }
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
          walk(join(dir, entry.name), depth);    // ** 匹配一层及以上，深度不变继续吃**
        }
        return;
      }
      const re = segToRegex(seg);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (re.test(entry.name)) walk(join(dir, entry.name), depth + 1);
      }
    };

    walk(start, 0);
    const body = results.join('\n') || '(无匹配)';
    return truncated ? `${body}\n[已达 ${MAX_RESULTS} 条上限，结果被截断]` : body;
  },
};

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return `无效的正则表达式: ${pattern}`;
    }

    const start = resolve(path);
    if (!existsSync(start)) return `路径不存在: ${path}`;

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
    const MAX_MATCHES = 50;
    const MAX_FILE_SIZE = 1024 * 1024;   // 超过 1MB 的文件跳过
    const MAX_LINE_LEN = 200;            // 单行过长截断显示，防止压缩文件撑爆结果
    const matches: string[] = [];
    let truncated = false;

    const grepFile = (file: string) => {
      if (matches.length >= MAX_MATCHES) { truncated = true; return; }
      if (statSync(file).size > MAX_FILE_SIZE) return;
      const buf = readFileSync(file);
      if (buf.subarray(0, 8192).includes(0)) return;   // 前 8KB 含空字节 → 二进制，跳过
      const rel = relative(start, file) || path || file;   // 单文件搜索时 relative 为空，退回用原路径
      const lines = buf.toString('utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_MATCHES) { truncated = true; return; }
        re.lastIndex = 0;                              // 兼容带 g 标志的正则，避免 lastIndex 状态泄漏
        if (!re.test(lines[i])) continue;
        const shown = lines[i].length > MAX_LINE_LEN ? lines[i].slice(0, MAX_LINE_LEN) + '…' : lines[i];
        matches.push(`${rel}:${i + 1}: ${shown}`);
      }
    };

    const walk = (dir: string) => {
      if (matches.length >= MAX_MATCHES) { truncated = true; return; }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= MAX_MATCHES) { truncated = true; return; }
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else if (entry.isFile()) {
          grepFile(join(dir, entry.name));
        }
      }
    };

    if (statSync(start).isDirectory()) walk(start);
    else grepFile(start);

    const body = matches.join('\n') || '(无匹配)';
    return truncated ? `${body}\n[已达 ${MAX_MATCHES} 条上限，结果被截断]` : body;
  },
};


export const bashTool: ToolDefinition = {
  name: 'bash',
  description: '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }) => {
    // 先检测环境是否支持 child_process
    try {
      execSync('echo test', { stdio: 'ignore' });
    } catch {
      return `[bash 不可用] 当前环境不支持 shell 命令。本地终端运行可使用。`;
    }

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 10000,  // 10 秒超时
        maxBuffer: 1024 * 1024,
      });
      return output || '(命令执行成功，无输出)';
    } catch (err: any) {
      return `命令执行失败 (exit ${err.status || 1}):\n${err.stderr || err.message}`;
    }
  },
};

const MOCK_PAGES: Record<string, string> = {
  'https://esm.sh': `esm.sh - 一个免费的 ES module CDN...`,
  'https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling': `AI SDK Core - Tools and Tool Calling
工具是模型可以决定调用的函数。一个工具由三部分组成：
- description：告诉模型何时使用这个工具
- inputSchema：通过 Zod 或 JSON Schema 定义参数
- execute：实际在服务端运行的函数...`,
  // ... 更多预定义页面
};

export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,    // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  maxResultChars: 1500,        // 网页通常很长，截断兜底
  execute: async ({ url }: { url: string }) => {
    for (const key of Object.keys(MOCK_PAGES)) {
      if (url.startsWith(key)) return MOCK_PAGES[key];
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return `请求失败：HTTP ${res.status}`;
      const html = await res.text();
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '页面无文本内容';
    } catch (err: any) {
      return `抓取失败：${err.message}`;
    }
  },
};

let previewServer: Server | null = null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',  // 让浏览器把 .tsx 当 JS 加载
  '.ts': 'application/javascript; charset=utf-8',
  // ...
};

export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: { port: { type: 'number' } },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`;
    const root = resolve('app');
    if (!existsSync(root)) return '错误：app/ 目录不存在';

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split('?')[0] || '/').replace(/\/$/, '/index.html');
      const filePath = join(root, urlPath === '/' ? '/index.html' : urlPath);
      try {
        if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
        // 先读文件再写头：读不到直接走 404，避免先发 200 后 readFileSync 抛错
        const body = readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(body);
      } catch {
        // headersSent 兜底：万一别处已写过头，不能再 writeHead，否则 ERR_HTTP_HEADERS_SENT 崩掉整个服务
        if (!res.headersSent) { res.writeHead(404); res.end('Not Found'); return; }
        res.end();
      }
    });

    return new Promise<string>((resolve) => {
      previewServer!.listen(port, () => {
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}`);
      });
    });
  },
};



export const allTools: ToolDefinition[] = [
    weatherTool, calculatorTool, readFileTool, 
    writeFileTool, listDirectoryTool, editFileTool,
    bashTool, grepTool, globTool,
    fetchUrlTool, startPreviewTool
];
