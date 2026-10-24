// agent-chat: 通用 Agent 对话服务（tool-calling 多轮循环 + SSE 流式下行）。
// 1) LLM（OpenAI 兼容 + tools）决定调用哪个工具；
// 2) 函数内执行工具（内置示例 echo/demo_cards + 可选注册门模块 weather/）；
// 3) 流式返回 SSE：delta 为文本增量；event: tool / event: cards / event: grounding 供前端展示。
//
// 提示词维护：SYSTEM_PROMPT 双语文本外置在 prompts/system-{zh,en}.md（唯一可编辑来源），
// 经 npm run sync:prompts 生成 prompts.generated.ts 后从这里导入；tests/prompts-sync.test.ts 守住漂移。
// 行为参数（轮次/超时/心跳等）单点定义于 config.ts，经 AGENT_* 环境变量可覆盖。

import { SYSTEM_PROMPT, SYSTEM_PROMPT_EN } from './prompts.generated.ts';
import { INTENT_FILTER_SLOTS, INTENT_NEEDS_DESCRIPTION, INTENT_NEEDS_FLAG } from './intent-vocab.ts';
import { INTENT_TARGETS, parseResearchIntent, type ResearchIntent } from './intent.ts';
import { WEATHER_TOOL_DEFS, WEATHER_TOOL_LABELS, executeWeatherTool, extractWeatherCards, isWeatherTool, weatherIntegrationStatus, weatherRegistered } from './weather/index.ts';
import { envGet, fetchWithRetry } from './shared.ts';
import { agentConfig } from './config.ts';
export { SYSTEM_PROMPT, SYSTEM_PROMPT_EN };
export { envGet, fetchWithRetry, fetchTextWithRetry, sleep, createTokenBucket } from './shared.ts';
export type { TokenBucket } from './shared.ts';

// 环境变量（Deno / Node 通用；本地自托管时在 server/.env 或进程 env 覆盖）：
//   LLM_API_KEY       必填：OpenAI 兼容接口密钥
//   LLM_BASE_URL      可选：OpenAI 兼容接口根地址
//   LLM_MODEL         可选：请求未指定模型时的默认值
//   CHAT_SHARED_SECRET 可选：配置后对话接口要求 X-Chat-Key 匹配；未配置则无鉴权（启动时会打印警告）
//   WEATHER_ENABLED / WEATHER_API_KEY 可选：示例注册门模块（默认关闭，零注册）
//   AGENT_*           行为参数覆盖（见 config.ts）
const LLM_BASE_URL = envGet('LLM_BASE_URL') || 'https://api.example.com/v1';
const DEFAULT_MODEL = envGet('LLM_MODEL') || 'default-model';
const FUNCTION_NAME = '{{PROJECT_SLUG}}-chat';

// 启动自检：CHAT_SHARED_SECRET 未配置时对话接口无任何鉴权，端点暴露到哪，谁就能消耗
// LLM 额度。不改成默认拒绝（破坏本地体验），但必须在启动日志里醒目提示。
if (!envGet('CHAT_SHARED_SECRET')) {
  console.warn(
    `[${FUNCTION_NAME}] ⚠️ 未配置 CHAT_SHARED_SECRET：对话接口当前无鉴权，` +
    `任何能访问该端点的调用者都可直接消耗 LLM 额度。自托管/公网部署请务必配置 ` +
    `CHAT_SHARED_SECRET，并让前端请求携带 X-Chat-Key 头。`,
  );
}

// weather 示例模块集成状态一行：token_missing 态提示部署者补凭据，disabled（默认关闭）静默。
{
  const status = weatherIntegrationStatus();
  if (status === 'token_missing') {
    console.warn(
      `[${FUNCTION_NAME}] ⚠️ WEATHER_ENABLED 已开启但未配置 WEATHER_API_KEY：` +
      `天气工具不会注册（/stats 显示 token_missing）。请补配凭据，或改回 WEATHER_ENABLED=false。`,
    );
  } else {
    console.info(`[${FUNCTION_NAME}] weather 示例模块集成：${status === 'enabled' ? '已启用' : '未启用（默认关闭）'}`);
  }
}

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

interface ChatMsg {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ---------- 使用统计（内存聚合；GET <endpoint>/stats 供前端统计面板读取） ----------
// 自托管 Node 由 server/local.mjs 定期持久化到 server/.stats.json 并在启动时恢复。

export interface ToolUsageEntry {
  name: string;
  label: string;
  count: number;
  errors: number;
  /** 业务性空结果次数——与真错误分开统计，不算失败 */
  empties: number;
}

export interface UsageStatsSnapshot {
  chats: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
  /** 去重使用人数（按前端上报的 X-Stats-Actor：登录用户 id 或访客设备指纹） */
  actors: number;
  /** 每个工具的调用次数，按 count 降序 */
  tools: ToolUsageEntry[];
  since: string;
  updatedAt: string;
}

const usageStats = {
  chats: 0,
  llmCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  toolCalls: 0,
  toolErrors: 0,
  tools: {} as Record<string, { count: number; errors: number; empties: number }>,
  actors: {} as Record<string, 1>,
  since: new Date().toISOString(),
  updatedAt: '',
};

export function getUsageStatsSnapshot(): UsageStatsSnapshot {
  return {
    chats: usageStats.chats,
    llmCalls: usageStats.llmCalls,
    promptTokens: usageStats.promptTokens,
    completionTokens: usageStats.completionTokens,
    totalTokens: usageStats.totalTokens,
    toolCalls: usageStats.toolCalls,
    toolErrors: usageStats.toolErrors,
    actors: Object.keys(usageStats.actors).length,
    tools: Object.entries(usageStats.tools)
      .map(([name, v]) => ({ name, label: labelOf(name), count: v.count, errors: v.errors, empties: v.empties }))
      .sort((a, b) => b.count - a.count),
    since: usageStats.since,
    updatedAt: usageStats.updatedAt,
  };
}

/** 内部形态的完整转储（含 actors 明细），仅供持久化用；API 响应用上面的 snapshot（actors 只给计数） */
export function dumpUsageStats(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(usageStats)) as Record<string, unknown>;
}

/** local.mjs 启动时恢复上次持久化的统计（兼容内部转储与 API 快照两种形态） */
export function restoreUsageStats(saved: unknown): void {
  if (!saved || typeof saved !== 'object') return;
  const s = saved as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  usageStats.chats = num(s.chats);
  usageStats.llmCalls = num(s.llmCalls);
  usageStats.promptTokens = num(s.promptTokens);
  usageStats.completionTokens = num(s.completionTokens);
  usageStats.totalTokens = num(s.totalTokens);
  usageStats.toolCalls = num(s.toolCalls);
  usageStats.toolErrors = num(s.toolErrors);
  if (Array.isArray(s.tools)) {
    for (const item of s.tools as Record<string, unknown>[]) {
      if (typeof item?.name === 'string') {
        usageStats.tools[item.name] = { count: num(item.count), errors: num(item.errors), empties: num(item.empties) };
      }
    }
  } else if (s.tools && typeof s.tools === 'object') {
    for (const [k, v] of Object.entries(s.tools as Record<string, unknown>)) {
      const e = (v ?? {}) as Record<string, unknown>;
      usageStats.tools[k] = { count: num(e.count), errors: num(e.errors), empties: num(e.empties) };
    }
  }
  if (s.actors && typeof s.actors === 'object' && !Array.isArray(s.actors)) {
    for (const k of Object.keys(s.actors as Record<string, unknown>)) usageStats.actors[k] = 1;
  }
  if (typeof s.since === 'string' && s.since) usageStats.since = s.since;
  usageStats.updatedAt = typeof s.updatedAt === 'string' ? s.updatedAt : '';
}

function trackActor(id: string): void {
  const key = id.trim().slice(0, 128);
  if (!key) return;
  if (!usageStats.actors[key] && Object.keys(usageStats.actors).length >= agentConfig.maxTrackedActors) return;
  usageStats.actors[key] = 1;
}

function trackTokens(usage: unknown): void {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  usageStats.promptTokens += num(u.prompt_tokens);
  usageStats.completionTokens += num(u.completion_tokens);
  usageStats.totalTokens += num(u.total_tokens) || num(u.prompt_tokens) + num(u.completion_tokens);
  touchStats();
}

function touchStats(): void {
  usageStats.updatedAt = new Date().toISOString();
}

// ---------- 工具定义（intent_plan + 内置示例 echo/demo_cards + 注册门模块 weather） ----------

function strEnum(values: string[]) {
  return { type: 'string', enum: values };
}

export const TOOL_DEFS = [
  // 意图规划：不触达外部 API。模型在首次检索前把用户需求结构化为 IR，
  // 函数内校验归一化（见 intent.ts）后落 tool_logs 审计、并把归一化 IR 回灌模型引导后续工具参数。
  tool('intent_plan', '意图规划（不执行检索）：在首次检索调用前，把用户需求结构化为意图。平台会校验并归一化（枚举槽位别名→词表规范值），返回的归一化意图是后续检索工具参数的依据。可与首个检索工具同一轮并行调用。', {
    question: reqStr('用户问题的一句话概括'),
    targets: { type: 'array', items: strEnum([...INTENT_TARGETS]), description: '目标：见 intent-vocab.ts 的 INTENT_TARGETS 枚举说明' },
    filters: { type: 'object', nullable: true, description: '可选过滤条件，无则省略整个字段', properties: Object.fromEntries(INTENT_FILTER_SLOTS.map((s) => [s.key, s.kind === 'boolean' ? { type: 'boolean', nullable: true, description: s.description } : { type: 'string', nullable: true, description: s.description }])) },
    [INTENT_NEEDS_FLAG]: { type: 'boolean', description: INTENT_NEEDS_DESCRIPTION },
  }, ['question', 'targets', INTENT_NEEDS_FLAG]),
  // 内置示例工具一：echo——零外部依赖，演示 TOOL_DEFS 声明 → executeTool case → label 的最短路径
  tool('echo', '回显文本（内置示例工具，演示最短接入路径）。可选 transform：upper=转大写，lower=转小写，reverse=反转。', {
    text: reqStr('要回显的文本'),
    transform: { type: 'string', enum: ['upper', 'lower', 'reverse'], description: '可选文本变换', nullable: true },
  }, ['text']),
  // 内置示例工具二：demo_cards——卡片产出型，演示 extractCards 投影 → cards 帧 → LLM 输入瘦身与前端完整数据分离
  tool('demo_cards', '按主题返回演示数据集（卡片产出型示例工具）。主题 fruits / cities / elements 之一；未知主题返回空结果说明（空结果不是错误）。', {
    topic: reqStr('主题：fruits / cities / elements'),
    limit: intOpt('返回条数，默认 3，最大 10'),
  }, ['topic']),
  // 注册门模块（示例）：开关+凭据均就绪才进清单；未配置时工具面零新增（开箱即纯 LLM + 内置示例）
  ...(weatherRegistered() ? WEATHER_TOOL_DEFS : []),
];

/** 意图规划工具名：主循环里拦截，不进 executeTool / 不发 SSE tool 事件 / 不计用量 */
export const INTENT_TOOL_NAME = 'intent_plan';

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}
function reqStr(desc: string) { return { type: 'string', description: desc }; }
function strOpt(desc: string) { return { type: 'string', description: desc, nullable: true }; }
function intOpt(desc: string) { return { type: 'integer', description: desc, nullable: true }; }

// ---------- demo_cards 演示数据集（纯静态，零外部依赖） ----------

const DEMO_DATASETS: Record<string, { accession: string; title: string; summary: string; meta: Record<string, string> }[]> = {
  fruits: [
    { accession: 'FRUIT-001', title: '苹果（Apple）', summary: '蔷薇科苹果属落叶乔木果实，温带广泛栽培。', meta: { category: 'fruits', origin: 'cn', season: 'autumn' } },
    { accession: 'FRUIT-002', title: '香蕉（Banana）', summary: '芭蕉科芭蕉属大型草本植物果实，热带主产。', meta: { category: 'fruits', origin: 'global', season: 'all_year' } },
    { accession: 'FRUIT-003', title: '樱桃（Cherry）', summary: '蔷薇科李属樱亚属植物果实，北温带栽培。', meta: { category: 'fruits', origin: 'eu', season: 'summer' } },
    { accession: 'FRUIT-004', title: '芒果（Mango）', summary: '漆树科杧果属常绿大乔木果实，热带果树。', meta: { category: 'fruits', origin: 'global', season: 'summer' } },
    { accession: 'FRUIT-005', title: '葡萄（Grape）', summary: '葡萄科葡萄属木质藤本果实，酿酒鲜食两用。', meta: { category: 'fruits', origin: 'eu', season: 'autumn' } },
  ],
  cities: [
    { accession: 'CITY-001', title: '北京（Beijing）', summary: '中国首都，历史文化名城。', meta: { category: 'cities', region: 'cn', population: '21_million' } },
    { accession: 'CITY-002', title: '东京（Tokyo）', summary: '日本首都，全球最大都市圈核心。', meta: { category: 'cities', region: 'jp', population: '37_million_metro' } },
    { accession: 'CITY-003', title: '巴黎（Paris）', summary: '法国首都，塞纳河畔的历史文化中心。', meta: { category: 'cities', region: 'eu', population: '11_million_metro' } },
    { accession: 'CITY-004', title: '纽约（New York）', summary: '美国最大城市，全球金融与文化中心之一。', meta: { category: 'cities', region: 'us', population: '8_million' } },
    { accession: 'CITY-005', title: '上海（Shanghai）', summary: '中国最大经济中心，长江入海口口岸城市。', meta: { category: 'cities', region: 'cn', population: '24_million' } },
  ],
  elements: [
    { accession: 'ELEM-001', title: '氢（Hydrogen）', summary: '原子序数 1，宇宙中丰度最高的元素。', meta: { category: 'elements', symbol: 'H', atomic_number: '1' } },
    { accession: 'ELEM-002', title: '碳（Carbon）', summary: '原子序数 6，有机化学与生命的骨架元素。', meta: { category: 'elements', symbol: 'C', atomic_number: '6' } },
    { accession: 'ELEM-003', title: '氧（Oxygen）', summary: '原子序数 8，地壳中丰度最高的元素。', meta: { category: 'elements', symbol: 'O', atomic_number: '8' } },
    { accession: 'ELEM-004', title: '铁（Iron）', summary: '原子序数 26，现代工业的骨架金属。', meta: { category: 'elements', symbol: 'Fe', atomic_number: '26' } },
    { accession: 'ELEM-005', title: '金（Gold）', summary: '原子序数 79，化学性质稳定的贵金属。', meta: { category: 'elements', symbol: 'Au', atomic_number: '79' } },
  ],
};

function q(args: Record<string, Json | undefined>, key: string): string | undefined {
  const v = args[key];
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

export async function executeTool(name: string, args: Record<string, Json | undefined>): Promise<Json> {
  // 注册门模块（示例）单点拦截，交给 weather 模块统一管道执行（未配置凭据时抛清晰错误、零上游请求）
  if (isWeatherTool(name)) return executeWeatherTool(name, args);
  switch (name) {
    case 'echo': {
      const text = q(args, 'text');
      if (text === undefined || !text.trim()) throw new Error('text 参数不能为空');
      if (text.length > 5000) throw new Error(`text 过长（${text.length} 字符，上限 5000）`);
      const transform = q(args, 'transform');
      let transformed = text;
      if (transform === 'upper') transformed = text.toUpperCase();
      else if (transform === 'lower') transformed = text.toLowerCase();
      else if (transform === 'reverse') transformed = [...text].reverse().join('');
      else if (transform !== undefined) throw new Error(`transform 不支持「${transform}」（合法取值 upper/lower/reverse）`);
      return wrap({ original: text, transformed, transform: transform ?? 'none' });
    }
    case 'demo_cards': {
      const topic = String(args.topic ?? '').trim().toLowerCase();
      const limit = clampLimit(args.limit, 3);
      const all = DEMO_DATASETS[topic];
      if (!all) return emptyResult(`未知主题「${topic}」。合法主题：fruits / cities / elements。`);
      if (all.length === 0) return emptyResult(`主题「${topic}」当前没有数据。`);
      return wrap({ topic, total: all.length, results: all.slice(0, limit) });
    }
    default: throw new Error(`未知工具：${name}`);
  }
}

function clampLimit(value: Json | undefined, fallback = 10, cap = 10): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(cap, Math.max(1, Math.floor(n))) : fallback;
}

function wrap(data: Json): Json {
  return { success: true, data };
}

/** 业务性空结果：success 形态返回，data.empty 标记供统计计为「空结果」而非错误（信封形状冻结） */
export function emptyResult(note: string): Json {
  return { success: true, data: { empty: true, note } };
}

export function isBusinessEmpty(payload: Json): boolean {
  const d = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, Json>).data : null;
  return !!d && typeof d === 'object' && !Array.isArray(d) && (d as Record<string, Json>).empty === true;
}

// 结果瘦身：集合类结果截断条数与 summary，控制回传给 LLM 的体积（前端卡片走完整数据，互不影响）
export function trimForLLM(payload: Json): string {
  const limit = agentConfig.trimLimit;
  let text: string;
  try { text = JSON.stringify(payload); } catch { text = String(payload); }
  if (text.length <= limit) return text;
  try {
    const obj = payload as { data?: Record<string, Json> | Json };
    if (obj && typeof obj === 'object' && obj.data && !Array.isArray(obj.data) && Array.isArray((obj.data as Record<string, Json>).results)) {
      const results = ((obj.data as Record<string, Json>).results as Json[]).slice(0, 10).map((r) => {
        const item = { ...(r as Record<string, Json>) };
        if (typeof item.summary === 'string' && item.summary.length > 400) item.summary = item.summary.slice(0, 400) + '…';
        return item;
      });
      const payloadObj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, Json>;
      const dataObj = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, Json>;
      const trimmed = { ...payloadObj, data: { ...dataObj, results, truncated: true } };
      return JSON.stringify(trimmed).slice(0, limit);
    }
    // 表格类结果（rows 数组）：按行二分切，绝不从中间截断 JSON——否则模型收到的是半截原始文本
    if (obj && typeof obj === 'object' && obj.data && !Array.isArray(obj.data) && Array.isArray((obj.data as Record<string, Json>).rows)) {
      const payloadObj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, Json>;
      const dataObj = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, Json>;
      const rows = (dataObj.rows as Json[]) ?? [];
      let lo = 0, hi = rows.length; // 找最大可行前缀
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const test = JSON.stringify({ ...payloadObj, data: { ...dataObj, rows: rows.slice(0, mid), truncated: true } });
        if (test.length <= limit) lo = mid; else hi = mid - 1;
      }
      return JSON.stringify({ ...payloadObj, data: { ...dataObj, rows: rows.slice(0, lo), truncated: true } });
    }
  } catch { /* fallthrough */ }
  return text.slice(0, limit) + '…(truncated)';
}

// 从工具结果里提取可展示的结果卡片（信封 {tool, accession, title, summary, meta}，meta 值全字符串；
// accession 为去重键，单次上限 20 张——帧形状冻结，字段集合由使用者领域定义）。
// 导出供 tests 断言卡片投影字段与上限（demo_cards 用例）。
export function extractCards(name: string, payload: Json): Json[] {
  // 注册门模块卡片由 weather 模块投影（meta.source = 'weather'）
  if (isWeatherTool(name)) return extractWeatherCards(name, payload);
  try {
    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== 'object') return [];
    const list = Array.isArray(data) ? data : (data as { results?: unknown }).results;
    if (!Array.isArray(list)) return [];
    const cards: Json[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, Json>;
      const accession = typeof it.accession === 'string' ? it.accession : '';
      const title = typeof it.title === 'string' ? it.title : typeof it.name === 'string' ? it.name : '';
      if (!accession && !title) continue;
      if (accession && seen.has(accession)) continue; // accession 去重
      if (accession) seen.add(accession);
      const summary = typeof it.summary === 'string' ? it.summary.slice(0, 600) : typeof it.description === 'string' ? it.description.slice(0, 600) : '';
      const meta: Record<string, string> = {};
      if (it.meta && typeof it.meta === 'object' && !Array.isArray(it.meta)) {
        for (const [k, v] of Object.entries(it.meta as Record<string, Json>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') meta[k] = String(v);
        }
      }
      cards.push({ tool: name, accession, title, summary, meta });
      if (cards.length >= 20) break;
    }
    return cards;
  } catch { return []; }
}

// ---------- 正文↔证据一致性校验（grounding，框架 + 参数化注册表） ----------
// 模型正文引用的标识须与本轮证据卡片同源：扫出的标识先与 cards 的集合比对，
// 卡片外的标识再回源做存在性核验（最多 config.groundingVerifyLimit 个，复用 fetchWithRetry）；
// 仍无法证实的经 {event:'grounding'} 下发前端警示条，核验摘要同时写入 tool_logs 供审计。
//
// 扫描模式集与验证器路由表是【集中注册表常量区】：模板给中性示例（DOI + URL 模式、
// doi.org 可达性验证）；使用者按领域替换这两张表即可，框架函数零改动。

export interface GroundingUnconfirmed {
  id: string;
  /** upstream_404 = 回源明确查无此号；unverified = 超出核验配额或无核验通道 */
  status: 'upstream_404' | 'unverified';
}

export interface GroundingReport {
  /** 正文扫到的全部规范标识 */
  scanned: string[];
  /** 已在证据卡片中的标识 */
  grounded: string[];
  /** 卡片外但回源证实存在的标识 */
  confirmed: string[];
  /** 卡片外且回源无法证实的标识 */
  unconfirmed: GroundingUnconfirmed[];
}

/** 标识扫描模式注册表：normalize 把命中归一到与卡片标识可比的规范形（DOI 小写去尾标点、URL 原样去尾标点） */
export const SCAN_PATTERNS: { kind: string; re: RegExp; normalize: (m: RegExpExecArray) => string }[] = [
  { kind: 'doi', re: /\b(10\.\d{4,9}\/[^\s"'`()\[\]<>;，。；]+)/g, normalize: (m) => m[1].replace(/[.,:)\]]+$/, '').toLowerCase() },
  { kind: 'url', re: /\bhttps?:\/\/[^\s"'`<>，。；)\]]+/g, normalize: (m) => m[0].replace(/[.,:;]+$/, '') },
];

/** 扫描正文，返回去重后的规范标识（按出现顺序） */
export function scanAccessions(text: string): string[] {
  const out = new Set<string>();
  for (const { re, normalize } of SCAN_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.add(normalize(m));
      if (m.index === re.lastIndex) re.lastIndex++; // 防零宽匹配死循环
    }
  }
  return [...out];
}

/** 本轮证据卡片携带的全部可核验标识（与 scanAccessions 规范形对齐：DOI 小写、URL 原样、普通编号大写） */
export function cardIdentifiers(cards: Json[]): Set<string> {
  const ids = new Set<string>();
  for (const c of cards) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const card = c as Record<string, unknown>;
    if (typeof card.accession === 'string' && card.accession.trim()) {
      const acc = card.accession.trim();
      if (/^10\.\d{4,9}\//.test(acc)) ids.add(acc.toLowerCase()); // accession 本身是 DOI
      else if (/^https?:\/\//i.test(acc)) ids.add(acc); // URL 原样（路径大小写敏感）
      else ids.add(acc.toUpperCase()); // 普通编号大写
    }
    const meta = card.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      if (typeof m.doi === 'string' && m.doi.trim()) ids.add(m.doi.trim().toLowerCase());
      if (typeof m.url === 'string' && m.url.trim()) ids.add(m.url.trim());
    }
  }
  return ids;
}

/** 标识 → 存在性核验端点注册表。http 语义：200 存在 / 404 不存在。null = 无已知核验通道（不硬猜） */
export function verifyEndpointFor(id: string): { url: string; interpret: 'http' } | null {
  if (/^10\.\d{4,9}\//.test(id)) return { url: `https://doi.org/${encodeURIComponent(id)}`, interpret: 'http' };
  if (/^https?:\/\//i.test(id)) return { url: id, interpret: 'http' };
  return null;
}

/** 回源核验单个标识的存在性：exists = 上游确认存在；missing = 上游明确 404；unknown = 超时/网络错/无通道 */
export async function verifyAccession(id: string): Promise<'exists' | 'missing' | 'unknown'> {
  const ep = verifyEndpointFor(id);
  if (!ep) return 'unknown';
  try {
    await fetchWithRetry(ep.url, 3000, 1);
    return 'exists';
  } catch (err) {
    if (err instanceof Error && /HTTP 404/.test(err.message)) return 'missing';
    return 'unknown';
  }
}

/**
 * 正文↔证据一致性校验：正文标识 ⊆ 卡片标识 则零警示；卡片外标识回源核验，仍无法证实的进 unconfirmed。
 * 若所有回源核验都拿不到结论（上游整体不可达），整次降级为不提示——基础设施抖动不应误报模型。
 */
export async function groundingCheck(
  fullText: string,
  cards: Json[],
  opts: { verify?: (id: string) => Promise<'exists' | 'missing' | 'unknown'>; limit?: number } = {},
): Promise<GroundingReport> {
  const scanned = scanAccessions(fullText);
  const known = cardIdentifiers(cards);
  const report: GroundingReport = { scanned, grounded: scanned.filter((id) => known.has(id)), confirmed: [], unconfirmed: [] };
  const missing = scanned.filter((id) => !known.has(id));
  if (missing.length === 0) return report;
  const verify = opts.verify ?? verifyAccession;
  const limit = Math.max(0, opts.limit ?? agentConfig.groundingVerifyLimit);
  const toVerify = missing.slice(0, limit);
  const results = await Promise.all(toVerify.map((id) => verify(id).catch((): 'unknown' => 'unknown')));
  let sawVerdict = false; // 至少一次核验拿到明确结论（exists/missing）
  const unconfirmed: GroundingUnconfirmed[] = [];
  for (let i = 0; i < toVerify.length; i++) {
    const r = results[i];
    if (r === 'exists') { sawVerdict = true; report.confirmed.push(toVerify[i]); }
    else if (r === 'missing') { sawVerdict = true; unconfirmed.push({ id: toVerify[i], status: 'upstream_404' }); }
  }
  if (toVerify.length > 0 && !sawVerdict) return report; // 上游全灭 → 不误报
  for (const id of missing.slice(limit)) unconfirmed.push({ id, status: 'unverified' });
  report.unconfirmed = unconfirmed;
  return report;
}

export const handler = async (req: Request): Promise<Response> => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();
  try {
    const apiKey = envGet('LLM_API_KEY');

    // 请求体只读一次（Request body 不可重复读）
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return new Response(JSON.stringify({ error: '请求体必须是合法 JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // GET <endpoint>/stats：使用统计面板（本地聚合数据，不需要 AI 凭证）
    // 注意必须在模型目录分支之前——目录分支会把一切 GET 当 /models 处理
    if (req.method === 'GET' && new URL(req.url).pathname.endsWith('/stats')) {
      // integrations 各模块三态（disabled/token_missing/enabled）：部署者配置可见性，
      // 仅状态枚举，不含凭据值/长度/前缀任何信息
      return new Response(JSON.stringify({ ...getUsageStatsSnapshot(), integrations: { weather: weatherIntegrationStatus() } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'AI 服务凭证未配置（LLM_API_KEY），请在 server/.env 填入后重启服务' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    // 可选共享密钥：配置 CHAT_SHARED_SECRET 后，对话接口要求请求头 X-Chat-Key 匹配（防 casual 滥用）。
    // 统计等公共分支在前面已 return，不受此约束；未配置时完全兼容无鉴权。
    const sharedSecret = envGet('CHAT_SHARED_SECRET');
    if (sharedSecret && req.headers.get('X-Chat-Key') !== sharedSecret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // GET：模型目录（注入 defaultModel：优先本地 LLM_MODEL 配置，让前端默认选中它）
    // 超时放宽到 8s：网关冷启动/跨网较慢时前端仍能拿到目录，避免回退到无效的兜底模型
    if (req.method === 'GET') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${LLM_BASE_URL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        const text = await response.text();
        let out = text;
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object') {
            const upstreamDefault = typeof parsed.defaultModel === 'string' ? parsed.defaultModel : '';
            const configured = envGet('LLM_MODEL');
            const finalDefault = configured || upstreamDefault;
            if (finalDefault) parsed.defaultModel = finalDefault;
            out = JSON.stringify(parsed);
          }
        } catch { /* 非 JSON 响应原样透传 */ }
        return new Response(out, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch {
        return new Response(JSON.stringify({ error: '模型目录暂时不可用' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } finally {
        clearTimeout(timer);
      }
    }

    const history = (body.messages || []) as ChatMsg[];
    const model = (body.model as string) || DEFAULT_MODEL;
    const lang = body.lang === 'en' ? 'en' : 'zh';
    const systemPrompt = lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT;
    const messages: ChatMsg[] = [{ role: 'system', content: systemPrompt }, ...history.slice(-agentConfig.historyWindow)];

    console.info(`[${FUNCTION_NAME}] request ${requestId} model=${model} lang=${lang} messages=${history.length}`);

    // 使用统计：本算一轮对话 + 记录使用者（登录用户 id / 访客设备指纹，前端经 X-Stats-Actor 上报）
    usageStats.chats += 1;
    trackActor(req.headers.get('x-stats-actor') ?? '');
    touchStats();

    const encoder = new TextEncoder();
    const allCards: Json[] = [];
    const toolLogs: { name: string; label: string; ok: boolean; ms: number; intent?: ResearchIntent; notes?: string[] }[] = [];
    let aborted = false;
    let fullText = ''; // 各轮助手正文累积（工具轮的前言 + 最终答复），供末尾 grounding 扫描
    req.signal.addEventListener('abort', () => { aborted = true; });

    const readable = new ReadableStream({
      async start(controller) {
        // 心跳：按 config 间隔发送 SSE 注释行，避免代理层对长连接的缓冲/超时
        const heartbeat = setInterval(() => {
          if (aborted) return;
          try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
        }, agentConfig.heartbeatIntervalMs);
        const send = (obj: Json) => {
          if (aborted) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* closed */ }
        };
        try {
          for (let round = 0; round < agentConfig.maxTurns && !aborted; round++) {
            usageStats.llmCalls += 1;
            touchStats();
            // 超时 + 客户端断连信号：任一触发都会中断上游请求，避免挂死/断连后继续烧 token
            const llmSignal =
              typeof AbortSignal.any === 'function'
                ? AbortSignal.any([req.signal, AbortSignal.timeout(agentConfig.llmTimeoutMs)])
                : req.signal;
            const llmResp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
              method: 'POST',
              signal: llmSignal,
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              // stream_options.include_usage：让网关在流末尾回传 token 用量（统计面板数据源）
              body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, tools: [...TOOL_DEFS], tool_choice: 'auto' }),
            });
            if (!llmResp.ok) {
              const errText = await llmResp.text();
              console.error(`[${FUNCTION_NAME}] upstream failed ${requestId} status=${llmResp.status}: ${errText.slice(0, 300)}`);
              send({ error: `AI 服务返回 ${llmResp.status}` });
              break;
            }
            // 解析上游 SSE，聚合文本与 tool_calls
            const reader = llmResp.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let textBuf = '';
            const toolCalls: Record<number, ToolCall> = {};
            let sawDone = false;
            while (true) {
              if (aborted) break; // 客户端断连：立即停止读取上游流
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const payload = t.slice(5).trim();
                if (payload === '[DONE]') { sawDone = true; continue; }
                try {
                  const json = JSON.parse(payload);
                  if (json.usage) trackTokens(json.usage); // 流末尾的 usage 帧（choices 为空）
                  const choice = json.choices?.[0];
                  if (!choice) continue;
                  const content = choice.delta?.content;
                  if (typeof content === 'string' && content.length) { textBuf += content; send({ delta: content }); }
                  const calls = choice.delta?.tool_calls;
                  if (Array.isArray(calls)) {
                    for (const c of calls) {
                      // tool_calls 增量按 index 聚合：id/function.name/function.arguments 均为增量拼接
                      // （流式 tool-calling 的关键语义，不可改动）
                      const idx = c.index ?? 0;
                      if (!toolCalls[idx]) toolCalls[idx] = { id: c.id || `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
                      if (c.id) toolCalls[idx].id = c.id;
                      if (c.function?.name) toolCalls[idx].function.name += c.function.name;
                      if (c.function?.arguments) toolCalls[idx].function.arguments += c.function.arguments;
                    }
                  }
                } catch { /* ignore partial */ }
              }
            }
            if (aborted) break; // 断连后不再执行工具、不进入下一轮
            fullText += textBuf;
            const callsArr = Object.values(toolCalls).filter((c) => c.function.name);
            if (!callsArr.length) {
              if (!sawDone) send({ delta: '' }); // 上游没发 [DONE] 也要保证至少一个 delta 帧
              break;
            }
            // 执行工具，把结果作为 tool message 继续下一轮
            messages.push({ role: 'assistant', content: textBuf || null, tool_calls: callsArr });
            for (const call of callsArr) {
              const label = labelOf(call.function.name);
              const t0 = Date.now();
              // 意图规划条目：不调外部 API、不发 SSE tool 事件、不计用量统计。
              // 校验通过的 IR 落 tool_logs 供审计（前端按名过滤，同 grounding_check 模式），
              // 归一化结果作为 tool 消息回灌模型，引导后续工具参数；校验失败只回灌原因，
              // 模型可修正重试或直连检索工具——整体退化为无意图行为。
              if (call.function.name === INTENT_TOOL_NAME) {
                let intentRaw: unknown = null;
                try { intentRaw = JSON.parse(call.function.arguments || '{}'); } catch { /* 非法 JSON 按校验失败处理 */ }
                const parsedIntent = parseResearchIntent(intentRaw);
                if (parsedIntent.ok === false) {
                  messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ success: false, error: `意图校验失败：${parsedIntent.reason}。可修正后重试 ${INTENT_TOOL_NAME}，或直接调用检索工具。` }) });
                } else {
                  toolLogs.push({ name: INTENT_TOOL_NAME, label, ok: true, ms: Date.now() - t0, intent: parsedIntent.intent, notes: parsedIntent.notes });
                  messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ success: true, data: { intent: parsedIntent.intent, normalized: parsedIntent.notes, note: '意图已记录并完成归一化，后续检索请采用归一化取值（枚举槽位用词表规范值）。' } }) });
                }
                continue;
              }
              usageStats.toolCalls += 1;
              const entry = (usageStats.tools[call.function.name] ??= { count: 0, errors: 0, empties: 0 });
              entry.count += 1;
              send({ event: 'tool', name: call.function.name, label, status: 'running' });
              let resultText: string;
              try {
                const callArgs = JSON.parse(call.function.arguments || '{}') as Record<string, Json | undefined>;
                const payload = (await executeTool(call.function.name, callArgs)) as Json;
                if (isBusinessEmpty(payload)) entry.empties += 1; // 空结果 ≠ 失败，分开统计
                const cards = extractCards(call.function.name, payload);
                if (cards.length) { allCards.push(...cards); send({ event: 'cards', cards }); }
                resultText = trimForLLM(payload);
                toolLogs.push({ name: call.function.name, label, ok: true, ms: Date.now() - t0 });
                send({ event: 'tool', name: call.function.name, label, status: 'done', ms: Date.now() - t0 });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                resultText = JSON.stringify({ success: false, error: message });
                usageStats.toolErrors += 1;
                entry.errors += 1;
                touchStats();
                toolLogs.push({ name: call.function.name, label, ok: false, ms: Date.now() - t0 });
                send({ event: 'tool', name: call.function.name, label, status: 'error', ms: Date.now() - t0, error: message });
                console.warn(`[${FUNCTION_NAME}] tool failed ${requestId} ${call.function.name}: ${message.slice(0, 200)}`);
              }
              messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: resultText });
            }
            textBuf = '';
            if (round === agentConfig.maxTurns - 1) send({ delta: lang === 'en' ? '\n\n(Reached the maximum queries for this turn; ask a follow-up to continue.)' : '\n\n（已达到本轮最大查询次数，请追问以继续。）' });
          }
          // 正文↔证据一致性校验（grounding）：模型正文引用的标识须能在本轮证据卡片中找到，
          // 找不到的回源核验，仍无法证实的经 {event:'grounding'} 提示用户自行核验；
          // 核验摘要写入 tool_logs 供审计。校验失败绝不打断主流程（宁可漏报，不可丢回答）。
          if (!aborted && fullText.trim()) {
            const g0 = Date.now();
            try {
              const report = await groundingCheck(fullText, allCards);
              toolLogs.push({ name: 'grounding_check', label: '正文标识核验', ok: report.unconfirmed.length === 0, ms: Date.now() - g0 });
              if (report.unconfirmed.length > 0) {
                send({ event: 'grounding', unconfirmed: report.unconfirmed, confirmed: report.confirmed });
                console.warn(`[${FUNCTION_NAME}] grounding ${requestId} unconfirmed=${report.unconfirmed.map((u) => u.id).join(',')}`);
              }
            } catch (err) {
              console.warn(`[${FUNCTION_NAME}] grounding failed ${requestId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          send({ event: 'end', cards: allCards, tools: toolLogs });
          console.info(`[${FUNCTION_NAME}] stream done ${requestId} tools=${toolLogs.length} durationMs=${Date.now() - startTime}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Internal Server Error';
          console.error(`[${FUNCTION_NAME}] stream failed ${requestId}: ${message}`);
          send({ error: message });
        } finally {
          clearInterval(heartbeat);
          try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } catch { /* closed */ }
        }
      },
    });

    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error(`[${FUNCTION_NAME}] failed ${requestId}: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Deno 运行时直接启动 HTTP 服务；本地 Node 自托管由 server/local.mjs import 上面的 handler
const denoRuntime = (globalThis as Record<string, unknown>).Deno as
  | { serve?: (h: (req: Request) => Response | Promise<Response>) => void }
  | undefined;
denoRuntime?.serve(handler);

function labelOf(name: string): string {
  const map: Record<string, string> = {
    intent_plan: '意图规划',
    echo: '回显文本（示例）',
    demo_cards: '演示数据集（示例）',
  };
  return { ...WEATHER_TOOL_LABELS, ...map }[name] || name;
}