import type { ToolDefinition } from '../tools/tool-registry.ts';
import type { MemoryStore, MemoryType } from '../memory/store.ts';

// ═══════════════════════════════════════════════════════════════════════════
// createMemoryTool：一个工具、五个 action——管理跨会话记忆
// ═══════════════════════════════════════════════════════════════════════════
//
// 五个 action：
//   - save    保存新记忆（需要 name / description / type / content）
//   - list    列出所有记忆
//   - search  按关键词搜索（需要 query）
//   - read    读取单条记忆的完整内容（需要 name）
//   - delete  删除一条记忆（需要 name）
//
// 为什么单一工具、不拆五个：
//   - 五个工具 = 五份 schema 塞进 SYSTEM prompt——占 tokens
//   - Agent 一次学会一个 mental model——"记忆管理"
//   - 缺点：参数会多、但通过 description 里的分动作说明缓解
//
// description 里嵌入的分类规则和排除法是这个工具的**核心**：
// 决定 Agent 什么时候该 save、什么时候不该——防止 memory 系统被垃圾信息塞满

// 每个 action 需要哪些参数——让模型清楚知道
const ACTION_GUIDE = `
参数按 action 区分：
  save   → 必填: name, description, type, content
  list   → 无参数
  search → 必填: query
  read   → 必填: name
  delete → 必填: name`;

// 分类规则 + 排除法——写进 description 让 Agent 每次调用时都看到
// 这是 prompt engineering 补足模型判断力的关键
const SAVE_RULES = `
type 分四类：
  ● user       — 用户画像（角色、偏好、背景、技能）
                 例: "用户是后端工程师、Go 十年、第一次做前端"
  ● feedback   — 用户对 Agent 行为的纠正 **或** 确认
                 **两种都要存**——只存纠正会让 Agent 越来越保守
                 例（纠正）: "测试不要 mock 数据库"
                 例（确认）: "大 PR 比拆多个小 PR 好"
  ● project    — 进行中的工作/决策/截止日期
                 **必须把相对日期转成绝对日期**："下周四"→"2026-05-07"
                 否则一个月后完全不知道指哪天
  ● reference  — 外部资源的位置（**不是内容快照**）
                 ✓ "bug 跟踪在 GitHub 看板的 backlog 栏目"
                 ✗ "当前 open issues 有 #42、#39"（会过期）

**不要 save 以下信息**（排除法比什么该存更重要）：
  ❌ 能从代码 grep 出来的（技术栈、目录结构、函数位置）
  ❌ 有权威来源的（git log、CLAUDE.md、环境变量）
  ❌ 时效性强的当前状态（issue 编号、版本号、进度百分比）

description 字段**不是装饰**——search 时按它做关键词匹配、写得越精确、检索质量越高`;

export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: 'memory',
    description: `管理跨会话记忆。用户偏好、纠正反馈、决策背景、外部资源位置——这些"只在对话里出现一次、不存就永远丢"的信息该记进来。
${ACTION_GUIDE}

save 时的分类规则（**决定 memory 系统的长期质量**）:${SAVE_RULES}`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'search', 'read', 'delete', 'lint'],
          description: '五个动作之一',
        },
        name: {
          type: 'string',
          description: '记忆名称——save/read/delete 时用',
        },
        description: {
          type: 'string',
          description: '一句话描述、用于 search 时的关键词匹配（save 时必填）',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'save 时必填的分类',
        },
        content: {
          type: 'string',
          description: '记忆的完整内容 markdown（save 时必填）',
        },
        query: {
          type: 'string',
          description: '搜索关键词、支持空格分隔多个（search 时必填）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // memory 是跨进程状态、每次读写都要串行——避免并发写坏索引文件
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: {
      action: 'save' | 'list' | 'search' | 'read' | 'delete' | 'lint';
      name?: string;
      description?: string;
      type?: MemoryType;
      content?: string;
      query?: string;
    }) => {
      switch (args.action) {
        case 'save': {
          if (!args.name || !args.description || !args.type || !args.content) {
            return '保存失败：save 需要 name / description / type / content 四个参数';
          }
          const filename = memoryStore.save({
            name: args.name,
            description: args.description,
            type: args.type,
            content: args.content,
          });
          return `已保存记忆: ${filename}`;
        }

        case 'list': {
          const entries = memoryStore.list();
          if (entries.length === 0) return '当前没有存储任何记忆';
          // 按 type 分组显示——Agent 一眼看清各类分布
          const groups: Record<string, string[]> = { user: [], feedback: [], project: [], reference: [] };
          for (const e of entries) {
            groups[e.type].push(`  - ${e.name} — ${e.description}`);
          }
          const lines = [`记忆列表（共 ${entries.length} 条）：`];
          for (const [type, list] of Object.entries(groups)) {
            if (list.length === 0) continue;
            lines.push(`\n[${type}]`);
            lines.push(...list);
          }
          return lines.join('\n');
        }

        case 'search': {
          if (!args.query) return '搜索失败：search 需要 query 参数';
          const results = memoryStore.search(args.query);
          if (results.length === 0) return `没有找到与 "${args.query}" 相关的记忆`;
          // 命中的每条 memory 都算"被使用了"——更新 lastReadAt 支持 LRU
          for (const r of results) memoryStore.markRead(r.filePath);
          return `搜索结果（${results.length} 条匹配 "${args.query}"）：\n`
            + results.map(e => `  [${e.type}] ${e.name} — ${e.description}`).join('\n');
        }

        case 'read': {
          if (!args.name) return '读取失败：read 需要 name 参数';
          const entries = memoryStore.list();
          const target = entries.find(e => e.name === args.name);
          if (!target) return `没找到名为 "${args.name}" 的记忆。用 memory action=list 看现有条目`;
          // 真读了——更新 lastReadAt、告诉 validator "这条最近还在用、别 TTL 删了"
          memoryStore.markRead(target.filePath);
          return `记忆 "${target.name}" (${target.type}):\n\n${target.content}`;
        }

        case 'delete': {
          if (!args.name) return '删除失败：delete 需要 name 参数';
          const ok = memoryStore.delete(args.name);
          return ok
            ? `已删除记忆: ${args.name}`
            : `没找到名为 "${args.name}" 的记忆`;
        }

        case 'lint': {
          // 体检：跑 validator 全库、看有哪些问题——**默认不删**、只诊断
          // Agent 拿到报告后可以选择：调 delete 手动清、或者接受"待验证"提示
          // 参数 prune 显式传 true 才动手删过期条目
          const prune = (args as { prune?: boolean }).prune === true;
          const { reports, summary, pruned } = memoryStore.lintAndPrune('.', prune);
          const lines = [
            `[Memory Lint] 共 ${summary.total} 条：ok=${summary.ok} / warn=${summary.warn} / toDelete=${summary.toDelete}`,
            `  分类：stale_path=${summary.byKind.stale_path} / expired=${summary.byKind.expired} / stale_content=${summary.byKind.stale_content} / duplicate_name=${summary.byKind.duplicate_name}`,
          ];
          if (prune) {
            lines.push(`  已删除：${pruned} 条`);
          } else if (summary.toDelete > 0) {
            lines.push(`  提示：${summary.toDelete} 条建议删除、加参数 prune=true 才会实际清理`);
          }
          // 有 issue 的详情——Agent 看到能判断哪些要处理
          for (const r of reports) {
            if (r.issues.length === 0) continue;
            lines.push(`\n  [${r.entry.type}] ${r.entry.name}:`);
            for (const i of r.issues) {
              lines.push(`    - ${i.severity === 'delete' ? '✗' : '⚠'} ${i.message}`);
            }
          }
          return lines.join('\n');
        }

        default:
          return `未知 action: ${(args as { action: string }).action}——支持: save / list / search / read / delete / lint`;
      }
    },
  };
}
