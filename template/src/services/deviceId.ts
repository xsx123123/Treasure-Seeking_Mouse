// deviceId.ts：匿名设备标识生成（使用统计去重用，X-Stats-Actor 头的消费端）。
// 仅保留 getDeviceId；排行榜/云 RPC 上报等按业务需要自行扩展（见 README 扩展指南）。
const KEY_DEVICE = "{{PROJECT_SLUG}}-device-id";

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(KEY_DEVICE);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY_DEVICE, id);
    return id;
  } catch {
    // localStorage 不可用（隐私模式等）：退化为会话级随机 id
    return `ephemeral-${Math.random().toString(36).slice(2)}`;
  }
}