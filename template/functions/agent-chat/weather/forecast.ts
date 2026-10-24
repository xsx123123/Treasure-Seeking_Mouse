// weather/forecast.ts：weather_forecast 工具实现（短期预报查询）。

import { WeatherError, getWeatherConfig, weatherFetch } from './client.ts';
import type { ForecastData, WeatherForecastArgs } from './types.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

import { weatherEmptyResult } from './current.ts';

/** 预报：城市不存在走空结果信封；cnt 钳制 1-16（OpenWeatherMap 3 小时步长上限 40，收敛到 16） */
export async function getWeatherForecast(args: WeatherForecastArgs): Promise<Json> {
  const config = getWeatherConfig();
  const city = String(args.city ?? '').trim();
  if (!city) throw new WeatherError('city 参数不能为空', 'upstream');
  const cnt = Number(args.cnt);
  const steps = Number.isFinite(cnt) ? Math.min(16, Math.max(1, Math.floor(cnt))) : 8;
  const json = await weatherFetch('/forecast', { q: city, appid: config.apiKey, units: 'metric', cnt: String(steps) });
  const data = json as unknown as ForecastData;
  const list = Array.isArray(data.list) ? data.list : [];
  if (list.length === 0) return weatherEmptyResult(`未取得 ${city} 的预报数据（上游返回空列表）`);
  return {
    success: true,
    data: {
      city: data.city?.name ?? city,
      steps,
      results: list.map((item) => ({
        datetime: new Date(item.dt * 1000).toISOString(),
        temperature_c: item.main?.temp,
        description: Array.isArray(item.weather) ? item.weather[0]?.description : undefined,
      })),
      total: list.length,
    },
  };
}