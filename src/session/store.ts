import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ModelMessage } from 'ai';

const SESSION_DIR = '.sessions';

export interface SessionEntry {
  type: 'message';
  timestamp: string;
  message: ModelMessage;
}

// 一次会话的元信息——启动时打印用，方便排查"文件建哪了""历史多大了"这类问题
// 之所以做一次完整扫描而不是缓存：session 文件不会太大（几 MB 已经算长会话），
// 一次 sync 读能拿全所有信息，比维护缓存靠谱
export interface SessionStats {
  absolutePath: string;
  bytes: number;
  messageCount: number;
  roleBreakdown: Record<string, number>;   // { user: 3, assistant: 3, tool: 0 }
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export class SessionStore {
  private dir: string;
  private sessionId: string;

  constructor(sessionId: string = 'default') {
    this.sessionId = sessionId;
    this.dir = SESSION_DIR;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`);
  }

  append(message: ModelMessage): void {
    const entry: SessionEntry = {
      type: 'message',
      timestamp: new Date().toISOString(),
      message,
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  appendAll(messages: ModelMessage[]): void {
    for (const msg of messages) {
      this.append(msg);
    }
  }

  load(): ModelMessage[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];

    const messages: ModelMessage[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === 'message') {
          messages.push(entry.message);
        }
      } catch (err) {
        // 特意选 JSONL 是为了"最多丢最后一行"——但静默吞掉解析失败会让你不知道丢了什么
        // 至少留声音：告诉用户第几行挂了、为什么挂，方便排查是断电截断还是文件被外部改坏
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[session] 跳过第 ${i + 1} 行（JSON 解析失败）：${reason}`);
      }
    }
    return messages;
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  // 一次扫描收集所有 debug 数据——不缓存、每次调用都从磁盘读
  // 只在启动时调一次，性能不敏感；换来的是"永远反映磁盘真实状态"的正确性
  stats(): SessionStats {
    const absolutePath = resolve(this.filePath);
    const empty: SessionStats = {
      absolutePath,
      bytes: 0,
      messageCount: 0,
      roleBreakdown: {},
      firstTimestamp: null,
      lastTimestamp: null,
    };
    if (!existsSync(this.filePath)) return empty;

    const bytes = statSync(this.filePath).size;
    const content = readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return { ...empty, bytes };

    const roleBreakdown: Record<string, number> = {};
    let messageCount = 0;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type !== 'message') continue;
        messageCount++;
        const role = (entry.message as { role?: string }).role ?? 'unknown';
        roleBreakdown[role] = (roleBreakdown[role] ?? 0) + 1;
        if (firstTimestamp === null) firstTimestamp = entry.timestamp;
        lastTimestamp = entry.timestamp;   // 循环里持续覆盖，最后一次赋值就是最新的
      } catch { /* stats 里静默 skip：load() 里已经报警了，这里不再重复噪音 */ }
    }

    return { absolutePath, bytes, messageCount, roleBreakdown, firstTimestamp, lastTimestamp };
  }
}
