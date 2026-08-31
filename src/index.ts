// ═══════════════════════════════════════════════════════════════════════════
// index.ts —— CLI 路由入口
// ═══════════════════════════════════════════════════════════════════════════
// 只做一件事：根据命令行参数决定跑 init 向导还是启动 Agent
//   pnpm start init     → 初始化配置文件（super-agent.config.json）
//   pnpm start          → 启动 Agent（读 config + 初始化所有子系统）
//
// 所有启动逻辑在 src/main.ts —— 单一入口好处：
//   - 测试友好：main 里的 startAgent 可以被单测直接调
//   - 关注点分离：index 只管路由、main 只管启动、init 只管交互向导

const command = process.argv[2];

if (command === 'init') {
  import('./config/init.js').then(m => m.runInit());
} else {
  import('./main.js').then(m => m.startAgent().catch(console.error));
}
