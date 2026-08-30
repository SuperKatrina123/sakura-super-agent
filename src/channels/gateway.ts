import type { ModelMessage } from 'ai';
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { agentLoop } from '../agent/loop.js';

interface GatewayOptions {
  model: any;
  registry: ToolRegistry;
  buildSystem: () => string;
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>();
  private sessions = new Map<string, ModelMessage[]>();
  private options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel);

    channel.onMessage?.((msg: IncomingMessage) => {
      this.handleIncoming(channel.name, msg);
    });
  }

  async startAll(): Promise<void> {
    for (const [name, ch] of this.channels) {
      try {
        await ch.start();
        console.log(`  [gateway] ✓ ${name} 已启动`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [, ch] of this.channels) {
      await ch.stop();
    }
  }

  private async handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
    const sessionKey = `${channelName}:${msg.senderId}`;
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }
    const messages = this.sessions.get(sessionKey)!;

    const userMsg: ModelMessage = { role: 'user', content: msg.text };
    messages.push(userMsg);

    const system = this.options.buildSystem();
    await agentLoop(this.options.model, this.options.registry, messages, system);

    // 从 messages 里取最后一条 assistant 消息作为回复
    const lastMsg = messages[messages.length - 1];
    let replyText = '';
    if (lastMsg && lastMsg.role === 'assistant') {
      const content = lastMsg.content;
      if (typeof content === 'string') {
        replyText = content;
      } else if (Array.isArray(content)) {
        replyText = content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
      }
    }

    if (replyText) {
      const channel = this.channels.get(channelName);
      if (channel) {
        await channel.send({
          channelId: msg.channelId,
          recipientId: msg.senderId,
          text: replyText,
        });
        console.log(`  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`);
      }
    }
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map(ch => ({
      name: ch.name,
      description: ch.description,
    }));
  }
}
