import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';

interface FeishuConfig {
  appId: string;
  appSecret: string;
  port: number;
}

export class FeishuChannel implements ChannelDefinition {
  name = 'feishu';
  description = '飞书 Bot 消息通道（长连接模式）';

  private config: FeishuConfig;
  private messageHandler?: (msg: IncomingMessage) => void;
  private httpServer?: any;
  private wsClient?: any;
  private larkClient?: any;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async stop(): Promise<void> {
    // 停 WebSocket 长连接——避免飞书服务端持有幽灵订阅
    if (this.wsClient) {
      try { await this.wsClient.close?.(); } catch { /* SDK 可能没暴露 close */ }
      this.wsClient = undefined;
    }
    // 停 Hono 状态面板 HTTP 服务器——释放端口
    if (this.httpServer) {
      try { await new Promise<void>((resolve, reject) => {
        this.httpServer.close((err: unknown) => err ? reject(err) : resolve());
      }); } catch { /* server 已关 or 未暴露 close */ }
      this.httpServer = undefined;
    }
    this.larkClient = undefined;
  }

  private async startDashboard(): Promise<void> {
    // 状态面板——用 node:http 起一个最小 HTTP 服务器
    // 根路径返回配置状态、方便 debug（是否连上飞书、端口占用等）
    // 生产可换成 Hono / express、这里保持零依赖
    const http = await import('node:http');
    this.httpServer = http.createServer((req, res) => {
      const url = req.url || '/';
      if (url === '/' || url === '/status') {
        const configured = Boolean(this.config.appId && this.config.appSecret);
        const wsConnected = Boolean(this.wsClient);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<meta charset="utf-8">
<title>Feishu Channel Dashboard</title>
<style>body{font-family:system-ui;padding:2rem;max-width:640px;margin:auto}
.ok{color:#0a0}.fail{color:#c00}code{background:#eee;padding:.2em .4em;border-radius:3px}</style>
<h1>🤖 Feishu Channel</h1>
<ul>
  <li>飞书配置：<span class="${configured ? 'ok' : 'fail'}">${configured ? '✓ 已配置' : '✗ 未配置 (设 FEISHU_APP_ID / FEISHU_APP_SECRET)'}</span></li>
  <li>长连接：<span class="${wsConnected ? 'ok' : 'fail'}">${wsConnected ? '✓ 已建立' : '✗ 未建立'}</span></li>
  <li>Dashboard 端口：<code>${this.config.port}</code></li>
</ul>
<p>状态 JSON：<a href="/api/status">/api/status</a></p>`);
        return;
      }
      if (url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          configured: Boolean(this.config.appId && this.config.appSecret),
          wsConnected: Boolean(this.wsClient),
          port: this.config.port,
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.config.port, () => {
        this.httpServer.off('error', reject);
        console.log(`    Dashboard: http://localhost:${this.config.port}`);
        resolve();
      });
    });
  }

  async start(): Promise<void> {
    await this.startDashboard(); // 状态面板，不管有没有配飞书都起

    if (!this.config.appId || !this.config.appSecret) {
      console.log('    飞书未配置，仅启动 Dashboard');
      return;
    }

    // 用飞书 SDK 的长连接模式
    const lark = await import('@larksuiteoapi/node-sdk');

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const dispatcher = new lark.EventDispatcher({});

    dispatcher.register({
      'im.message.receive_v1': (data) => {
        if (data.message.message_type !== 'text') return;
        const content = JSON.parse(data.message.content);
        let text = content.text || '';
        // 去掉 @Bot 的 mention 标记
        if (data.message.mentions) {
          for (const m of data.message.mentions) {
            text = text.replace(m.key, '').trim();
          }
        }
        if (text && this.messageHandler) {
          this.messageHandler({
            channelId: data.message.chat_id,
            senderId: data.sender.sender_id?.open_id || 'unknown',
            senderName: data.sender.sender_id?.open_id || 'unknown',
            text,
            raw: data,
          });
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('    飞书长连接已建立（无需 ngrok）');
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      console.log(`    [feishu] 未配置飞书，跳过发送`);
      return;
    }
    await this.larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: message.channelId,
        msg_type: 'text',
        content: JSON.stringify({ text: message.text }),
      },
    });
  }

  // startDashboard() 省略——起一个 Hono HTTP 服务，
  // 根路径返回状态面板页，/webhook/feishu 保留模拟测试能力
}
