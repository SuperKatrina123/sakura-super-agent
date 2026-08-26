// user-service.ts —— 简易用户服务，用来给代码分析 Agent 练手
// 里面故意埋了各种 TODO / FIXME / HACK / XXX / NOTE，覆盖 bug、功能、性能、技术债、疑问几类

import { readFileSync, writeFileSync } from 'node:fs';

interface User {
  id: string;
  email: string;
  password: string;      // FIXME: 明文存密码，上线前必须换成 bcrypt/argon2 哈希
  createdAt: number;
  role: 'admin' | 'user';
}

// TODO: 换成真正的数据库（PostgreSQL？SQLite？先跑通再说）
const DB_FILE = '/tmp/users.json';

// HACK: 全局单例缓存，多进程下会不一致。等接了 Redis 再删
let cache: User[] | null = null;

function loadUsers(): User[] {
  if (cache) return cache;
  try {
    // FIXME: 文件不存在时抛异常，应该返回空数组 + 首次写入
    const raw = readFileSync(DB_FILE, 'utf-8');
    cache = JSON.parse(raw);
    return cache!;
  } catch (e) {
    // XXX: 静默吞掉所有错误，包括 JSON 解析失败——排查问题会很痛苦
    return [];
  }
}

function saveUsers(users: User[]) {
  cache = users;
  // TODO: 写文件应该做原子替换（写 tmp → rename），否则崩溃可能损坏数据
  writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

export function createUser(email: string, password: string): User {
  const users = loadUsers();

  // FIXME: O(n) 线性扫描，用户上万后会明显变慢；应改成 email → user 的索引
  const exists = users.find(u => u.email === email);
  if (exists) throw new Error('用户已存在');

  // TODO: 邮箱格式校验（正则 or zod）
  // TODO: 密码强度校验（至少 8 位、大小写、数字）

  const user: User = {
    // HACK: 用时间戳当 ID，高并发下会碰撞。换成 uuid/v7 或 nanoid
    id: String(Date.now()),
    email,
    password,   // FIXME: 见文件顶部——密码要哈希
    createdAt: Date.now(),
    role: 'user',
  };

  users.push(user);
  saveUsers(users);
  return user;
}

export function login(email: string, password: string): User | null {
  const users = loadUsers();

  // NOTE: 这里做的是完全相等比较，会受时序攻击影响
  // FIXME: 生产环境要用 crypto.timingSafeEqual 做常量时间比较
  const user = users.find(u => u.email === email && u.password === password);
  return user || null;
}

// TODO: 加一个 changePassword() 方法
// TODO: 加一个 deleteUser(id) 方法（软删除还是硬删除？先讨论一下）
// TODO: session / JWT 签发逻辑还没写

export function listAdmins(): User[] {
  const users = loadUsers();
  // XXX: 每次都从磁盘 loadUsers()，即便 cache 命中也会做一次全表 filter
  // 大表下应该在写入侧维护一个 admins 索引
  return users.filter(u => u.role === 'admin');
}

// HACK: 临时兜底——上周演示时管理员登不上去，先硬编码一个后门账号
// XXX: 上线前必删！！！这是安全灾难
export function backdoorLogin(secret: string): User | null {
  if (secret === 'super-secret-do-not-use') {
    return {
      id: '0',
      email: 'admin@example.com',
      password: '',
      createdAt: 0,
      role: 'admin',
    };
  }
  return null;
}

// TODO: 下面这段导出逻辑先占位，等定了 CSV 格式再实现
export function exportUsersToCSV(): string {
  // FIXME: 未做任何转义，字段里有逗号/引号会直接把 CSV 结构撑坏
  const users = loadUsers();
  const header = 'id,email,role,createdAt\n';
  const rows = users.map(u => `${u.id},${u.email},${u.role},${u.createdAt}`).join('\n');
  return header + rows;
}
