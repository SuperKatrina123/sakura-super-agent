import type { ToolDefinition } from './tool-registry.ts';
import type { SkillLoader } from '../skills/loader.ts';

// ═══════════════════════════════════════════════════════════════════════════
// createSkillLoadTool：把 skill 激活暴露为元工具
// ═══════════════════════════════════════════════════════════════════════════
//
// 跟 tool_search / memory 元工具同 pattern：**闭包捕获 loader、Agent 通过 name 激活**
//
// 触发流程：
//   1. Agent 看 SYSTEM 里的"可用 Skills"列表（name + description + when_to_use）
//   2. 判断当前任务匹配某个 skill 的 when_to_use
//   3. 调 skill_load(name)——loader 把该 skill 加进 activeSkills
//   4. 下一轮 loop 时、buildPromptSection 把完整 body 注入 SYSTEM
//   5. Agent 按 body 里的指令执行任务
//
// 激活是"渐进的"：body 不进 tool call 返回值、只让"下轮 SYSTEM 包含 body"
// 这样 Agent 看到的**完整 skill 指令**跟其他 SYSTEM 内容一起显示、更符合"系统级指令"语义

export function createSkillLoadTool(loader: SkillLoader): ToolDefinition {
  return {
    name: 'skill_load',
    description: `激活一个 skill。传入 name（从 SYSTEM 的"可用 Skills"列表选）、下一轮 SYSTEM 就会包含该 skill 的完整指令。

**何时用**：用户的任务匹配某个 skill 的 when_to_use 描述——**别自己重复推理、直接激活让 skill 指导你怎么做**。

**不用重复激活**：skill 一旦激活就一直在 SYSTEM 里、别每次都调。看到"[激活的 Skill]"标记就说明已经加载了。`,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'skill 名（跟"可用 Skills"列表里的完全一致、不是描述）',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,   // 严格说改了 activeSkills、但语义上是"配置激活"、不改外部
    execute: async ({ name }: { name: string }) => {
      if (loader.isActive(name)) {
        return `[Skill] "${name}" 已经激活、无需重复加载。SYSTEM 里应能看到"[激活的 Skill: ${name}]"标记`;
      }
      const ok = loader.activate(name);
      if (!ok) {
        const available = loader.list().map(s => s.name).join(', ');
        return `[Skill] 没找到名为 "${name}" 的 skill。当前可用: ${available || '(空)'}`;
      }
      const skill = loader.get(name)!;
      // 返回值告诉 Agent"下轮就能看到完整指令"——不用在 tool result 里塞 body（浪费 tokens）
      return `[Skill] 已激活 "${name}"（${skill.description}）。下一步：按下轮 SYSTEM 里的完整指令执行`;
    },
  };
}
