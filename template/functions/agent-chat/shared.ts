// shared.ts：跨模块共享的网络/配额基础设施（index.ts 与领域模块共用同一份实现）。
// 独立成模块的目的：领域模块（如 weather/）与主函数共用基础设施，避免 ES 循环依赖。
//
// ⚠️ 约束：fetch 请求头必须是 ASCII（ByteString 校验）——曾用中文 User-Agent 导致
// Node/undici 直接抛 TypeError（curl 能过是因为它在发送前不校验）。自定义头一律 ASCII。

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

/** 跨运行时读环境变量：Deno 与 Node（本地自托管 server/local.mjs）皆可 */
export function envGet(key: string): string {
  const deno = (globalThis as Record<string, unknown>).Deno as
    | { env?: { get: (k: string) => string | undefined } }
    | undefined;
  const fromDeno = deno?.env?.get(key);
  if (fromDeno) return fromDeno;
  const proc = (globalThis as Record<string, unknown>).process as
    | { env?: Record<string, string | undefined> }
    | undefined;
  return proc?.env?.[key] ?? '';
}

// --- 通用令牌桶限流工厂：按「每秒补充速率 + 容量」创建实例级限流预算 ---
// 不排队等待：acquire() 返回 false 时由调用方决定降级策略（如跳过兜底、直接报错）。
export interface TokenBucket {
  /** 尝试取一个令牌：true=拿到（调用方继续），false=预算用尽（调用方自行降级） */
  acquire(): boolean;
}

export function createTokenBucket(ratePerSec: number, capacity: number): TokenBucket {
  const state = { tokens: capacity, last: Date.now() };
  return {
    acquire(): boolean {
      const now = Date.now();
      state.tokens = Math.min(capacity, state.tokens + ((now - state.last) / 1000) * ratePerSec);
      state.last = now;
      if (state.tokens >= 1) { state.tokens -= 1; return true; }
      return false;
    },
  };
}

// --- HTTP helper：429/5xx 退避 1s/2s/4s，三次后抛出 ---
// init 可选参数支持 POST（批量提交场景）；既有 GET 调用点零改动。
export async function fetchWithRetry(url: string, timeoutMs = 6000, retries = 3, headers: Record<string, string> = {}, init?: { method?: 'GET' | 'POST'; body?: string }): Promise<Json> {
  let delay = 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(delay, 4000));
      delay *= 2;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method: init?.method ?? 'GET', body: init?.body, signal: controller.signal, headers: { Accept: 'application/json', ...headers } });
      if (resp.ok) return JSON.parse(await resp.text()) as Json;
      if (resp.status === 429 || resp.status >= 500) continue; // 重试
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      if (attempt === retries) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('unreachable');
}

/** 同 fetchWithRetry 的退避循环，但返回原始响应文本（XML/纯文本端点用，不做 JSON.parse） */
export async function fetchTextWithRetry(url: string, timeoutMs = 8000, retries = 1, headers: Record<string, string> = {}): Promise<string> {
  let delay = 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(delay, 4000));
      delay *= 2;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/xml, application/xml, */*', ...headers } });
      if (resp.ok) return await resp.text();
      if (resp.status === 429 || resp.status >= 500) continue; // 重试
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      if (attempt === retries) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('unreachable');
}

export function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }