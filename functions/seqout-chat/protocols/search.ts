// search.ts：protocols_search 工具实现（design §2.1.3D、§2.2.2、§2.3.2 v3 映射表、§2.6）。
// 链路：key 清洗校验（空/超长/纯符号 → 中文参数错误，零 fetch）→ 短时缓存查询 →
// GET /v3/protocols（filter=public 硬编码——服务端兜底，模型无从选择非公开范围）→
// items→DTO 收窄（DOI 剥前缀、Unix 秒→ISO、按 source_id 去重）→ 信封组装（含分页元信息回灌）。
// 空矿（零命中）：success 形态 + empty:true + 中文改写建议——isBusinessEmpty 判 empty 计 empties 不计 errors。
// peer_reviewed 三态（spec 4.4.4 语义红线）：上游响应无逐条评审字段（匿名实测确认），
// 筛选推断——请求参数 peer_reviewed=1 → 全部 true；=0 → 全部 false；未筛选 → null（未知）。
// 依赖约束：仅 client.ts 与 types.ts。

import { protocolsFetch, protocolsCacheGet, protocolsCacheSet, getProtocolsConfig } from './client.ts';
import { PROTOCOLS_SOURCE, PROTOCOLS_VIEW_BASE, PROTOCOLS_SITE_URL } from './types.ts';
import type { ProtocolAuthor, ProtocolSearchResult, ProtocolSearchEnvelope } from './types.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

/** 搜索词清洗（对齐 biomed cleanGeneTerm 模式）：控制字符归一、折叠空白；拒绝空/超长/纯符号 */
export function cleanProtocolKey(raw: unknown): string {
  const cleaned = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    throw new Error('检索关键词为空或只含控制字符。请给出实验方法关键词（如 RNA extraction、"RNA extraction" 精确短语、qPCR）后重试。');
  }
  if (cleaned.length > 200) {
    throw new Error(`检索关键词过长（${cleaned.length} 字符，上限 200）。应为实验方法短语，如 RNA extraction。`);
  }
  if (!/[\p{L}\p{N}]/u.test(cleaned)) {
    throw new Error(`检索关键词「${cleaned.slice(0, 50)}」不含任何字母或数字，无法检索。`);
  }
  return cleaned;
}

const ORDER_FIELDS = new Set(['activity', 'relevance', 'date', 'name', 'id']);
const ORDER_DIRS = new Set(['asc', 'desc']);

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 剥 DOI 前缀 → 规范形（10.xxxx/...）；空串/null/无前缀可剥的空值 → null（三态红线） */
export function normalizeDoi(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^dx\.doi\.org\//i, '');
}

/** Unix 秒 → ISO 8601；0/缺失/非法 → undefined（published_on=0=未发布，不虚构时间） */
function unixToIso(raw: unknown): string | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

function narrowAuthor(raw: unknown): ProtocolAuthor | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  const name = typeof a.name === 'string' && a.name ? a.name : undefined;
  if (!name) return undefined;
  return {
    name,
    affiliation: typeof a.affiliation === 'string' && a.affiliation ? a.affiliation : undefined,
    username: typeof a.username === 'string' && a.username ? a.username : undefined,
    link: typeof a.link === 'string' && a.link ? a.link : undefined,
  };
}

function narrowAuthors(raw: unknown): ProtocolAuthor[] {
  if (!Array.isArray(raw)) return [];
  const out: ProtocolAuthor[] = [];
  for (const item of raw) {
    const a = narrowAuthor(item);
    if (a) out.push(a);
  }
  return out;
}

/** v3 items 条目 → ProtocolSearchResult（design §2.3.2 v3 映射表逐行；id/title 缺失条目丢弃） */
function narrowSearchItem(item: unknown, peerReviewed: boolean | null, retrievedAt: string): ProtocolSearchResult | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const it = item as Record<string, unknown>;
  const id = it.id;
  if (typeof id !== 'number' && !/^\d+$/.test(String(id ?? ''))) return null;
  const title = typeof it.title === 'string' && it.title ? it.title : undefined;
  if (!title) return null; // 无标题无可呈现
  const uri = typeof it.uri === 'string' && it.uri ? it.uri : undefined;
  const description = typeof it.description === 'string' && it.description ? it.description : undefined;
  const result: ProtocolSearchResult = {
    source: PROTOCOLS_SOURCE,
    source_id: String(id),
    title,
    authors: narrowAuthors(it.authors),
    doi: normalizeDoi(it.doi),
    // 原文链接必填可回查（spec 6.2.7）：uri 缺失走站点检索页兜底（不伪造具体方案页）
    source_url: uri ? `${PROTOCOLS_VIEW_BASE}${uri}` : PROTOCOLS_SITE_URL,
    peer_reviewed: peerReviewed,
    retrieved_at: retrievedAt,
  };
  if (uri) result.uri = uri;
  if (description) result.description = description;
  const creator = narrowAuthor(it.creator);
  if (creator) result.creator = creator;
  const publishedAt = unixToIso(it.published_on);
  if (publishedAt) result.published_at = publishedAt;
  const createdAt = unixToIso(it.created_on);
  if (createdAt) result.created_at = createdAt;
  if (typeof it.version_id === 'number') result.version_id = it.version_id;
  if (typeof it.number_of_steps === 'number') result.steps_count = it.number_of_steps;
  return result;
}

export interface ProtocolSearchArgs {
  key?: unknown;
  peer_reviewed?: unknown;
  order_field?: unknown;
  order_dir?: unknown;
  page_size?: unknown;
  page_id?: unknown;
}

/** protocols_search 主入口：返回 {success:true, data: ProtocolSearchEnvelope} 信封 */
export async function searchProtocols(args: ProtocolSearchArgs): Promise<Json> {
  const key = cleanProtocolKey(args.key);
  // peer_reviewed：boolean true→1 / false→0 / 缺省不传（上游 int 语义）；三态推断依据进 DTO
  let peerReviewed: boolean | null = null;
  const upstreamParams: Record<string, string> = {
    filter: 'public', // 硬编码：公开范围的服务端兜底（design §2.2.2）
    key,
  };
  if (args.peer_reviewed === true) {
    peerReviewed = true;
    upstreamParams.peer_reviewed = '1';
  } else if (args.peer_reviewed === false) {
    peerReviewed = false;
    upstreamParams.peer_reviewed = '0';
  }
  const orderField = args.order_field === undefined || args.order_field === null || args.order_field === '' ? undefined : String(args.order_field);
  if (orderField !== undefined) {
    if (!ORDER_FIELDS.has(orderField)) {
      throw new Error(`排序字段不正确：${orderField}（应为 activity / relevance / date / name / id 之一，默认 activity）`);
    }
    upstreamParams.order_field = orderField;
  }
  const orderDir = args.order_dir === undefined || args.order_dir === null || args.order_dir === '' ? undefined : String(args.order_dir);
  if (orderDir !== undefined) {
    if (!ORDER_DIRS.has(orderDir)) {
      throw new Error(`排序方向不正确：${orderDir}（应为 asc 或 desc，默认 desc）`);
    }
    upstreamParams.order_dir = orderDir;
  }
  const pageSize = clampInt(args.page_size, 10, 1, 100);
  const pageId = clampInt(args.page_id, 1, 1, 10000);
  upstreamParams.page_size = String(pageSize);
  upstreamParams.page_id = String(pageId);

  // 短时缓存（design §2.6）：命中零上游请求、retrieved_at 沿用原值（如实呈现）
  const cacheKey = `search:${key}:${orderField ?? ''}:${orderDir ?? ''}:${pageSize}:${pageId}:${peerReviewed ?? ''}`;
  const cached = protocolsCacheGet<Json>(cacheKey);
  if (cached !== undefined) return { success: true, data: cached };

  const resp = await protocolsFetch('/v3/protocols', upstreamParams);
  const envelope = buildSearchEnvelope(resp as Record<string, unknown>, peerReviewed);
  protocolsCacheSet(cacheKey, envelope as unknown as Json, getProtocolsConfig().searchTtlSec);
  return { success: true, data: envelope as unknown as Json };
}

/** 上游响应 → 收窄信封（含空矿判定与分页元信息回灌） */
function buildSearchEnvelope(resp: Record<string, unknown>, peerReviewed: boolean | null): ProtocolSearchEnvelope {
  const items = Array.isArray(resp.items) ? resp.items : [];
  const retrievedAt = new Date().toISOString();
  const seen = new Set<string>();
  const results: ProtocolSearchResult[] = [];
  for (const item of items) {
    const narrowed = narrowSearchItem(item, peerReviewed, retrievedAt);
    if (!narrowed || seen.has(narrowed.source_id)) continue; // 按 source_id 去重（spec 6.2.2）
    seen.add(narrowed.source_id);
    results.push(narrowed);
  }
  const pagination = resp.pagination && typeof resp.pagination === 'object' && !Array.isArray(resp.pagination)
    ? (resp.pagination as Record<string, unknown>)
    : undefined;
  const envelope: ProtocolSearchEnvelope = {
    results,
    // total：上游顶层 total 或 pagination.total_results（匿名基线两者并见，取其一）
    total: typeof resp.total === 'number' ? resp.total
      : typeof pagination?.total_results === 'number' ? pagination.total_results
      : results.length,
    source: PROTOCOLS_SOURCE,
  };
  if (typeof pagination?.total_pages === 'number') envelope.total_pages = pagination.total_pages;
  if (typeof pagination?.current_page === 'number') envelope.current_page = pagination.current_page;
  if (typeof pagination?.page_size === 'number') envelope.page_size = pagination.page_size;
  if (results.length === 0) {
    // 空矿信封（design §2.1.3D）：empty:true 计 empties 不计 errors；note 含改写建议
    envelope.empty = true;
    envelope.total = 0;
    envelope.note = '未找到相关实验方案。可尝试：换用英文关键词（protocols.io 收录以英文为主）、放宽检索条件、去掉精确短语的双引号，或调整排序字段后重试。';
  }
  return envelope;
}