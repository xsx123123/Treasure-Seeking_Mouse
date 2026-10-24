// weather/index.ts：示例领域模块单点出口——「六项导出契约 + 注册门」的活教材。
//
// 契约面（使用者按此扩展自己的领域模块）：
//   1. WEATHER_TOOL_DEFS     工具定义集（OpenAI function schema）
//   2. WEATHER_TOOL_NAMES    工具名 as const 元组
//   3. isWeatherTool(name)   判属函数
//   4. executeWeatherTool(name, args)  执行入口（与主 executeTool 同签名同信封）
//   5. WEATHER_TOOL_LABELS   工具名 → 中文展示标签映射
//   6. extractWeatherCards(name, payload)  卡片投影（异常一律空数组）
//   7. weatherRegistered()   （可选）注册门 + weatherIntegrationStatus() 三态枚举
//
// 注册门：WEATHER_ENABLED 解析为真 且 WEATHER_API_KEY 非空才注册；开箱默认关闭。
// 双保险：executeWeatherTool 入口独立再校验——注册状态与运行时不一致时抛中文
// CONFIG_MISSING 类错误、零上游请求（主循环 catch 后以 {success:false,error} 信封
// 回灌模型并计 errors）。
//
// 依赖约束：仅本目录文件与 ../shared.ts，禁止 import 主 index.ts（ES 循环依赖红线）；
// schema 辅助（tool/reqStr/intOpt）与主 index.ts 同构复制——禁共享，避免反向依赖。

import { getWeatherConfig, WeatherConfigError, WeatherError } from './client.ts';
import { getCurrentWeather, weatherEmptyResult } from './current.ts';
import { getWeatherForecast } from './forecast.ts';
import type { WeatherCurrentArgs, WeatherForecastArgs, WeatherIntegrationStatus } from './types.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

// --- schema 辅助（与主 index.ts 同构复制，禁共享） ---

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}
function reqStr(desc: string) { return { type: 'string', description: desc }; }
function intOpt(desc: string) { return { type: 'integer', description: desc, nullable: true }; }

// --- 注册门与集成状态（配置在 client.ts 内缓存求值） ---

export function weatherRegistered(): boolean {
  const config = getWeatherConfig();
  return config.enabled && config.apiKey !== '';
}

export function weatherIntegrationStatus(): WeatherIntegrationStatus {
  const config = getWeatherConfig();
  if (!config.enabled) return 'disabled';
  return config.apiKey ? 'enabled' : 'token_missing';
}

// --- 工具 schema ---

export const WEATHER_TOOL_DEFS = [
  tool('weather_current',
    '查询指定城市的当前天气（温度、体感、湿度、风力、天气状况）。城市名可附国家/州消歧，如 Shanghai,CN 或 Portland,US。',
    {
      city: reqStr('城市名，可附国家/州名消歧（如 Beijing,CN）'),
    }, ['city']),
  tool('weather_forecast',
    '查询指定城市的短期天气预报（3 小时步长，默认 8 步 / 24 小时，最多 16 步）。',
    {
      city: reqStr('城市名，可附国家/州名消歧'),
      cnt: intOpt('预报步数（每步 3 小时），默认 8，最大 16'),
    }, ['city']),
];

export const WEATHER_TOOL_NAMES = ['weather_current', 'weather_forecast'] as const;

const WEATHER_TOOL_SET = new Set<string>(WEATHER_TOOL_NAMES);

export function isWeatherTool(name: string): boolean {
  return WEATHER_TOOL_SET.has(name);
}

export const WEATHER_TOOL_LABELS: Record<string, string> = {
  weather_current: '查询当前天气',
  weather_forecast: '查询天气预报',
};

// --- 执行入口（双保险校验 → 分发 → 业务空转换） ---

export async function executeWeatherTool(name: string, args: Record<string, Json | undefined>): Promise<Json> {
  const config = getWeatherConfig();
  if (!config.enabled || !config.apiKey) {
    throw new WeatherConfigError('天气工具未启用或凭据未配置（WEATHER_ENABLED / WEATHER_API_KEY），请联系部署者检查配置');
  }
  try {
    switch (name) {
      case 'weather_current': return await getCurrentWeather(args as unknown as WeatherCurrentArgs);
      case 'weather_forecast': return await getWeatherForecast(args as unknown as WeatherForecastArgs);
      default: throw new Error(`未知 weather 工具：${name}`);
    }
  } catch (err) {
    // 城市不存在是业务空结果（success + data.empty），不算失败——与统计 empties 口径对齐
    if (err instanceof WeatherError && err.kind === 'city_not_found') {
      return weatherEmptyResult(`未找到城市「${String(args.city ?? '')}」，请确认城市名拼写，或附国家/州名消歧（如 Shanghai,CN）`);
    }
    throw err;
  }
}

// --- 卡片投影（异常一律空数组：卡片失败不影响消息） ---

export function extractWeatherCards(name: string, payload: Json): Json[] {
  try {
    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    const obj = data as Record<string, unknown>;
    if (obj.empty === true) return []; // 空结果信封不出卡片

    if (name === 'weather_current') {
      const city = typeof obj.city === 'string' ? obj.city : '';
      if (!city) return [];
      const meta: Record<string, string> = { source: 'weather' };
      for (const key of ['temperature_c', 'feels_like_c', 'humidity', 'wind_speed_ms', 'condition', 'description', 'observed_at'] as const) {
        const v = obj[key];
        if (typeof v === 'string' || typeof v === 'number') meta[key] = String(v);
      }
      return [{
        tool: name,
        accession: city,
        title: `${city} 当前天气`,
        summary: typeof obj.description === 'string' ? obj.description : '',
        meta,
      }];
    }

    if (name === 'weather_forecast') {
      const city = typeof obj.city === 'string' ? obj.city : '';
      const list = Array.isArray(obj.results) ? obj.results : [];
      const cards: Json[] = [];
      const seen = new Set<string>();
      for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const it = item as Record<string, unknown>;
        const datetime = typeof it.datetime === 'string' ? it.datetime : '';
        if (!city || !datetime) continue;
        const accession = `${city}#${datetime}`;
        if (seen.has(accession)) continue; // accession 去重键
        seen.add(accession);
        const meta: Record<string, string> = { source: 'weather' };
        if (typeof it.temperature_c === 'number') meta.temperature_c = String(it.temperature_c);
        if (typeof it.description === 'string') meta.description = it.description;
        cards.push({ tool: name, accession, title: `${city} 预报 ${datetime}`, summary: typeof it.description === 'string' ? it.description : '', meta });
        if (cards.length >= 20) break; // 单次上限 20 张
      }
      return cards;
    }
    return [];
  } catch {
    return [];
  }
}