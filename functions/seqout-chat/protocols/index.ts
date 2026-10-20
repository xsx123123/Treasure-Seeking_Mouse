// index.ts：protocols 领域模块单点出口（design §2.1.2 / §2.2.2 / §2.2.3 / §2.4）。
// 导出对齐 biomed/index.ts 六项契约：PROTOCOLS_TOOL_DEFS / PROTOCOLS_TOOL_NAMES /
// executeProtocolsTool / PROTOCOLS_TOOL_LABELS / extractProtocolsCards / isProtocolsTool，
// 另加注册门 protocolsRegistered() 与集成状态 protocolsIntegrationStatus()（三态枚举，
// 不含 Token 值/长度/前缀任何信息——spec 5.2.1 规则 4）。
// schema 辅助（tool/reqStr/strOpt/intOpt）与主 index.ts 同构复制——禁共享，避免反向依赖。
//
// 注册门（design §2.4）：PROTOCOLS_IO_ENABLED 解析为真 且 Token 非空；未配置/
// 开关关/Token 空均不注册（token_missing 态同样不注册，spec 4.2.3）。
// 双保险（spec 5.2.1 规则 3）：executeProtocolsTool 入口独立校验——注册状态与运行时
// 不一致时抛 CONFIG_MISSING 中文错误（主循环 catch 后以 {success:false, error} 信封
// 回灌模型并计入 errors）、零上游请求。
//
// 依赖约束：仅本目录四个文件，不 import 主 index.ts（ES 循环依赖红线）。

import { searchProtocols } from './search.ts';
import type { ProtocolSearchArgs } from './search.ts';
import { getProtocolDetails, getProtocolSteps } from './detail.ts';
import type { ProtocolDetailArgs, ProtocolStepsArgs } from './detail.ts';
import { getProtocolsConfig, ProtocolsError } from './client.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

// --- schema 辅助（与主 index.ts 的 tool()/reqStr()/strOpt()/intOpt() 同构） ---

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}
function reqStr(desc: string) { return { type: 'string', description: desc }; }
function intOpt(desc: string) { return { type: 'integer', description: desc, nullable: true }; }

// --- 注册门与集成状态（模块级缓存求值：getProtocolsConfig 内部缓存一次） ---

export function protocolsRegistered(): boolean {
  const config = getProtocolsConfig();
  return config.enabled && config.token !== '';
}

export type ProtocolsIntegrationStatus = 'disabled' | 'token_missing' | 'enabled';

export function protocolsIntegrationStatus(): ProtocolsIntegrationStatus {
  const config = getProtocolsConfig();
  if (!config.enabled) return 'disabled';
  return config.token ? 'enabled' : 'token_missing';
}

// --- 工具 schema（design §2.2.2 逐字落地；filter=public 由适配器硬编码，不进 schema） ---

export const PROTOCOLS_TOOL_DEFS = [
  tool('protocols_search',
    '检索 protocols.io 公开实验方案库（实验方法、操作步骤、protocol）。关键词匹配方案名称、描述与作者，适合「怎么做实验 / 实验方案 / 操作步骤 / 材料准备」类问题。仅公开方案；不提供 PDF 下载与私有内容。检索无命中时会如实返回空结果并给出改写建议。',
    {
      key: reqStr('检索关键词；多词精确短语用双引号包裹，如 "RNA extraction"；支持中英文'),
      peer_reviewed: { type: 'boolean', nullable: true, description: '可选：true=仅期刊同行评审过的方案，false=仅未评审；不传=全部' },
      order_field: { type: 'string', enum: ['activity', 'relevance', 'date', 'name', 'id'], description: '排序字段，默认 activity（活跃度）' },
      order_dir: { type: 'string', enum: ['asc', 'desc'], description: '排序方向，默认 desc' },
      page_size: intOpt('每页条数，默认 10，最大 100'),
      page_id: intOpt('页码，默认 1；翻页前先看上次响应的 total_pages 与 current_page'),
    }, ['key']),
  tool('protocols_get_details',
    '获取 protocols.io 实验方案详情：标题、作者与机构、描述、开始前说明、指南、警告、材料清单概要、步骤概要（数量与各步摘要）、版本与统计信息。完整步骤请改用 protocols_get_steps。',
    {
      id: reqStr('协议标识，三种形态任一：数字 ID（如 872）、URI（如 lysis-buffer-20-ml-c4gytv）、DOI（如 10.17504/protocols.io.c4gytv）'),
    }, ['id']),
  tool('protocols_get_steps',
    '获取 protocols.io 实验方案的完整有序步骤与材料清单（含开始前说明、指南与安全警告）。步骤按原文顺序返回；材料仅含协议原始记录项（名称、货号、供应商，存在才提供），平台不做 AI 补全。同一协议若刚读过详情，会复用已获取内容。',
    {
      id: reqStr('协议标识：数字 ID、URI 或 DOI，同 protocols_get_details'),
    }, ['id']),
];

export const PROTOCOLS_TOOL_NAMES = ['protocols_search', 'protocols_get_details', 'protocols_get_steps'] as const;

const PROTOCOLS_TOOL_SET = new Set<string>(PROTOCOLS_TOOL_NAMES);

export function isProtocolsTool(name: string): boolean {
  return PROTOCOLS_TOOL_SET.has(name);
}

export const PROTOCOLS_TOOL_LABELS: Record<string, string> = {
  protocols_search: '检索实验方案（protocols.io）',
  protocols_get_details: '查询方案详情（protocols.io）',
  protocols_get_steps: '获取方案步骤与材料（protocols.io）',
};

/** 与 executeTool 同签名同信封的分发入口：双保险 Token 校验（失败抛中文错误零上游请求，
 *  主循环 catch 计 errors）→ 参数校验（search/detail 适配器内，失败抛中文格式示例）→
 *  适配器组装 {success:true, data} 信封；六类上游错误由 protocolsFetch 分类抛出
 *  （design §2.1.3B）。not_found / 空矿以 success 信封返回（不计 errors）。 */
export async function executeProtocolsTool(name: string, args: Record<string, Json | undefined>): Promise<Json> {
  const config = getProtocolsConfig();
  if (!config.enabled || !config.token) {
    throw new ProtocolsError('实验方案服务未启用或令牌未配置（PROTOCOLS_IO_ENABLED / PROTOCOLS_IO_CLIENT_ACCESS_TOKEN），请联系部署者检查配置');
  }
  switch (name) {
    case 'protocols_search': return searchProtocols(args as unknown as ProtocolSearchArgs);
    case 'protocols_get_details': return getProtocolDetails(args as unknown as ProtocolDetailArgs);
    case 'protocols_get_steps': return getProtocolSteps(args as unknown as ProtocolStepsArgs);
    default: throw new Error(`未知 protocols 工具：${name}`);
  }
}

/** 按工具名投影卡片（调用点：主 index.ts extractCards 单点委托）；
 *  异常一律空数组（卡片失败不影响消息，对齐 biomed 先例）。
 *  meta.source='protocol'（枚举只增不改）；值全字符串，peer_reviewed 三态=键缺省（spec 6.4.3）。 */
export function extractProtocolsCards(name: string, payload: Json): Json[] {
  try {
    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== 'object') return [];
    const obj = data as Record<string, unknown>;
    if (name === 'protocols_search') {
      const list = Array.isArray(obj.results) ? obj.results : [];
      const cards: Json[] = [];
      const seen = new Set<string>();
      for (const item of list) {
        const card = searchResultCard(name, item);
        if (!card) continue;
        const accession = (card as { accession?: unknown }).accession;
        if (typeof accession !== 'string' || seen.has(accession)) continue; // 按 source_id 去重（spec 6.2.2）
        seen.add(accession);
        cards.push(card);
      }
      return cards.slice(0, 20);
    }
    if (name === 'protocols_get_details') {
      const first = Array.isArray(obj.results) ? obj.results[0] : undefined;
      return first ? [detailCard(name, first)] : [];
    }
    if (name === 'protocols_get_steps') {
      return [stepsCard(name, obj)];
    }
    return [];
  } catch {
    return [];
  }
}

// --- 卡片投影辅助（meta 值全字符串；三态=键缺省） ---

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** authors/affiliations 投影：join(', ')、≤6 人截断标注；机构去重 */
function projectPeople(e: Record<string, unknown>, meta: Record<string, string>): void {
  if (!Array.isArray(e.authors)) return;
  const names: string[] = [];
  const affils = new Set<string>();
  for (const a of e.authors) {
    const author = asObj(a);
    const name = asStr(author?.name);
    if (!name) continue;
    names.push(name);
    const affiliation = asStr(author?.affiliation);
    if (affiliation) affils.add(affiliation);
  }
  if (!names.length) return;
  meta.authors = names.length > 6 ? `${names.slice(0, 6).join(', ')} 等 ${names.length} 位作者` : names.join(', ');
  if (affils.size) meta.affiliations = [...affils].join(', ');
}

/** 通用 meta 构造（design §2.3.3 表逐键：uri/url/doi/authors/affiliations/steps_count/
 *  materials_count/version_id/published_at（ISO 截日期）/retrieved_at（必设）/
 *  peer_reviewed 三态/steps_summary（前 3 步 ≤600）/is_ai_summary:'false'） */
function buildProtocolMeta(e: Record<string, unknown>, stepsSummary?: string[], materialsCount?: number): Record<string, string> {
  const meta: Record<string, string> = { source: 'protocol' };
  if (asStr(e.uri)) meta.uri = e.uri as string;
  const url = asStr(e.url) ?? asStr(e.source_url);
  if (url) meta.url = url; // 原文链接（必填可回查，spec 6.4.2）
  if (asStr(e.doi)) meta.doi = e.doi as string; // null → 不设键（无 DOI 不虚构）
  projectPeople(e, meta);
  if (e.steps_count !== undefined && e.steps_count !== null && e.steps_count !== '') meta.steps_count = String(e.steps_count);
  const matCount = materialsCount ?? (Array.isArray(e.materials) ? e.materials.length : undefined);
  if (matCount !== undefined) meta.materials_count = String(matCount);
  if (e.version_id !== undefined && e.version_id !== null && e.version_id !== '') meta.version_id = String(e.version_id);
  const publishedAt = asStr(e.published_at);
  if (publishedAt) meta.published_at = publishedAt.slice(0, 10); // ISO 截日期
  meta.retrieved_at = asStr(e.retrieved_at) ?? new Date().toISOString(); // 必设；缓存命中沿用原值
  if (e.peer_reviewed === true) meta.peer_reviewed = 'true';
  else if (e.peer_reviewed === false) meta.peer_reviewed = 'false'; // null/undefined → 键不设（未知态）
  const summaryList = stepsSummary ?? (Array.isArray(e.steps_summary)
    ? e.steps_summary.map((s) => asStr(asObj(s)?.text)).filter((s): s is string => !!s)
    : undefined);
  if (summaryList?.length) {
    const joined = summaryList.slice(0, 3).join(' → ');
    meta.steps_summary = joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
  }
  // 警示投影（spec 5.5.1 规则 4「视觉可辨识」的前端结构化来源）：详情 DTO 含 warning 时随 meta 下发；
  // meta 文本预算独立 600 截断（信封层已 1000 截断，meta 层防 JSONB 膨胀），截断不丢 has_warning 标志
  const warning = asStr(e.warning);
  if (warning) {
    meta.has_warning = 'true';
    meta.warning = warning.length > 600 ? `${warning.slice(0, 600)}…` : warning;
  }
  meta.is_ai_summary = 'false'; // 原始内容 vs AI 总结区分标识（spec 6.4.3）
  return meta;
}

function truncateSummary(text: string | undefined): string {
  if (!text) return '';
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/** 搜索条目 → 多卡（≤20、按 source_id 去重在调用方）；summary 无 description 时为空 */
function searchResultCard(tool: string, item: unknown): Json | null {
  const e = asObj(item);
  if (!e) return null;
  const sourceId = e.source_id !== undefined && e.source_id !== null && e.source_id !== '' ? String(e.source_id) : '';
  const title = asStr(e.title);
  if (!sourceId || !title) return null; // 无编号/标题无可呈现
  return {
    tool,
    accession: sourceId,
    title,
    summary: truncateSummary(asStr(e.description)),
    meta: buildProtocolMeta(e),
  };
}

/** 详情条目 → 单卡（detail 级：materials_count/steps_summary 概要更全） */
function detailCard(tool: string, item: unknown): Json | null {
  const e = asObj(item);
  if (!e) return null;
  const sourceId = e.source_id !== undefined && e.source_id !== null && e.source_id !== '' ? String(e.source_id) : '';
  const title = asStr(e.title);
  if (!sourceId || !title) return null;
  return {
    tool,
    accession: sourceId,
    title,
    summary: truncateSummary(asStr(e.description)),
    meta: buildProtocolMeta(e),
  };
}

/** 步骤信封 → 单卡：accession 取 protocol.id（信封 protocol 上下文为回查锚点），
 *  steps_summary 取完整步骤前 3 条、materials_count 取信封 materials 数；
 *  信封顶层 warning/materials_note（不在 protocol 上下文）在此补投影——
 *  has_warning + 截断文本 + materials_unavailable 标志，前端据此渲染 pet-amber 警告段
 *  与材料降级提示（spec 5.5.1 规则 4 / 5.5.2 场景 2 的卡片侧落地） */
function stepsCard(tool: string, envelope: Record<string, unknown>): Json | null {
  const protocol = asObj(envelope.protocol);
  const results = Array.isArray(envelope.results) ? envelope.results : [];
  const materials = Array.isArray(envelope.materials) ? envelope.materials : [];
  const id = protocol && protocol.id !== undefined && protocol.id !== null && protocol.id !== '' ? String(protocol.id) : '';
  if (!id) return null;
  const title = asStr(protocol?.title);
  const stepsSummary = results
    .map((s) => asStr(asObj(s)?.text))
    .filter((s): s is string => !!s);
  const card = {
    tool,
    accession: id,
    title: title ?? `协议 ${id} 完整步骤`,
    summary: truncateSummary(stepsSummary.slice(0, 3).join(' → ')),
    meta: buildProtocolMeta(protocol ?? {}, stepsSummary, materials.length),
  };
  const meta = (card as { meta: Record<string, string> }).meta;
  if (asStr(envelope.materials_note)) meta.materials_unavailable = 'true'; // 材料降级标志（前端 i18n 文案，不投中文长文本）
  return card;
}