import type { MemoryStore } from '../memory/store.ts';

// PromptContext: segment 能拿到的运行时数据
// 原则：只放"数据"、不放"格式化好的字符串"——格式化是 segment 的职责
// 这样将来想改 defer 目录的呈现方式（表格 / 分组 / top-N），只动 segment 不动 registry
export interface PromptContext {
  toolCount: number;
  deferredTools: Array<{ name: string; hint?: string }>;   // 原始列表，segment 自己拼
  sessionMessageCount: number;
  sessionId: string;
  // memory store 引用——memoryContext segment 会调它的 buildPromptSection()
  // 传引用而不是原始数据：memory 有 "过期提醒" 之类的动态逻辑、留在 store 内聚
  memoryStore?: MemoryStore;
}

// PipeFn: 一个函数决定"要不要出现"+"出现时长啥样"
// 返回 null = 这个 segment 本轮不出现（disabled）
// 返回 string = 这个 segment 的内容（如果是空串也算 disabled，避免 prompt 里出现空行）
type PipeFn = (ctx: PromptContext) => string | null;

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = [];

  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn });
    return this;
  }

  build(ctx: PromptContext): string {
    const sections: string[] = [];
    for (const { fn } of this.pipes) {
      const result = fn(ctx);
      // 空串也当 disabled 处理——避免最终 prompt 里连续两个 \n\n
      if (result !== null && result !== '') {
        sections.push(result);
      }
    }
    return sections.join('\n\n');
  }

  debug(ctx: PromptContext): void {
    console.log('\n=== Prompt Pipe Debug ===');
    let total = 0;
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx);
      if (result !== null && result !== '') {
        console.log(`  [ON]  ${name}: ${result.length} chars`);
        total += result.length;
      } else {
        console.log(`  [OFF] ${name}`);
      }
    }
    console.log(`  ────────────────────────`);
    console.log(`  Total: ${total} chars`);
    console.log('========================\n');
  }
}
