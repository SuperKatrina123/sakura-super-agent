// config.ts —— 配置加载

// FIXME: 直接读 process.env，缺失时静默走默认值，上线时容易配错都不知道
// TODO: 换成 zod schema 校验，缺关键项直接崩、别偷偷跑起来
export const config = {
  port: Number(process.env.PORT) || 3000,
  dbUrl: process.env.DATABASE_URL || 'sqlite::memory:',
  // XXX: JWT 密钥有默认值是安全灾难，生产环境必须强制通过环境变量注入
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-do-not-use',
  // TODO: 从 config 文件也能加载（YAML？TOML？）
};

// HACK: 启动时打印一遍配置，方便排查；但 jwtSecret 千万别打印出来！！
// FIXME: 下面这行现在会把 jwtSecret 一起打出来——立刻脱敏
console.log('[config]', config);
