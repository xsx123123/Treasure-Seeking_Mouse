// weather/client.ts：示例领域模块的 HTTP 客户端与配置缓存。
//
// 演示要点（对齐原仓库领域模块的客户端范式）：
// - 注册门双保险的配置读取（enabled + token 非空才注册）；
// - fetchWithRetry 退避重试与 createTokenBucket 限流的消费方式；
// - 上游错误分类（本模块的 WeatherError 携带 kind，供执行层区分「业务空」与「真错误」）；
// - ⚠️ fetch 请求头必须 ASCII（ByteString 校验），User-Agent 一律 ASCII。
//
// 依赖约束：只 import 本模块文件与 ../shared.ts，禁止 import 主 index.ts（ES 循环依赖红线）。

import { createTokenBucket, envGet, fetchWithRetry, type TokenBucket } from '../shared.ts';
import type { WeatherConfig } from './types.ts';

/** 配置错误（注册门不一致 / 凭据缺失）：中文可读，主循环 catch 后以 {success:false,error} 信封回灌并计 errors */
export class WeatherConfigError extends Error {}

/** 上游错误（网络/鉴权/参数）：kind 供执行层分类 */
export class WeatherError extends Error {
  readonly kind: 'auth' | 'city_not_found' | 'upstream';
  constructor(message: string, kind: 'auth' | 'city_not_found' | 'upstream') {
    super(message);
    this.kind = kind;
  }
}

let cachedConfig: WeatherConfig | null = null;

/** 模块配置（进程内缓存求值一次；测试可经 resetWeatherConfig 重置后再设 env） */
export function getWeatherConfig(): WeatherConfig {
  if (cachedConfig) return cachedConfig;
  const rawTimeout = Number(envGet('WEATHER_TIMEOUT_MS'));
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 1000 && rawTimeout <= 15000 ? Math.round(rawTimeout) : 8000;
  cachedConfig = {
    enabled: /^(1|true|yes)$/i.test(envGet('WEATHER_ENABLED')),
    apiKey: envGet('WEATHER_API_KEY').trim(),
    baseUrl: envGet('WEATHER_API_BASE_URL') || 'https://api.openweathermap.org/data/2.5',
    timeoutMs,
  };
  return cachedConfig;
}

/** 测试辅助：清空配置缓存（下一次 getWeatherConfig 重新读 env） */
export function resetWeatherConfig(): void {
  cachedConfig = null;
}

// 免费档限流预算：60 次/分钟 ≈ 1 次/秒，速率留 0.5 余量、容量 10 容忍短突发
// （token 拿不到直接走错误路径，不排队——限流是调用方的降级信号）
const weatherBucket: TokenBucket = createTokenBucket(0.5, 10);

/**
 * 上游 JSON 调用：URL 拼参 + Bearer 无需（OpenWeatherMap 用 appid 查询参）。
 * 错误分类：401/403 → auth；404 且 message 含 city not found → city_not_found（业务空）；
 * 其余 → upstream。429/5xx 由 fetchWithRetry 退避重试，耗尽后抛原始错误。
 */
export async function weatherFetch(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  if (!weatherBucket.acquire()) {
    throw new WeatherError('天气服务限流预算用尽，请稍后重试', 'upstream');
  }
  const usp = new URLSearchParams(params);
  const url = `${getWeatherConfig().baseUrl}${path}?${usp.toString()}`;
  try {
    const json = await fetchWithRetry(url, getWeatherConfig().timeoutMs, 2, { 'User-Agent': 'AgentTemplateWeather/1.0' });
    return json as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP 40[13]/.test(message)) {
      throw new WeatherError('天气服务鉴权失败：请检查 WEATHER_API_KEY 是否有效或已过期', 'auth');
    }
    if (/HTTP 404/.test(message)) {
      // OpenWeatherMap 城市不存在也回 404：交给调用方按业务空结果处理
      throw new WeatherError('city not found', 'city_not_found');
    }
    throw new WeatherError(`天气服务请求失败：${message}`, 'upstream');
  }
}