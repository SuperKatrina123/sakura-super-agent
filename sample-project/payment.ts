// payment.ts —— 支付相关（假实现）

interface Order {
  id: string;
  amount: number;   // 单位：分
  currency: string;
  status: 'pending' | 'paid' | 'failed';
}

// TODO: 接入真实支付网关（Stripe / 支付宝 / 微信）
// TODO: 幂等性：同一 orderId 多次调用不能重复扣款
export async function chargeOrder(order: Order): Promise<Order> {
  // FIXME: 这里直接把状态改成 paid，等接了网关必须换成回调驱动
  // HACK: 演示用，模拟 200ms 网络延迟
  await new Promise(r => setTimeout(r, 200));
  return { ...order, status: 'paid' };
}

// TODO: 退款逻辑（部分退 / 全额退 / 手续费怎么算？先跟财务对齐）
export async function refund(orderId: string, amount?: number): Promise<never> {
  throw new Error('refund 尚未实现');
}

// XXX: 汇率写死是临时的，等接了实时汇率 API 再改
const FX_RATE_USD_TO_CNY = 7.2;

export function convertUSDToCNY(usdCents: number): number {
  // FIXME: 浮点误差没处理，金额相关必须用 Decimal 库
  return Math.round(usdCents * FX_RATE_USD_TO_CNY);
}
