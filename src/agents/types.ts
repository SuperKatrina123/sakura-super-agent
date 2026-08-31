// maxSpawnDepth 和 maxConcurrent 是两道保护机制：深度限制防止 Agent A 派 Agent B、B 又派 C 无限嵌套下去；并发限制防止一次性派太多子 Agent 把资源吃光。
export interface SubAgentConfig {
  maxSpawnDepth: number;       // 最大嵌套深度，默认 1
  maxConcurrent: number;       // 最大并发子 agent 数，默认 3
  defaultTimeout: number;      // 默认执行超时 ms，默认 60000
}

export const DEFAULT_CONFIG: SubAgentConfig = {
  maxSpawnDepth: 1,
  maxConcurrent: 3,
  defaultTimeout: 60000,
};

export interface SpawnRequest {
  task: string;                // 子 agent 的任务描述
  tools?: string[];            // 允许使用的工具名（不传则继承父 agent）
  timeout?: number;            // 执行超时 ms
}

export interface SubAgentRun {
  id: string;                  // 运行 ID
  task: string;                // 任务描述
  status: 'running' | 'completed' | 'error' | 'timeout';
  depth: number;               // 当前嵌套深度
  startedAt: string;
  finishedAt?: string;
  result?: string;             // 执行结果文本
  error?: string;
}
