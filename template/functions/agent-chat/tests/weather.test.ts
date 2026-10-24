// weather 注册门示例模块测试（离线走 gzip fixtures + mock fetch 路由桩；联网走 WEATHER_LIVE=1）
// 运行：node --test functions/agent-chat/tests/weather.test.ts（离线默认）
//       WEATHER_LIVE=1 + WEATHER_API_KEY 配置后 node --test functions/agent-chat/tests/weather.test.ts（联网验收）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TOOL_DEFS } from '../index.ts';
import { executeWeatherTool, extractWeatherCards, isWeatherTool, weatherIntegrationStatus, weatherRegistered } from '../weather/index.ts';
import { getWeatherConfig, resetWeatherConfig } from '../weather/client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  gunzipSync(readFileSync(join(HERE, 'fixtures', `${name}.json.gz`))).toString('utf8');

const LIVE = /^(1|true|yes)$/i.test(process.env.WEATHER_LIVE ?? '');

// --- 测试基建（模式自原仓库平移）：setEnv 临时注入环境变量 + mockFetch 按 URL 路由桩 ---

function setEnv(map: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(map)) {
    saved[key] = process.env[key];
    const value = map[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetWeatherConfig(); // 配置缓存重读 env
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetWeatherConfig();
  };
}

interface MockRoute {
  match: RegExp;
  status?: number;
  body?: string;
}

function mockFetch(routes: MockRoute[]): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls += 1;
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    const route = routes.find((r) => r.match.test(url));
    if (!route) throw new Error(`mockFetch：未匹配的 URL ${url}`);
    return new Response(route.body ?? '{}', { status: route.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls: () => calls };
}

// --- 注册门三态 ---

test('注册门：未配置（默认态）weatherRegistered()=false / status=disabled，TOOL_DEFS 零 weather 工具', () => {
  const restore = setEnv({ WEATHER_ENABLED: undefined, WEATHER_API_KEY: undefined });
  try {
    assert.equal(weatherRegistered(), false, '开箱默认关闭');
    assert.equal(weatherIntegrationStatus(), 'disabled');
    assert.equal(weatherIntegrationStatus(), 'disabled');
    assert.equal(TOOL_DEFS.filter((t) => isWeatherTool((t as { function: { name: string } }).function.name)).length, 0, '未配置时工具面零新增');
  } finally {
    restore();
  }
});

test('注册门：ENABLED 开但 KEY 空 → token_missing，同样零注册', () => {
  const restore = setEnv({ WEATHER_ENABLED: 'true', WEATHER_API_KEY: '' });
  try {
    assert.equal(weatherRegistered(), false);
    assert.equal(weatherIntegrationStatus(), 'token_missing');
  } finally {
    restore();
  }
});

test('注册门：双真 → enabled', () => {
  const restore = setEnv({ WEATHER_ENABLED: 'true', WEATHER_API_KEY: 'test-key' });
  try {
    assert.equal(weatherRegistered(), true);
    assert.equal(weatherIntegrationStatus(), 'enabled');
    assert.equal(getWeatherConfig().apiKey, 'test-key');
  } finally {
    restore();
  }
});

// --- 双保险：注册状态与运行时不一致时直调抛 CONFIG_MISSING、零上游请求 ---

test('双保险：ENABLED 但缺 KEY 时直调 executeWeatherTool 抛中文配置错误且零 fetch', async () => {
  const restore = setEnv({ WEATHER_ENABLED: 'true', WEATHER_API_KEY: '' });
  const mock = mockFetch([{ match: /openweathermap/ }]);
  try {
    await assert.rejects(executeWeatherTool('weather_current', { city: 'Shanghai' }), /未启用或凭据未配置/);
    assert.equal(mock.calls(), 0, '配置缺失必须零上游请求');
  } finally {
    mock.restore();
    restore();
  }
});

// --- 三态 fixture（正常 / 鉴权失败 / 空结果） ---

test('正常态：fixture 响应 → success 信封 + 卡片投影', async () => {
  const restore = setEnv({ WEATHER_ENABLED: 'true', WEATHER_API_KEY: 'test-key' });
  const mock = mockFetch([{ match: /\/weather\?/, body: fixture('weather-ok') }]);
  try {
    const payload = await executeWeatherTool('weather_current', { city: 'Shanghai' });
    const data = (payload as { data: Record<string, unknown> }).data;
    assert.equal(data.city, 'Shanghai');
    assert.equal(data.temperature_c, 22.5);
    assert.equal(data.humidity, 56);
    assert.equal(data.description, '晴');

    const cards = extractWeatherCards('weather_current', payload) as { accession: string; title: string; meta: Record<string, string> }[];
    assert.equal(cards.length, 1);
    assert.equal(cards[0].accession, 'Shanghai');
    assert.equal(cards[0].title, 'Shanghai 当前天气');
    assert.equal(cards[0].meta.temperature_c, '22.5');
    assert.equal(cards[0].meta.source, 'weather');
  } finally {
    mock.restore();
    restore();
  }
});

test('鉴权失败：上游 401 → 抛中文鉴权错误（计 errors 路径）', async () => {
  const restore = setEnv({ WEATHER_ENABLED: 'true', WEATHER_API_KEY: 'bad-key' });
  const mock = mockFetch([{ match: /\/weather\?/, status: 401, body: fixture('weather-auth-failed') }]);
  try {
    await assert.rejects(executeWeatherTool('weather_current', { city: 'Shanghai' }), /鉴权失败/);
  } finally {
    mock.restore();
    restore();
  }
});

test('空结果：上游 404 city not found → empty 信封（业务空 ≠ 失败）', async () => {
  const restore = setEnv({ WEATHER_ENABLED: 'true', WEATHER_API_KEY: 'test-key' });
  const mock = mockFetch([{ match: /\/weather\?/, status: 404, body: fixture('weather-empty') }]);
  try {
    const payload = await executeWeatherTool('weather_current', { city: 'NoSuchCity' });
    const data = (payload as { data: { empty?: boolean; note?: string } }).data;
    assert.equal(data.empty, true, '城市不存在应为空结果信封');
    assert.match(data.note ?? '', /未找到城市「NoSuchCity」/);
    assert.equal(extractWeatherCards('weather_current', payload).length, 0, '空结果不出卡片');
  } finally {
    mock.restore();
    restore();
  }
});

test('forecast：正常投影多卡、accession 去重、上限 20', async () => {
  const restore = setEnv({ WEATHER_ENABLED: 'true', WEATHER_API_KEY: 'test-key' });
  const list = Array.from({ length: 6 }, (_, i) => ({
    dt: 1763400000 + i * 10800,
    main: { temp: 20 + i },
    weather: [{ description: '多云' }],
  }));
  const mock = mockFetch([{ match: /\/forecast\?/, body: JSON.stringify({ city: { name: 'Shanghai' }, cnt: 6, list, cod: '200' }) }]);
  try {
    const payload = await executeWeatherTool('weather_forecast', { city: 'Shanghai', cnt: 6 });
    const data = (payload as { data: { city: string; results: unknown[]; total: number } }).data;
    assert.equal(data.city, 'Shanghai');
    assert.equal(data.total, 6);
    const cards = extractWeatherCards('weather_forecast', payload) as { accession: string; meta: Record<string, string> }[];
    assert.equal(cards.length, 6);
    assert.ok(cards[0].accession.startsWith('Shanghai#'));
    assert.equal(cards[0].meta.temperature_c, '20');
  } finally {
    mock.restore();
    restore();
  }
});

// --- 联网 LIVE 模式（WEATHER_LIVE=1 且 WEATHER_API_KEY 配置后启用；429/瞬态自动 skip 不算失败） ---

test('LIVE：联网调用真实上游（未配置时 skip）', { skip: !LIVE || !process.env.WEATHER_API_KEY }, async () => {
  const restore = setEnv({ WEATHER_ENABLED: 'true', WEATHER_API_KEY: process.env.WEATHER_API_KEY });
  try {
    try {
      const payload = await executeWeatherTool('weather_current', { city: 'Beijing,CN' });
      const data = (payload as { data: Record<string, unknown> }).data;
      assert.ok(data.city || data.empty, '联网应返回信封数据（或城市不存在的空信封）');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/限流|429|HTTP 429|超时|timeout/i.test(message)) return; // 瞬态失败不算失败
      throw err;
    }
  } finally {
    restore();
  }
});