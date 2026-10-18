// shared.ts：跨模块共享的网络/配额基础设施（index.ts 与 biomed/ 共用同一份实现）。
// 以下符号自 index.ts 平移（剪切而非复制）：envGet / EUTILS / ncbiBucket+acquireNcbi /
// fetchWithRetry / sleep / eutilsParams；另新增 fetchTextWithRetry（同一退避循环、
// 返回原始响应文本，供 ClinVar efetch XML 端点使用）。
// 独立成模块的目的：biomed/ 领域模块与主函数共用基础设施，避免 index ↔ biomed 的 ES 循环依赖。

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

/** 跨运行时读环境变量：Deno（Meoo 平台）与 Node（本地自托管 server/local.mjs）皆可 */
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

export const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

// --- token bucket 限流：NCBI 无 key 3 req/s / 有 key 10 req/s，留 0.5 余量 ---
// 进程级单例（实例级共享预算：PubMed 文献链路 / NCBI 兜底 / ClinVar 工具公平消费同一桶）。
const ncbiBucket = { tokens: 2.5, last: Date.now(), capacity: 2.5 };
const NCBI_RATE = envGet('NCBI_API_KEY') ? 9.5 : 2.5;

export function acquireNcbi(): boolean {
  const now = Date.now();
  ncbiBucket.tokens = Math.min(ncbiBucket.capacity, ncbiBucket.tokens + ((now - ncbiBucket.last) / 1000) * NCBI_RATE);
  ncbiBucket.last = now;
  if (ncbiBucket.tokens >= 1) { ncbiBucket.tokens -= 1; return true; }
  return false; // 不排队等待：直接降级 Europe PMC（它无限流压力）
}

// --- HTTP helper：429/5xx 退避 1s/2s/4s，三次后抛出 ---
// init 可选参数支持 POST（MyGene 批量映射走表单提交）；既有 GET 调用点零改动。
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

/** 同 fetchWithRetry 的退避循环，但返回原始响应文本（XML 端点用，不做 JSON.parse）。
 *  ClinVar efetch XML 的 Accept 声明为 text/xml；超时/重试默认值按 ClinVar 预算取 8s × 2 次尝试。 */
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

export function eutilsParams(params: Record<string, string>): string {
  const usp = new URLSearchParams({ tool: 'go_xunbaoshu', ...params });
  const email = envGet('NCBI_EMAIL');
  const key = envGet('NCBI_API_KEY');
  if (email) usp.set('email', email);
  if (key) usp.set('api_key', key);
  return usp.toString();
}