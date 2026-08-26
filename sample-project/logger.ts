// logger.ts —— 简易日志（写 stdout，占位）

type Level = 'debug' | 'info' | 'warn' | 'error';

// TODO: 替换成结构化日志（pino / winston），至少要能输出 JSON
// TODO: 支持按环境变量控制日志级别（LOG_LEVEL=info）
export function log(level: Level, msg: string, extra?: Record<string, unknown>) {
  // FIXME: extra 里有循环引用会让 JSON.stringify 直接抛错
  const line = `[${new Date().toISOString()}] [${level}] ${msg} ${extra ? JSON.stringify(extra) : ''}`;
  console.log(line);
}

// HACK: 全局单例——测试时想 mock 都 mock 不掉，等做重构再拆掉
export const globalLogger = {
  debug: (m: string) => log('debug', m),
  info: (m: string) => log('info', m),
  warn: (m: string) => log('warn', m),
  error: (m: string) => log('error', m),
};

// TODO: 加一个 sink 抽象，方便把日志同时打到文件 / 远端
// XXX: 现在所有 error 都只打 stdout，线上出问题基本查不到——上告警前必须接
