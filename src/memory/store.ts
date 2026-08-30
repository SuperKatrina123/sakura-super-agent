import fs from 'node:fs';
import path from 'node:path';
import { validateAll, summarize, type EntryReport, type LintSummary } from './validator.ts';

// ═══════════════════════════════════════════════════════════════════════════
// MemoryStore：索引 + 分散 markdown 文件的记忆系统
// ═══════════════════════════════════════════════════════════════════════════
//
// 结构：
//   .memory/
//   ├── MEMORY.md              ← 索引，一行一条元数据
//   ├── user_typescript-preference.md    ← 每条 memory 是独立 markdown
//   ├── feedback_no-mock-db.md
//   ├── project_migration.md
//   └── reference_grafana.md
//
// 每个 memory 文件用 YAML frontmatter：
//   ---
//   name: 用户偏好 TypeScript
//   description: 用户偏好 TypeScript，不喜欢 Python
//   type: user
//   ---
//
//   用户明确表示偏好 TypeScript...
//
// description 字段不是装饰——**做检索时按 description 判断相关性**
// 写得越精确、检索质量越高
//
// 两个硬性约束（跟 Claude Code 对齐）：
//   MAX_INDEX_LINES = 200
//     索引最多 200 行——**强制淘汰机制**、不是技术限制
//     满了自动移除最早的、逼 Agent 只保留高价值记忆
//   MAX_FILE_CHARS = 4000
//     单条 memory 最多 4000 字符——读取时超限截断
//     防止一条记忆吃光 SYSTEM 预算

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  filePath: string;     // 相对 .memory/ 的文件名（比如 "user_typescript.md"）
  createdAt?: string;   // ISO 时间戳——记忆写入时间
  // ↓ LRU 语义支持（validator TTL 用）
  lastWriteAt?: string; // 最近修改时间（同 createdAt 更新、覆盖 save 时更新）
  lastReadAt?: string;  // 最近读取时间——每次 parseFile / search 命中时更新
                        //   TTL 判断用这个字段：**经常被读的记忆不该被清**
}

const MEMORY_DIR = '.memory';
const INDEX_FILE = 'MEMORY.md';
const MAX_INDEX_LINES = 200;
const MAX_FILE_CHARS = 4000;

// 索引行格式：`- <filename>: <description>`
// 简洁——name 从 filename slug 反推、type 从 filename 前缀提取
const INDEX_LINE_RE = /^- ([\w-]+_[\w一-鿿-]+\.md): (.+)$/;

export class MemoryStore {
  private readonly baseDir: string;

  constructor(baseDir: string = '.') {
    this.baseDir = baseDir;
  }

  private get memoryDir(): string { return path.join(this.baseDir, MEMORY_DIR); }
  private get indexPath(): string { return path.join(this.memoryDir, INDEX_FILE); }

  // 幂等——多次调用无副作用
  private init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8');
    }
  }

  // 从 name 生成 slug：中文和 alphanumeric 保留、其他字符变横杠
  // 加 type 前缀是**人眼扫描友好**：ls .memory/ 一眼看到分类
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // 读老文件的 createdAt——覆盖 save 时保留原始创建时间
  // 找不到（新文件、格式坏）返回 undefined、caller 用 now 当 createdAt
  private tryReadCreatedAt(filename: string): string | undefined {
    const fullPath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(fullPath)) return undefined;
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    if (!m) return undefined;
    const kv = /^createdAt:\s*(.+)$/m.exec(m[1]);
    return kv?.[1].trim();
  }

  // 写入一条 memory：写文件 + 更新索引
  // 已存在同名 → 覆盖（这是 v1 的策略、简单直白）
  // 索引达到 200 行 → LRU 淘汰最早的（腾位置）
  // 内容超 4000 字符 → 截断
  // 返回生成的 filename
  save(entry: Omit<MemoryEntry, 'filePath'>): string {
    this.init();

    const slug = this.slugify(entry.name);
    const filename = `${entry.type}_${slug}.md`;
    const filePath = path.join(this.memoryDir, filename);

    // 内容超长截断——写入时就砍、避免存磁盘的垃圾
    const content = entry.content.length > MAX_FILE_CHARS
      ? entry.content.slice(0, MAX_FILE_CHARS) + '\n\n[...truncated at write]'
      : entry.content;

    // YAML frontmatter + markdown body
    // 用 frontmatter 而不是纯 JSON——**给人读也给模型读**
    // 三个时间戳：
    //   - createdAt   首次写入（老条目更新时保留原值、不覆盖）
    //   - lastWriteAt 最近修改（覆盖 save 时更新）
    //   - lastReadAt  最近读取（每次 parseFile/search 命中时更新——不在 save 里写）
    const now = new Date().toISOString();
    // 更新时保留原 createdAt——需要先看老文件有没有
    const existingCreatedAt = this.tryReadCreatedAt(filename);
    const createdAt = existingCreatedAt ?? now;
    const fileContent = [
      '---',
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      `createdAt: ${createdAt}`,
      `lastWriteAt: ${now}`,
      '---',
      '',
      content,
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    this.updateIndex(filename, entry.description);
    return filename;
  }

  // 更新索引：已存在同名 filename → 更新描述、否则追加
  // 追加时若超上限 200 → 移除最早的条目（LRU）
  private updateIndex(filename: string, description: string): void {
    const raw = fs.readFileSync(this.indexPath, 'utf-8');
    const lines = raw.split('\n');
    const headerIdx = 0;   // "# Memory Index" 在第 0 行
    const entryLines: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && INDEX_LINE_RE.test(line)) entryLines.push(line);
    }

    // 已存在 → 更新
    const existingIdx = entryLines.findIndex(l => l.startsWith(`- ${filename}:`));
    const newLine = `- ${filename}: ${description}`;
    if (existingIdx >= 0) {
      entryLines[existingIdx] = newLine;
    } else {
      // LRU 淘汰：达上限就砍最早的
      // 上限是"内容行"数、不含 header——所以对比 MAX_INDEX_LINES - 1
      while (entryLines.length >= MAX_INDEX_LINES - 1) {
        const evicted = entryLines.shift()!;
        const m = INDEX_LINE_RE.exec(evicted);
        if (m) {
          // 顺便 rm 内容文件、避免 orphan
          const orphanPath = path.join(this.memoryDir, m[1]);
          if (fs.existsSync(orphanPath)) fs.unlinkSync(orphanPath);
        }
      }
      entryLines.push(newLine);
    }

    fs.writeFileSync(this.indexPath, [lines[headerIdx], ...entryLines].join('\n') + '\n', 'utf-8');
  }

  // 列出所有 memory：扫 .memory/ 目录、解析每个 .md 的 frontmatter
  // 不读索引——直接扫目录更 robust（索引和实际文件不一致时以文件为准）
  list(): MemoryEntry[] {
    this.init();
    const files = fs.readdirSync(this.memoryDir)
      .filter((f: string) => f.endsWith('.md') && f !== INDEX_FILE);

    const entries: MemoryEntry[] = [];
    for (const filename of files) {
      const parsed = this.parseFile(filename);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  // 解析单个 memory 文件——提取 frontmatter 字段 + body
  // **纯读、不改磁盘**——list() 里循环调、若每次都 write 磁盘会拖慢启动
  // lastReadAt 更新走独立的 markRead() 方法、由 read/search 命中时主动调
  private parseFile(filename: string): MemoryEntry | null {
    const fullPath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(fullPath)) return null;
    const raw = fs.readFileSync(fullPath, 'utf-8');

    // frontmatter 格式：`---\nkey: value\n...\n---\n\n<body>`
    const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(raw);
    if (!m) return null;

    const meta: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
      const kv = /^([\w-]+):\s*(.+)$/.exec(line.trim());
      if (kv) meta[kv[1]] = kv[2];
    }
    if (!meta.name || !meta.description || !meta.type) return null;
    if (!['user', 'feedback', 'project', 'reference'].includes(meta.type)) return null;

    const content = m[2];
    return {
      name: meta.name,
      description: meta.description,
      type: meta.type as MemoryType,
      content: content.length > MAX_FILE_CHARS
        ? content.slice(0, MAX_FILE_CHARS) + '\n\n[...truncated at read]'
        : content,
      filePath: filename,
      createdAt: meta.createdAt,   // 老文件可能没这个字段——保持 undefined、不做过期判断
      lastWriteAt: meta.lastWriteAt,
      lastReadAt: meta.lastReadAt,
    };
  }

  // 更新一条 memory 的 lastReadAt——read/search 命中时主动调
  // 只改 frontmatter 的 lastReadAt 那一行、不重写整个文件
  // 找不到文件静默返回——不抛错、不阻断主流程
  markRead(filename: string): void {
    const fullPath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(fullPath)) return;
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const now = new Date().toISOString();

    // frontmatter 里已有 lastReadAt → 替换、否则在 --- 前插一行
    const hasLastRead = /^lastReadAt:\s*.+$/m.test(raw);
    const updated = hasLastRead
      ? raw.replace(/^lastReadAt:\s*.+$/m, `lastReadAt: ${now}`)
      : raw.replace(/^---$/m, `lastReadAt: ${now}\n---`);   // 第一个 --- 之前插

    fs.writeFileSync(fullPath, updated, 'utf-8');
  }

  // 关键词搜索——按 name + description + content 匹配
  // v1 极简：小写化 + 空格分词 + OR 匹配（任一关键词命中就算）
  // 够用；将来要做 embedding 检索时替换这个方法即可
  search(query: string): MemoryEntry[] {
    const all = this.list();
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];
    return all.filter(entry => {
      const text = `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });
  }

  // 删除一条 memory——两个动作：从索引移除 + rm 内容文件
  // 找不到返回 false
  delete(name: string): boolean {
    this.init();
    const entries = this.list();
    const target = entries.find(e => e.name === name);
    if (!target) return false;

    const fullPath = path.join(this.memoryDir, target.filePath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

    // 重写索引
    const raw = fs.readFileSync(this.indexPath, 'utf-8');
    const lines = raw.split('\n').filter((l: string) => !l.trim().startsWith(`- ${target.filePath}:`));
    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');

    return true;
  }

  // 读索引文件原文（去掉标题）——buildPromptSection 用
  // 直接拼字符串比 list() 后重新格式化更省事、也能反映索引真实排序
  private loadIndex(): string {
    this.init();
    const raw = fs.readFileSync(this.indexPath, 'utf-8');
    // 去掉第一行标题（"# Memory Index"）——只留条目行
    return raw.split('\n').slice(1).join('\n').trim();
  }

  // 生成注入到 SYSTEM prompt 的 memory section
  // 语义：
  //   - 空 memory → 提示 Agent 有工具可用（但不给示例、避免噪音）
  //   - 有 memory → 索引 + "线索不是事实、需验证" 提醒 + 过期提醒
  //
  // 关键设计：
  //   - **只注入索引 name/description**、content 按需 tool call 拿——跟 defer 目录同 pattern
  //   - **"线索不是事实"** 是应对 Mem0 报告的 33% 过期率——每次都提醒 Agent 验证
  //   - 超过 1 天的记忆附加**过时提醒**——参考 Claude Code 实现
  buildPromptSection(): string {
    this.init();
    const entries = this.list();

    if (entries.length === 0) {
      return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。';
    }

    // 过期判断——超过 24 小时的记忆需要提醒验证
    const now = Date.now();
    const staleThresholdMs = 24 * 60 * 60 * 1000;
    const staleCount = entries.filter(e => {
      if (!e.createdAt) return false;   // 老文件没 createdAt——不判断
      return now - new Date(e.createdAt).getTime() > staleThresholdMs;
    }).length;

    const index = this.loadIndex();
    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      '',
      '记忆索引：',
      index,
      '',
      '记忆使用原则：',
      '- 记忆是线索，不是事实——使用前先用工具验证（read_file、grep 确认）',
      '- 不存代码能推导的、git 能查的、文档已经写了的',
      '- 只存对话中出现的、其他地方推导不出来的信息',
    ];

    if (staleCount > 0) {
      lines.push('');
      lines.push(`⚠ 其中 ${staleCount} 条记忆超过 24 小时——涉及代码行为或 file:line 引用的信息可能已经过时。`);
    }

    return lines.join('\n');
  }

  // Lint 体检：跑 validator 全库、返回诊断报告 + 汇总
  // pruneExpired=true 会**执行**删除（severity=delete 的）——默认 false、只诊断
  // 分开是设计选择：**"看看有没有问题"和"清理"是两件事**
  //   - 前者是"体检"、每次都可以跑、无副作用
  //   - 后者是"手术"、需要用户确认——教学项目里 tool 层 default false、显式传 true 才动手
  lintAndPrune(baseDir = '.', pruneExpired = false): { reports: EntryReport[]; summary: LintSummary; pruned: number } {
    const entries = this.list();
    const reports = validateAll(entries, baseDir);

    let pruned = 0;
    if (pruneExpired) {
      for (const report of reports) {
        const shouldDelete = report.issues.some(i => i.severity === 'delete');
        if (shouldDelete) {
          if (this.delete(report.entry.name)) pruned++;
        }
      }
    }

    return { reports, summary: summarize(reports), pruned };
  }

  // Debug——启动时打印当前 memory 状态
  stats(): { count: number; byType: Record<MemoryType, number>; indexPath: string } {
    const entries = this.list();
    const byType = { user: 0, feedback: 0, project: 0, reference: 0 } as Record<MemoryType, number>;
    for (const e of entries) byType[e.type]++;
    return { count: entries.length, byType, indexPath: path.resolve(this.indexPath) };
  }
}
