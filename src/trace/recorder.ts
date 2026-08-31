import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelMessage } from 'ai';
import type { StepUsage } from '../session/usage-tracker.js';type TraceStatus = 'completed' | 'failed' | 'cancelled';

interface TraceOptions {
  directory?: string;
  sessionId: string;
  model: string;
}

interface StepStartedInput {
  step: number;
  system: string;
  messages: ModelMessage[];
}

interface StepCompletedInput {
  step: number;
  text: string;
  outputMessages: ModelMessage[];
  usage: StepUsage;
}

const SECRET_KEY = /api[-_]?key|token|secret|password|authorization/i;

function sanitize(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]),
    );
  }
  return value;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'default';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalTraceRecorder {
  readonly traceId: string;
  readonly filePath: string;
  private readonly startedAt = Date.now();
  private readonly stepStartedAt = new Map<number, number>();
  private writeFailed = false;

  private constructor(private readonly options: TraceOptions) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.traceId = `${safeName(options.sessionId)}-${stamp}`;
    this.filePath = join(options.directory ?? '.traces', `${this.traceId}.jsonl`);
  }

  static async start(options: TraceOptions): Promise<LocalTraceRecorder> {
    const recorder = new LocalTraceRecorder(options);
    await mkdir(dirname(recorder.filePath), { recursive: true });
    await recorder.write({
      type: 'trace_started',
      traceId: recorder.traceId,
      sessionId: options.sessionId,
      model: options.model,
      timestamp: new Date().toISOString(),
    });
    return recorder;
  }

  async recordStepStarted(input: StepStartedInput): Promise<void> {
    this.stepStartedAt.set(input.step, Date.now());
    await this.write({
      type: 'step_started',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      context: sanitize({ system: input.system, messages: input.messages }),
    });
  }

  async recordAttemptError(step: number, attempt: number, error: unknown): Promise<void> {
    await this.write({
      type: 'step_attempt_failed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step,
      attempt,
      error: errorMessage(error),
    });
  }

  async recordStepCompleted(input: StepCompletedInput): Promise<void> {
    const startedAt = this.stepStartedAt.get(input.step) ?? Date.now();
    await this.write({
      type: 'step_completed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      durationMs: Date.now() - startedAt,
      output: sanitize({ text: input.text, messages: input.outputMessages }),
      usage: input.usage,
    });
  }

  async finish(status: TraceStatus, error?: unknown): Promise<void> {
    await this.write({
      type: 'trace_finished',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      status,
      durationMs: Date.now() - this.startedAt,
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    });
  }

  private async write(event: Record<string, unknown>): Promise<void> {
    if (this.writeFailed) return;
    try {
      await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
      this.writeFailed = true;
      console.warn(`  [Trace] 写入失败，已停止记录: ${errorMessage(error)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// inspectTrace —— 读取 trace 文件、返回人类可读的摘要
// ═══════════════════════════════════════════════════════════════════════════
// 两个 caller 共用：
//   - REPL 的 /trace show <id> 命令
//   - CLI 的 `pnpm trace:inspect <path>` 独立入口
// 逻辑集中在这里、避免两处漂移
//
// 输出是"时间线摘要"、不是原文——**原文直接 cat 就能看**、inspectTrace 存在的意义是"给人看的摘要"

function summarizeEvent(evt: any): string {
  switch (evt.type) {
    case 'trace_started':
      return `[start] ${evt.sessionId} · ${evt.model}`;
    case 'step_started': {
      const msgs = evt.context?.messages?.length ?? 0;
      const sysLen = evt.context?.system?.length ?? 0;
      return `[step ${evt.step} 开始] SYSTEM ${sysLen} 字符 · messages ${msgs} 条`;
    }
    case 'step_attempt_failed':
      return `[step ${evt.step} 重试 #${evt.attempt}] ${(evt.error ?? '').slice(0, 80)}`;
    case 'step_completed': {
      const newMsgs = evt.output?.messages?.length ?? 0;
      const text = (evt.output?.text ?? '').slice(0, 60).replace(/\n/g, ' ');
      const suffix = (evt.output?.text ?? '').length > 60 ? '...' : '';
      return `[step ${evt.step} 完成] ${evt.durationMs}ms · +${newMsgs} 消息 · "${text}${suffix}"`;
    }
    case 'trace_finished':
      return `[end] ${evt.status} · ${evt.durationMs}ms${evt.error ? ` · ${evt.error}` : ''}`;
    default:
      return `[${evt.type}]`;
  }
}

export async function inspectTrace(filePath: string): Promise<string> {
  const raw = await readFile(filePath, 'utf-8');
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (events.length === 0) {
    return `[trace ${filePath}] 空文件`;
  }

  const lines: string[] = [];
  lines.push(`[trace ${filePath}] ${events.length} 个事件`);
  for (const evt of events) {
    const ts = evt.timestamp?.slice(11, 19) ?? '??:??:??';
    lines.push(`  ${ts} ${summarizeEvent(evt)}`);
  }
  return lines.join('\n');
}
