import { z } from 'zod';

export const ModelConfigSchema = z.object({
  provider: z.enum(['dashscope', 'openai', 'custom']).default('dashscope'),
  name: z.string().default('qwen-plus-latest'),
  baseURL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  apiKey: z.string().default(''),
});

export const PluginConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.string()).default({}),
});

export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  port: z.number().default(3000),
});

export const ChannelConfigSchema = z.object({
  feishu: FeishuChannelConfigSchema.default({}),
});

export const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().min(0).max(5).default(1),
  maxConcurrent: z.number().min(1).max(10).default(3),
  defaultTimeout: z.number().default(60000),
});

export const SecurityConfigSchema = z.object({
  defaultRole: z.string().default('developer'),
  auditLog: z.boolean().default(true),
  bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
  dataDir: z.string().default('.'),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  docsDir: z.string().default('docs'),
});

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('.'),
});

export const SessionConfigSchema = z.object({
  id: z.string().default('default'),
});

export const UsageConfigSchema = z.object({
  trackingFile: z.string().default('.usage/today.jsonl'),
});

// Trace 系统：每次 agentLoop 一个 JSONL 文件、记录每 step 的输入上下文快照 + 输出
// enabled: 关闭时完全不创建 recorder、零开销
// dir: 落盘目录、按 traceId 命名（<sessionId>-<isoTimestamp>.jsonl）
export const TraceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default('.traces'),
});

export const SuperAgentConfigSchema = z.object({
  version: z.string().default('1.0'),
  model: ModelConfigSchema.default({}),
  plugins: z.array(PluginConfigSchema).default([]),
  channels: ChannelConfigSchema.default({}),
  agents: AgentConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  rag: RagConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  usage: UsageConfigSchema.default({}),
  trace: TraceConfigSchema.default({}),
});

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;
