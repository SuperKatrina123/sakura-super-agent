import fs from 'node:fs';
import path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// SkillLoader：加载 .skills/ 目录下的 skill 定义
// ═══════════════════════════════════════════════════════════════════════════
//
// 目录结构：
//   .skills/
//   ├── code-review/
//   │   ├── SKILL.md         ← YAML frontmatter + body
//   │   └── checklist.md     ← skill 可以有辅助文件（body 里可引用相对路径）
//   ├── commit/
//   │   └── SKILL.md
//   └── ...
//
// 渐进式加载三层（对齐 Claude Code）：
//   Level 1: 启动只加载 frontmatter（name + description + when_to_use、每 skill ~100 tokens）
//   Level 2: 激活后完整 body 进 SYSTEM
//   Level 3: skill 目录下的参考文件、Agent 用 read_file 按需读——**不需要额外抽象**
//            "skill 的辅助文件就是普通文件、复用现有能力"是这个方案最漂亮的部分
//
// **策略**：100 个 skill 初始也就 10K tokens、不会把 SYSTEM 撑爆
//
// **关键设计**：
//   - **strict mode**：没 frontmatter 或 description 缺失就 skip、逼作者写清元数据
//   - **when_to_use** 是"激活线索"——比 description 更明确"什么时候该用这个 skill"
//     Agent 看到未激活 skill 时、when_to_use 帮它决策"要不要激活"
//     （Claude Code 原生只有 name + description、把"何时用"写进 description；
//      本项目保留独立字段、教学上更清晰，也允许 description 只写"是什么"）
//   - **dirPath 保留**：Level 3 靠这个——skill body 里的相对路径基准
//   - **activeSkills 在 loader 里维护**——跟 discoveredTools 同 pattern

export interface SkillDefinition {
  name: string;         // 从目录名取（比如 "code-review"）
  description: string;  // 从 frontmatter——必填、否则 skip
  whenToUse?: string;   // 可选、"激活线索"——buildPromptSection 里附加显示
  content: string;      // body markdown、激活时注入 SYSTEM
  dirPath: string;      // skill 目录——Level 3 引用辅助文件的基准
}

const SKILLS_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
  private readonly baseDir: string;
  private skills = new Map<string, SkillDefinition>();
  // 已激活的 skill 名——跟 discoveredTools 同 pattern
  // 激活后完整 content 进 SYSTEM、Agent 一进 loop 就看到指令
  private activeSkills = new Set<string>();

  constructor(baseDir = '.') {
    this.baseDir = baseDir;
  }

  // 扫描 .skills/、解析每个子目录的 SKILL.md
  // 幂等——反复调只会覆盖 map、activeSkills 保留
  load(): SkillDefinition[] {
    this.skills.clear();
    const skillsDir = path.join(this.baseDir, SKILLS_DIR);
    if (!fs.existsSync(skillsDir)) return [];

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, SKILL_FILE);
      if (!fs.existsSync(skillFile)) continue;

      const raw = fs.readFileSync(skillFile, 'utf-8');
      const parsed = this.parseFrontmatter(raw);
      if (!parsed) continue;   // strict: description 缺失 = skip

      this.skills.set(entry.name, {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        dirPath: path.join(skillsDir, entry.name),
      });
    }
    return this.list();
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  // 激活/停用——由 skill_load 元工具或 REPL 命令调用
  // 返回值：是否成功（找不到 skill 就 false）
  activate(name: string): boolean {
    if (!this.skills.has(name)) return false;
    this.activeSkills.add(name);
    return true;
  }

  deactivate(name: string): boolean {
    return this.activeSkills.delete(name);
  }

  isActive(name: string): boolean {
    return this.activeSkills.has(name);
  }

  // 生成挂到 SYSTEM 的 skills section——渐进式加载的核心
  //   激活的 skill    → 注入完整 content（Agent 一进 loop 就看到详细指令）
  //   未激活的 skill  → 只显示 name + description（Agent 知道有这个能力、按需 load）
  // 无 skill 时返回 null——segment 不出现、不占 SYSTEM 空间
  buildPromptSection(): string | null {
    if (this.skills.size === 0) return null;
    const lines: string[] = [];

    // 已激活的完整注入
    for (const name of this.activeSkills) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      lines.push(`[激活的 Skill: ${skill.name}]`);
      lines.push(skill.content);
      lines.push('');
    }

    // 未激活的只列名字 + 描述（+ whenToUse 如果有）——足够 Agent 判断"要不要激活"
    // when_to_use 是"激活线索"、比 description 更明确"什么时候用这个 skill"
    const available = this.list()
      .filter(s => !this.activeSkills.has(s.name))
      .map(s => {
        const base = `  ${s.name} — ${s.description}`;
        return s.whenToUse ? `${base}（适用场景: ${s.whenToUse}）` : base;
      });
    if (available.length > 0) {
      lines.push('可用的 Skills（用 skill_load 工具激活获取完整指令）：');
      lines.push(...available);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }

  // 简易 YAML frontmatter 解析——生产建议 gray-matter
  // strict: description 缺失 → 返回 null、skip 这个 skill
  // 允许 description 用双引号包裹（YAML 常见写法）
  // 兼容两种写法：when_to_use（snake_case、Claude Code 风格）和 whenToUse（camelCase）
  private parseFrontmatter(raw: string): { description: string; whenToUse?: string; content: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;   // strict: 没 frontmatter = 无描述 = skip

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        meta[key] = value;
      }
    }
    if (!meta.description) return null;   // strict: description 必填
    // when_to_use / whenToUse 两种命名都接受——作者用哪个都行
    const whenToUse = meta.when_to_use || meta.whenToUse;
    return {
      description: meta.description,
      whenToUse: whenToUse || undefined,
      content: match[2].trim(),
    };
  }

  // Debug——启动时打印当前 skill 状态
  stats(): { count: number; active: number; skillNames: string[] } {
    return {
      count: this.skills.size,
      active: this.activeSkills.size,
      skillNames: [...this.skills.keys()],
    };
  }
}