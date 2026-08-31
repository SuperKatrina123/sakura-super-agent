import type { PreToolHook, PostToolHook, HookResult } from './hooks.js';
import { classifyBashCommand } from './bash-classifier.js';

// ═══════════════════════════════════════════════════════════════════════════
// 内置 hooks —— 三层安全防线的第三层示范
// ═══════════════════════════════════════════════════════════════════════════
//
// 抽出来的意义：
//   - **可扩展**：加新的安全策略 = 加一个 hook、不改 bash 工具本身
//   - **可观测**：审计 / 日志走 post hook、跟"能不能执行"解耦
//   - **可组合**：一个 tool 可以挂多个 hook、按注册顺序串联
//
// 跟直接写在 execute 里对比：
//   写在 execute 里 → 逻辑跟工具耦合、新工具复制、忘了会漏
//   抽成 hook       → 一次注册、全局生效、想改集中改
// ═══════════════════════════════════════════════════════════════════════════

/**
 * bashSecurityHook —— 对 bash 工具做风险分级拦截
 *   dangerous → block（拒绝执行）
 *   moderate  → allow + modify（放行、但改写 input 加一段告警提示、Agent 能感知）
 *   safe      → allow
 *
 * 为什么在 preHook 里改 input 而不是在 post 改 output：
 *   - moderate 告警需要 Agent"知道自己碰了什么"——最好在 tool result 里能看见
 *   - 但 pre 阶段还没执行、拿不到 output——所以改成"给 command 加前缀"传给 execute
 *   - 更干净的方案是 post 里包一层 output——见 auditLogHook 的模式；这里做 modify 是为了演示 pre modify 语义
 *
 * 权衡：hook 只能拦到"命令语法上的危险"、拦不了"意图上的危险"
 *   `rm -rf` 拦、`rm x.txt` 放行——但 x.txt 可能是关键文件
 *   这是 classifier 本身的粒度问题、不是 hook 系统能解的、上层要靠 role + 人类确认
 */
export const bashSecurityHook: PreToolHook = (toolName, input): HookResult => {
  if (toolName !== 'bash') return { action: 'allow' };

  const command = (input as { command?: string })?.command;
  if (typeof command !== 'string') return { action: 'allow' };

  const risk = classifyBashCommand(command);

  if (risk.level === 'dangerous') {
    console.log(`  [hook:bash-security] 🚫 拒绝 dangerous: ${risk.reason} — "${command}"`);
    return {
      action: 'block',
      reason: `拒绝执行 dangerous 命令：${risk.reason}。如需执行请手动在终端跑。`,
    };
  }

  if (risk.level === 'moderate') {
    console.log(`  [hook:bash-security] ⚠️  moderate 放行: ${risk.reason} — "${command}"`);
    // 不改 input——纯放行 + 打 log
    // 告警拼到 tool result 的事交给 auditLogHook 的 post 那层
    return { action: 'allow' };
  }

  return { action: 'allow' };
};

/**
 * auditLogHook —— post hook 示范：拦到所有 tool 结果、按需处理
 *   - 对 bash 的 moderate 命令：在结果前拼告警前缀、Agent 能感知
 *   - 通用审计：如果注入了 logger（比如写入 audit.jsonl）、可以在这里追加
 *
 * 展示 post hook 的 modify 能力——不影响"能不能执行"、改的是"执行的表达"
 */
export const auditLogHook: PostToolHook = (toolName, input, output): HookResult => {
  // bash moderate 告警——命令已经执行过、post 拿到 output、拼前缀让 Agent 看见
  if (toolName === 'bash') {
    const command = (input as { command?: string })?.command;
    if (typeof command === 'string') {
      const risk = classifyBashCommand(command);
      if (risk.level === 'moderate') {
        const body = typeof output === 'string' ? output : JSON.stringify(output);
        return {
          action: 'modify',
          modifiedOutput: `[⚠️ security warning] 执行了 moderate 风险命令（${risk.reason}）："${command}"\n请在最终回复里明确告知用户你执行了这条命令。\n\n执行输出：\n${body}`,
        };
      }
    }
  }

  // 其他 tool——原样返回、不改
  return { action: 'allow' };
};
