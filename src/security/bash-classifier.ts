export type RiskLevel = 'safe' | 'moderate' | 'dangerous';

interface ClassifyResult {
  level: RiskLevel;
  reason?: string;
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force)/, reason: '强制删除文件' },
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: '递归删除' },
  { pattern: /\bsudo\b/, reason: '提权操作' },
  { pattern: /\bmkfs\b/, reason: '格式化磁盘' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写设备' },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, reason: 'Fork bomb' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
  { pattern: /\beval\b/, reason: 'eval 动态执行' },
  { pattern: />\s*\/etc\//, reason: '覆写系统配置' },
];

const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/, reason: '删除文件' },
  { pattern: /\bgit\s+push\b/, reason: 'Git 推送' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Git 硬重置' },
  { pattern: /\bkill\b/, reason: '终止进程' },
  { pattern: /\bnpm\s+publish\b/, reason: '发布 npm 包' },
];

export function classifyBashCommand(command: string): ClassifyResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'dangerous', reason };
    }
  }
  for (const { pattern, reason } of MODERATE_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'moderate', reason };
    }
  }
  return { level: 'safe' };
}
