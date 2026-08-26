import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { ToolDefinition } from '../tool-registry.ts';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import TurndownService from 'turndown';
import { JSDOM } from 'jsdom';

// HTML → Markdown 转换器：turndown 需要 DOM 环境，用 jsdom 提供
// 单例复用，避免每次 fetch 都重建 turndown 实例
const turndownService = new TurndownService({
    headingStyle: 'atx',         // 用 # 而不是 setext 下划线，输出更紧凑
    codeBlockStyle: 'fenced',    // 用 ``` 而不是四空格缩进
    bulletListMarker: '-',       // 列表用 -，跟 Markdown 主流风格一致
});

function htmlToMarkdown(html: string): string {
    const doc = new JSDOM(html).window.document;
    // 剥掉 script / style / noscript / iframe——正文里没用、还会污染输出
    doc.querySelectorAll('script, style, noscript, iframe').forEach(el => el.remove());
    // 剥掉 img 的 base64 src——data:image 二进制会占几十 KB、对 Agent 完全无用
    doc.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';
        if (src.startsWith('data:')) img.remove();
    });
    return turndownService.turndown(doc.body || doc.documentElement)
        .replace(/^#{1,6}\s*\[?\]?\(?[/#]?\)?\s*$/gm, '')   // 剥掉空标题（如 "# [](/)"）
        .replace(/\n{3,}/g, '\n\n')                           // 多个空行合并成一个
        .trim();
}

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

let previewServer: Server | null = null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  // .tsx/.ts 走 text/plain：让 loader fetch 拿到原文本，Babel 自己编译
  // 如果给 application/javascript，浏览器会尝试执行 <Component /> 这类 JSX → SyntaxError
  '.tsx': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
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



// ── web_search: Tavily（自动挡）+ Serper（手动挡）─────────────
// 两个工具都叫 web_search——对模型透明，通过 pickSearchTool() 二选一注册

export const tavilySearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ query, max_results = 5 }: { query: string; max_results?: number }) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return '[web_search] 未配置 TAVILY_API_KEY，请在 .env 中设置';

    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results,
          include_answer: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

      const data = await res.json() as any;
      const lines: string[] = [];

      if (data.answer) {
        lines.push(`## AI 摘要\n${data.answer}\n`);
      }

      for (const r of data.results || []) {
        lines.push(`### ${r.title}`);
        lines.push(r.url);
        lines.push(r.content || r.snippet || '');
        lines.push('');
      }

      return lines.join('\n') || '没有找到相关结果';
    } catch (err: any) {
      return `[web_search] 请求异常: ${err.message}`;
    }
  },
};

export const serperSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ query, max_results = 5 }: { query: string; max_results?: number }) => {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) return '[web_search] 未配置 SERPER_API_KEY，请在 .env 中设置';

    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: max_results }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

      const data = await res.json() as any;
      const lines: string[] = [];

      if (data.knowledgeGraph) {
        const kg = data.knowledgeGraph;
        lines.push(`## ${kg.title}`);
        if (kg.description) lines.push(kg.description);
        lines.push('');
      }

      for (const r of (data.organic || []).slice(0, max_results)) {
        lines.push(`### ${r.title}`);
        lines.push(r.link);
        lines.push(r.snippet || '');
        lines.push('');
      }

      return lines.join('\n') || '没有找到相关结果';
    } catch (err: any) {
      return `[web_search] 请求异常: ${err.message}`;
    }
  },
};

// 根据环境变量二选一——TAVILY 优先。都没有时也返回 tavily（execute 里会给出"未配置"提示）
export function pickSearchTool(): ToolDefinition {
  if (process.env.TAVILY_API_KEY) return tavilySearchTool;
  if (process.env.SERPER_API_KEY) return serperSearchTool;
  return tavilySearchTool;
}

// ── web_fetch: 手动挡配套的真实抓取工具 ─────────────────────
// web_fetch: 抓取真实网页，转成 Markdown 保留结构（标题/列表/代码块/链接）
// 走真实网络请求，无 mock 拦截——适合 web_search 找到 URL 后精读
// 返回剥好的纯文本，超过上限自动截断

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取指定 URL 的网页内容，转换为 Markdown 格式（保留标题、列表、代码块、链接等结构）',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 5000,
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperAgent/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `抓取失败: HTTP ${res.status}`;
      const html = await res.text();
      return htmlToMarkdown(html) || '页面无文本内容';
    } catch (err: any) {
      return `抓取失败: ${err.message}`;
    }
  },
};

export const allTools: ToolDefinition[] = [
    weatherTool, calculatorTool, readFileTool,
    writeFileTool, listDirectoryTool, editFileTool,
    bashTool, grepTool, globTool,
    startPreviewTool,
    webFetchTool,
];
