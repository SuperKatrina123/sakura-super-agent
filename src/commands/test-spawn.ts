import type { CommandHandler } from './index.js';
import type { SpawnContext } from '../agents/spawn.js';
import { spawnAgent, spawnParallel } from '../agents/spawn.js';

// /test-spawn         → 并行派 3 个 sub、跑 spawnParallel 路径、验证彩色 tag / 时序 / 摘要压缩
// /test-spawn single  → 只派 1 个 sub、跑 spawnAgent 路径、看单 sub 完整生命周期
//
// 目的：**跳过模型选择工具的不确定性**、直接跑架构
// 真实模型可能倾向自己搜、不用 spawn_agent——REPL 直调不受这个影响
export function createTestSpawnCommands(getSpawnCtx: () => SpawnContext): CommandHandler[] {
  return [
    async (cmd, _ctx) => {
      const t = cmd.trim();
      if (t !== '/test-spawn' && t !== '/test-spawn single') return false;

      const ctx = getSpawnCtx();

      if (t === '/test-spawn single') {
        console.log('\n[test-spawn] 单 sub 模式——跑 spawnAgent');
        const result = await spawnAgent(
          { task: '用 read_file 读 README.md、给我一句话总结这个项目是干什么的' },
          ctx,
        );
        console.log('\n[test-spawn] 结果:');
        console.log(result.slice(0, 500));
        console.log('\n');
        return true;
      }

      console.log('\n[test-spawn] 并行模式——跑 spawnParallel、3 个 sub');
      const results = await spawnParallel(
        [
          { task: '用 read_file 读 CLAUDE.md、给我一句话总结这个文件的作用' },
          { task: '用 list_directory 看 src/ 目录、告诉我这个项目有几个主要模块' },
          { task: '用 read_file 读 package.json、告诉我这个项目用了什么框架' },
        ],
        ctx,
      );

      console.log('\n[test-spawn] 汇总:');
      for (const [i, r] of results.entries()) {
        console.log(`  ${i + 1}. ${r.task.slice(0, 40)}`);
        console.log(`     → ${r.result.slice(0, 100).replace(/\n/g, ' ')}${r.result.length > 100 ? '...' : ''}`);
      }
      console.log('');
      return true;
    },
  ];
}
