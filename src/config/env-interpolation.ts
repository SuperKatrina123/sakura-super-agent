// ═══════════════════════════════════════════════════════════════════════════
// env-interpolation.ts —— 递归替换配置里的 ${VAR} 占位符
// ═══════════════════════════════════════════════════════════════════════════
//
// **为什么把这个抽出来独立文件**：
//   Plugin 系统里已经有一份 `resolveEnvVars`（见 plugins/manager.ts）——
//   config 系统现在也要用同一个能力、抽出来让两边复用、未来加语法（默认值、嵌套等）只改一处
//
// **支持的语法**：
//   ${VAR}          → process.env.VAR（缺失时保持原样、由 schema 层决定给不给默认值）
//   ${VAR:-default} → 缺失时用 default（跟 shell 一致）
//
// **递归深入 object / array / string**：
//   config 是嵌套结构、必须递归处理——不然 { model: { apiKey: "${KEY}" } } 会漏
//
// **不改原对象**：返回新对象、避免副作用

const INTERPOLATION_RE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

export function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(INTERPOLATION_RE, (_match, varName, defaultValue) => {
      const envValue = process.env[varName];
      if (envValue !== undefined) return envValue;
      // 有默认值就用默认值、没有就保持 ${VAR} 原样（zod 后续 default 兜底）
      return defaultValue ?? _match;
    });
  }

  if (Array.isArray(value)) {
    return value.map(item => interpolateEnv(item));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolateEnv(v);
    }
    return result;
  }

  return value;
}
