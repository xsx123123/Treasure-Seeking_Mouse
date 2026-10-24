// weather/current.ts：weather_current 工具实现（当前天气查询）。

import { WeatherError, getWeatherConfig, weatherFetch } from './client.ts';
import type { CurrentWeatherData, WeatherCurrentArgs } from './types.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

/** 空结果中性信封：success 形态返回，data.empty 标记供统计计为「空结果」而非错误 */
export function weatherEmptyResult(note: string): Json {
  return { success: true, data: { empty: true, note } };
}

/** 当前天气：城市不存在走空结果信封（业务空 ≠ 失败）；正常返回 {success:true, data:{...}} */
export async function getCurrentWeather(args: WeatherCurrentArgs): Promise<Json> {
  const config = getWeatherConfig();
  const city = String(args.city ?? '').trim();
  if (!city) throw new WeatherError('city 参数不能为空', 'upstream');
  const units = args.units === 'imperial' ? 'imperial' : 'metric';
  const json = await weatherFetch('/weather', { q: city, appid: config.apiKey, units, lang: 'zh_cn' });
  const data = json as unknown as CurrentWeatherData;
  if (typeof data.cod === 'number' && data.cod !== 200) {
    throw new WeatherError(`天气服务返回异常状态 ${data.cod}`, 'upstream');
  }
  const weather = Array.isArray(data.weather) ? data.weather[0] : undefined;
  return {
    success: true,
    data: {
      city: data.name,
      observed_at: new Date((data.dt ?? Date.now() / 1000) * 1000).toISOString(),
      temperature_c: data.main?.temp,
      feels_like_c: data.main?.feels_like,
      humidity: data.main?.humidity,
      wind_speed_ms: data.wind?.speed,
      condition: weather?.main,
      description: weather?.description,
      units: 'metric',
    },
  };
}