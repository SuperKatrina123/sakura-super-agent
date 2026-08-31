import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandHandler } from './index.js';
import { inspectTrace } from '../trace/recorder.js';

// ═══════════════════════════════════════════════════════════════════════════
// /trace 命令族 —— 排障复盘的入口
// ═══════════════════════════════════════════════════════════════════════════
//
// /trace                    列出最近 10 个 trace
// /trace list [N]           列出最近 N 个（默认 10）
// /trace show <id>          打完整时间线（每个 event 一行摘要 + 数据大小）
// /trace path <id>          只打关键路径（跳过 messages 快照细节、看执行骨架）
//
// **跟 Session 命令的区别**：
//   Session 是对话历史、用户视角
//   Trace 是执行快照、开发者视角——**核心价值是"能看到 Step 前的输入上下文"**、
//   Step 4 错了、能看到"当时 messages 里长什么样"、而不只是"输出什么"

interface TraceMeta {
  id: string;
  path: string;
  size: number;
  mtime: Date;
}

async function listTraces(dir: string, limit: number): Promise<TraceMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const jsonl = entries.filter(f => f.endsWith('.jsonl'));
  const metas = await Promise.all(
    jsonl.map(async (f) => {
      const p = join(dir, f);
      const s = await stat(p);
      return { id: f.replace(/\.jsonl$/, ''), path: p, size: s.size, mtime: s.mtime };
    }),
  );
  return metas.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
}

async function readEvents(path: string): Promise<any[]> {
  const raw = await readFile(path, 'utf-8');
  return raw.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// eventSummary —— 每种 event 类型的一行摘要
function eventSummary(evt: any): string {
  switch (evt.type) {
    case 'trace_started': return `[start] ${evt.sessionId} · ${evt.model}`;
    case 'step_started': {
      const msgs = evt.context?.messages?.length ?? 0;
      const sysLen = evt.context?.system?.length ?? 0;
      return `[step ${evt.step} 开始] SYSTEM ${sysLen} 字符 · messages ${msgs} 条`;
    }
    case 'step_attempt_failed':
      return `[step ${evt.step} 重试 #${evt.attempt}] ${evt.error?.slice(0, 80)}`;
    case 'step_completed': {
      const newMsgs = evt.output?.messages?.length ?? 0;
      const text = evt.output?.text?.slice(0, 60).replace(/\n/g, ' ') ?? '';
      return `[step ${evt.step} 完成] ${evt.durationMs}ms · +${newMsgs} 消息 · "${text}${text.length >= 60 ? '...' : ''}"`;
    }
    case 'trace_finished':
      return `[end] ${evt.status} · ${evt.durationMs}ms${evt.error ? ` · ${evt.error}` : ''}`;
    default:
      return `[${evt.type}]`;
  }
}

export function createTraceCommands(traceDir: string): CommandHandler[] {
  return [
    async (cmd) => {
      const t = cmd.trim();
      if (!t.startsWith('/trace')) return false;

      // /trace show <id>
      const showMatch = t.match(/^\/trace\s+show\s+(\S+)$/);
      if (showMatch) {
        const path = join(traceDir, `${showMatch[1]}.jsonl`);
        try {
          console.log('\n' + await inspectTrace(path) + '\n');
        } catch (err) {
          console.log(`\n  ✗ 读取失败: ${err instanceof Error ? err.message : err}\n`);
        }
        return true;
      }

      // /trace path <id> —— 只打关键路径、跳过 messages 细节
      const pathMatch = t.match(/^\/trace\s+path\s+(\S+)$/);
      if (pathMatch) {
        const path = join(traceDir, `${pathMatch[1]}.jsonl`);
        try {
          const events = await readEvents(path);
          console.log(`\n[trace ${pathMatch[1]}] 执行路径`);
          for (const evt of events) {
            // 只保留 step_completed 里的关键动作：新增了什么消息、是不是有 tool call
            if (evt.type === 'step_completed') {
              const msgs = evt.output?.messages ?? [];
              const toolCalls = msgs.flatMap((m: any) =>
                Array.isArray(m.content)
                  ? m.content.filter((c: any) => c.type === 'tool-call').map((c: any) => c.toolName)
                  : []
              );
              const hasText = evt.output?.text?.length > 0;
              const tag = toolCalls.length > 0 ? `→ ${toolCalls.join(', ')}` : hasText ? '→ [text]' : '→ (empty)';
              console.log(`  step ${evt.step} · ${evt.durationMs}ms · ${tag}`);
            } else if (evt.type === 'trace_finished') {
              console.log(`  ${eventSummary(evt)}`);
            } else if (evt.type === 'step_attempt_failed') {
              console.log(`  ${eventSummary(evt)}`);
            }
          }
          console.log('');
        } catch (err) {
          console.log(`\n  ✗ 读取失败: ${err instanceof Error ? err.message : err}\n`);
        }
        return true;
      }

      // /trace / /trace list [N]
      const listMatch = t.match(/^\/trace(?:\s+list)?(?:\s+(\d+))?$/);
      if (listMatch) {
        const limit = listMatch[1] ? parseInt(listMatch[1], 10) : 10;
        const traces = await listTraces(traceDir, limit);
        if (traces.length === 0) {
          console.log(`\n  ${traceDir} 下没有 trace 记录\n`);
        } else {
          console.log(`\n  最近 ${traces.length} 个 trace (${traceDir}/):`);
          for (const t of traces) {
            const ago = Math.round((Date.now() - t.mtime.getTime()) / 1000);
            const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)}m ago` : `${Math.round(ago / 3600)}h ago`;
            console.log(`    ${t.id}  ${formatSize(t.size).padStart(7)}  ${agoStr}`);
          }
          console.log('  用法: /trace show <id> / /trace path <id>\n');
        }
        return true;
      }

      console.log('\n  用法: /trace [list N] | /trace show <id> | /trace path <id>\n');
      return true;
    },
  ];
}
