// weather/types.ts：示例领域模块的类型定义（对齐原仓库领域模块的类型层组织范式）。

/** 模块配置（client.ts 内缓存求值一次） */
export interface WeatherConfig {
  /** WEATHER_ENABLED 解析为真 */
  enabled: boolean;
  /** WEATHER_API_KEY（非空才注册；仅服务端读取，绝不进入前端构建产物） */
  apiKey: string;
  /** WEATHER_API_BASE_URL 覆盖（默认 OpenWeatherMap 根地址） */
  baseUrl: string;
  /** 单次请求超时毫秒数（钳制 1000-15000，默认 8000） */
  timeoutMs: number;
}

/** 集成状态三态枚举（不含凭据值任何信息） */
export type WeatherIntegrationStatus = 'disabled' | 'token_missing' | 'enabled';

/** 当前天气上游响应（OpenWeatherMap /data/2.5/weather 摘要） */
export interface CurrentWeatherData {
  name: string;
  dt: number;
  main: { temp: number; feels_like: number; humidity: number };
  weather: { id: number; main: string; description: string }[];
  wind: { speed: number };
  cod: number;
}

/** 预报上游响应（OpenWeatherMap /data/2.5/forecast 摘要） */
export interface ForecastData {
  city: { name: string };
  cnt: number;
  list: { dt: number; main: { temp: number }; weather: { description: string }[] }[];
  cod: string;
}

/** 工具入参（与 schema 一一对应） */
export interface WeatherCurrentArgs {
  city: string;
  units?: string;
}

export interface WeatherForecastArgs {
  city: string;
  cnt?: number;
}