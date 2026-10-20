// client.ts：protocols.io 唯一网络出口（design §2.4 / §2.5 / §2.6）。
// 不复用 shared.ts 的 fetchWithRetry 函数本体（其非 ok 时丢响应体，design §1.2.3 决策），
// 但退避语义与其完全一致：429/5xx 重试 1s/2s/4s、超时 AbortController、其余不重试。
// 核心差异：所有非 ok 响应先读 body 解析 protocols.io 业务码（status_code/error_message|status_text），
// 覆盖「HTTP 400 + 业务码 1218/1219 = 认证失败（匿名实测确认，非 401）」的六类错误分类。
//
// 网络预算：单次超时 7000ms（PROTOCOLS_IO_TIMEOUT_MS 可配，钳制 ≤10000）× 3 次尝试
// + 退避 1s + 2s = 最坏 24s ≤ 25s 红线（对齐 biomed/gene.ts 预算，design §2.1.3C）。
//
// 错误文案红线（design §2.5）：只含状态描述与建议动作，不回显 Authorization 头、Token、
// 原始 body 全文——body 摘要仅取 error_message/status_text 文本前 120 字。
//
// 依赖约束：仅 import shared.ts 与 types.ts（禁反向依赖主文件，ES 循环依赖红线）。

import { envGet, sleep } from '../shared.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

/** ASCII UA（踩坑记录：中文 UA 曾致 Node/undici 抛 TypeError） */
const PROTOCOLS_UA = 'ResearchTreasureMouse/1.0';

/** 已分类业务错误（六类）：捕获后直接上抛不重试——instanceof 判定，避免脆弱的消息前缀匹配 */
export class ProtocolsError extends Error {
  /** 404 类：detail 调用方据此转 not_found 信封（不计 errors，design §2.1.3D） */
  readonly notFound: boolean;
  constructor(message: string, notFound = false) {
    super(message);
    this.notFound = notFound;
  }
}

export function isProtocolsNotFound(err: unknown): boolean {
  return err instanceof ProtocolsError && err.notFound;
}

export interface ProtocolsConfig {
  enabled: boolean;
  token: string;
  /** API 整根地址（默认 https://www.protocols.io/api；只允许整根覆盖，路径由适配器拼接常量） */
  baseUrl: string;
  timeoutMs: number;
  searchTtlSec: number;
  detailTtlSec: number;
}

function parseBoolEnv(raw: string): boolean {
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function clampTimeout(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 7000;
  return Math.min(10000, Math.max(1000, Math.round(n)));
}

function clampTtl(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(3600, Math.max(30, Math.round(n)));
}

let cachedConfig: ProtocolsConfig | null = null;

/** 配置读取（模块级求值一次后缓存；envGet 同时读 Deno/Node 环境，双运行时一致） */
export function getProtocolsConfig(): ProtocolsConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = {
    enabled: parseBoolEnv(envGet('PROTOCOLS_IO_ENABLED')),
    token: envGet('PROTOCOLS_IO_CLIENT_ACCESS_TOKEN').trim(),
    baseUrl: (envGet('PROTOCOLS_IO_API_BASE_URL') || 'https://www.protocols.io/api').replace(/\/+$/, ''),
    timeoutMs: clampTimeout(envGet('PROTOCOLS_IO_TIMEOUT_MS')),
    searchTtlSec: clampTtl(envGet('PROTOCOLS_CACHE_TTL_SEC'), 300),
    detailTtlSec: clampTtl(envGet('PROTOCOLS_CACHE_TTL_SEC'), 600),
  };
  return cachedConfig;
}

/** 测试专用：重置配置缓存（用例 16/22 需要在不同 env 状态间切换） */
export function resetProtocolsConfigForTest(): void {
  cachedConfig = null;
}

// --- 短时缓存（design §2.6）：模块级 Map + 容量 2000 超限清最旧一半（复用 litCache 淘汰模式） ---

interface CacheEntry { expires: number; value: unknown }

const protocolsCache = new Map<string, CacheEntry>();
const CACHE_CAPACITY = 2000;

export function protocolsCacheGet<T>(key: string): T | undefined {
  const hit = protocolsCache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    protocolsCache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function protocolsCacheSet(key: string, value: unknown, ttlSec: number): void {
  if (protocolsCache.size >= CACHE_CAPACITY) {
    // Map 迭代序 = 插入序：清掉最旧一半
    const drop = Math.ceil(CACHE_CAPACITY / 2);
    let i = 0;
    for (const k of protocolsCache.keys()) {
      if (i++ >= drop) break;
      protocolsCache.delete(k);
    }
  }
  protocolsCache.set(key, { expires: Date.now() + ttlSec * 1000, value });
}

/** 测试专用：清空缓存（用例 9 缓存命中验证需要干净起点） */
export function resetProtocolsCacheForTest(): void {
  protocolsCache.clear();
}

// --- 错误分类（design §2.1.3B 状态机 + 分类→文案→统计口径映射表） ---

/** 业务错误体字段：v3 用 error_message，v4 用 status_text（匿名实测确认） */
function readBodyError(body: Record<string, unknown>): string {
  const msg = body.error_message ?? body.status_text;
  return typeof msg === 'string' ? msg.slice(0, 120) : '';
}

/** body 业务码分类（HTTP 200 带 status_code!==0 与 HTTP 400 共用，design §2.5） */
function classifyBusinessError(body: Record<string, unknown>): ProtocolsError {
  const code = typeof body.status_code === 'number' ? body.status_code : -1;
  const detail = readBodyError(body);
  if (code === 1218 || code === 1219) {
    // 认证失败（Token 无效/过期）：不重试（spec 5.2.2 场景 1——重试无意义）
    return new ProtocolsError(`协议服务认证失败（令牌无效或已过期），请联系部署者检查配置${detail ? `（${detail}）` : ''}`);
  }
  return new ProtocolsError(`协议服务请求参数被拒绝${detail ? `（${detail}）` : '（参数格式不符合上游要求）'}，请检查检索词与参数后重试`);
}

/** 上游 body 是否「指示不存在」（404 形态容错：HTTP 404 或 body 码指示，design §2.13 第 2 项待实测收紧） */
function bodyIndicatesNotFound(body: Record<string, unknown>): boolean {
  const text = readBodyError(body).toLowerCase();
  return /not\s*found|does\s*not\s*exist|no\s*protocol/.test(text);
}

/** protocols.io 唯一网络出口：认证防护 + 退避 + 业务错误体解析（design §2.5 示意逐条落地） */
export async function protocolsFetch(path: string, params?: Record<string, string>): Promise<Json> {
  const config = getProtocolsConfig();
  const token = config.token;
  // Token 前置防护（双保险路径，spec 5.2.1 规则 3）：空 Token 抛中文错误、零 fetch
  if (!token) {
    throw new ProtocolsError('实验方案服务令牌未配置，请联系部署者检查 PROTOCOLS_IO_CLIENT_ACCESS_TOKEN 配置');
  }
  const url = `${config.baseUrl}${path}${params ? `?${new URLSearchParams(params).toString()}` : ''}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': PROTOCOLS_UA,
  };
  let delay = 1000;
  let pendingWait: number | null = null; // 429 携带 Retry-After 时覆盖下一轮退避基数（design §2.5）
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(pendingWait ?? Math.min(delay, 4000));
      delay *= 2;
      pendingWait = null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers });
      if (resp.ok) {
        const text = await resp.text();
        let body: Json;
        try {
          body = JSON.parse(text) as Json;
        } catch {
          throw new ProtocolsError('实验方案服务暂时不可用（上游返回了非 JSON 响应），可稍后重试；本轮其余检索不受影响');
        }
        const bodyObj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
        // HTTP 200 + body status_code !== 0 同样按失败归类（spec 5.3.3 场景 3 双重检查）
        if (bodyObj && bodyObj.status_code !== undefined && bodyObj.status_code !== 0) {
          throw classifyBusinessError(bodyObj);
        }
        return body;
      }
      if (resp.status === 429 || resp.status >= 500) {
        // 退避统一在循环顶部执行（与 fetchWithRetry 同构）；429 带 Retry-After 时优先尊重
        if (attempt < 2) {
          const retryAfter = Number(resp.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 0) pendingWait = Math.min(retryAfter * 1000, 4000);
          continue;
        }
        if (resp.status === 429) throw new ProtocolsError('协议检索过于频繁（上游限流），请稍后重试');
        throw new ProtocolsError('实验方案服务暂时不可用，可稍后重试；本轮其余检索不受影响');
      }
      // 其余 4xx：读 body 分类（响应体是错误语义的核心载体，design §1.2.3）
      const text = await resp.text();
      let bodyObj: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(text) as Json;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bodyObj = parsed as Record<string, unknown>;
      } catch { /* 非 JSON body 走状态码分类 */ }
      if (resp.status === 400) {
        throw bodyObj ? classifyBusinessError(bodyObj) : new ProtocolsError('协议服务请求参数被拒绝（HTTP 400），请检查检索词与参数后重试');
      }
      if (resp.status === 403) {
        throw new ProtocolsError('该协议不公开，仅支持公开方案检索');
      }
      if (resp.status === 404 || (bodyObj && bodyIndicatesNotFound(bodyObj))) {
        // NOT_FOUND：以可识别形态抛出，由 detail 调用方转 not_found 信封（不计 errors）
        throw new ProtocolsError('该协议不存在或当前不可访问', true);
      }
      throw new ProtocolsError(`实验方案服务暂时不可用（HTTP ${resp.status}），可稍后重试；本轮其余检索不受影响`);
    } catch (err) {
      if (err instanceof ProtocolsError) {
        throw err; // 已分类的业务错误直接上抛（不重试）
      }
      // 网络层异常（超时 abort / 连接失败）：3 次尝试耗尽才上抛，避免表述为「协议不存在」（红线）
      if (attempt === 2) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new ProtocolsError(`实验方案服务暂时不可用（网络异常：${cause.slice(0, 80)}），可稍后重试；本轮其余检索不受影响`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('unreachable');
}