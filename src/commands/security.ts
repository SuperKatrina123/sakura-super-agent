import type { CommandHandler } from './index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Role } from '../security/roles.js';

// /role 命令族 + /hooks 查看
// 对应三层安全防线：role 是第一道门（工具可见性）、hooks 是第三层（可观测 + 可扩展）
// classifier 是第二层、住在 bash-security preHook 里、通过 /hooks 就能看到它
export function createSecurityCommands(registry: ToolRegistry): CommandHandler[] {
  return [
    // /role                 查看当前角色 + 工具数
    // /role <owner|collaborator|guest>   切换
    (cmd, _ctx) => {
      const match = cmd.match(/^\/role(?:\s+(owner|collaborator|guest))?$/);
      if (!match) return false;

      if (match[1]) {
        const role = match[1] as Role;
        registry.setRole(role);
        const toolCount = registry.getActiveTools().length;
        console.log(`\n[security] 角色切换为 ${role}，可用工具: ${toolCount} 个\n`);
      } else {
        const role = registry.getRole();
        const toolCount = registry.getActiveTools().length;
        console.log(`\n[security] 当前角色: ${role}，可用工具: ${toolCount} 个\n`);
      }
      return true;
    },

    // /hooks —— 展示当前注册的 pre / post hook
    (cmd, _ctx) => {
      if (cmd !== '/hooks') return false;
      const hooks = registry.hooks.list();
      console.log('\n[hooks]');
      if (hooks.pre.length > 0) {
        console.log('  Pre-Tool Hooks（拦截 / 修改 input）:');
        for (const name of hooks.pre) console.log(`    - ${name}`);
      }
      if (hooks.post.length > 0) {
        console.log('  Post-Tool Hooks（修改 output / 审计）:');
        for (const name of hooks.post) console.log(`    - ${name}`);
      }
      if (hooks.pre.length === 0 && hooks.post.length === 0) {
        console.log('  没有注册的 Hook');
      }
      console.log('');
      return true;
    },
  ];
}
