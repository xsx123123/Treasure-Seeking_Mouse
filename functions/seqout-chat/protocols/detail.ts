// detail.ts：protocols_get_details 与 protocols_get_steps 工具实现（design §2.1.3E/F、§2.3.2 v4 映射表、§2.6）。
//
// getProtocolDetails：id 三形态校验（数字 ID / URI / DOI）→ 详情缓存查询 →
//   GET /v4/protocols/{id}?content_format=markdown&last_version=1（markdown 固定选型，
//   design §2.1.3E：可直接回灌模型 + 前端 Markdown 渲染 + 避免 Draft 解析与 HTML 清洗；
//   不暴露 content_format 给模型）→ payload 收窄（时间三分、步骤概要化、材料保真、文本预算截断）。
//   404 → not_found 信封（success:true + not_found:true，不计 errors 也不计 empties，
//   对齐 gene_get 404 语义——对象寻址失败 ≠ 检索空矿）。
//
// getProtocolSteps：复用规则（spec 5.5.1 规则 1）——详情缓存命中且含可用步骤全文 → 零额外上游
//   请求直接组装信封；未命中 → GET /v4/protocols/{id}/steps → previous_id 链重建保序
//   （首步 previous_id=0 起点顺链而下；断链孤儿按原相对顺序尾部如实保留，绝不重排合并，
//   spec 5.5.1 规则 2）→ 材料端点失败 → materials_note 降级不整体失败（spec 5.5.2 场景 2）。
//
// 步骤文本形态兼容（design §2.13 第 4 项待实测收紧）：content_format=markdown 下假设
// steps[i].step 为字符串；解析层同时兼容 Draft 对象（blocks[].text）与 components 数组形态。
//
// 依赖约束：仅 client.ts 与 types.ts。

import { protocolsFetch, protocolsCacheGet, protocolsCacheSet, getProtocolsConfig, isProtocolsNotFound } from './client.ts';
import {
  PROTOCOLS_SOURCE, PROTOCOLS_VIEW_BASE, PROTOCOLS_SITE_URL, PROTOCOLS_TEXT_BUDGET, PROTOCOLS_DETAIL_TTL_SEC,
} from './types.ts';
import type {
  ProtocolAuthor, ProtocolDetail, ProtocolStep, ProtocolStepSummary, ProtocolMaterial, ProtocolStats,
  ProtocolVersionSummary, ProtocolDetailEnvelope, ProtocolStepsEnvelope, ProtocolContext,
} from './types.ts';
import { normalizeDoi } from './search.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

// --- id 三形态校验与规范化 ---

/** id 规范化：数字 ID 原样；URI slug 原样；DOI 剥 dx.doi.org/、https://doi.org/ 前缀取规范形 */
export function normalizeProtocolId(raw: unknown): string {
  const id = String(raw ?? '').trim();
  if (!id) {
    throw new Error('协议标识为空。请提供协议数字 ID（如 872）、URI（如 lysis-buffer-20-ml-c4gytv）或 DOI（如 10.17504/protocols.io.c4gytv）。');
  }
  if (id.length > 300) {
    throw new Error(`协议标识过长（${id.length} 字符，上限 300）。应为数字 ID、URI 或 DOI。`);
  }
  // DOI 前缀剥离（上游 v4 路径参数接受规范形 DOI）
  const stripped = id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^dx\.doi\.org\//i, '');
  if (/^\d+$/.test(stripped)) return stripped; // 数字 ID
  if (/^10\.\d{4,9}\/\S+$/.test(stripped)) return stripped; // DOI 规范形
  if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(stripped) && /-/.test(stripped)) return stripped; // URI slug（protocols.io uri 恒含连字符）
  throw new Error(`协议标识格式不正确：「${stripped.slice(0, 60)}」。应为数字 ID（如 872）、URI（如 lysis-buffer-20-ml-c4gytv）或 DOI（如 10.17504/protocols.io.c4gytv）三形态之一。`);
}

// --- 通用收窄辅助 ---

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

/** 文本预算截断：超限截断并以标记收尾（如「…(截断)」），未超限原样 */
function budgetText(raw: unknown, limit: number): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return raw.length > limit ? `${raw.slice(0, limit)}…(截断)` : raw;
}

// --- 材料保真收窄（spec 5.5.1 规则 3：只收窄不补全，存在才保留，缺失 undefined 不虚构） ---

/** 材料形态判别：有 brand/specifications → equipment；其余 reagent；无名称且无判别依据 → other */
export function narrowMaterial(raw: unknown): ProtocolMaterial | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const isEquipment = (m.brand !== undefined && m.brand !== null && m.brand !== '') || (m.specifications !== undefined && m.specifications !== null && m.specifications !== '');
  const vendor = m.vendor && typeof m.vendor === 'object' && !Array.isArray(m.vendor) ? m.vendor as Record<string, unknown> : undefined;
  const material: ProtocolMaterial = { kind: isEquipment ? 'equipment' : 'reagent' };
  if (typeof m.name === 'string' && m.name) material.name = m.name;
  if (typeof m.sku === 'string' && m.sku) material.sku = m.sku;
  if (typeof vendor?.name === 'string' && vendor.name) material.vendor_name = vendor.name;
  if (typeof vendor?.link === 'string' && vendor.link) material.vendor_url = vendor.link;
  if (typeof m.mol_weight === 'number' && Number.isFinite(m.mol_weight)) material.mol_weight = m.mol_weight;
  if (typeof m.url === 'string' && m.url) material.url = m.url;
  else if (typeof m.link === 'string' && m.link) material.url = m.link;
  if (typeof m.specifications === 'string' && m.specifications) material.specifications = m.specifications;
  if (!material.name && !material.sku && !material.vendor_name && !material.url) {
    material.kind = 'other';
    if (!material.name && !material.sku && !material.vendor_name && !material.url && !material.mol_weight && !material.specifications) return null; // 全空条目丢弃
  }
  return material;
}

function narrowMaterials(raw: unknown): ProtocolMaterial[] {
  if (!Array.isArray(raw)) return [];
  const out: ProtocolMaterial[] = [];
  for (const item of raw) {
    const m = narrowMaterial(item);
    if (m) out.push(m);
  }
  return out;
}

// --- 步骤文本提取（多形态兼容，design §2.13 第 4 项假设：markdown 字符串） ---

interface RawStep {
  id?: unknown;
  guid?: unknown;
  previous_id?: unknown;
  previous_guid?: unknown;
  modified_on?: unknown;
  step?: unknown;
  components?: unknown;
}

function asStep(raw: unknown): RawStep | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as RawStep;
}

/** 单步文本：string 直取；Draft 对象提 blocks[].text；components 数组逐组件提 description/name */
function extractStepText(step: RawStep): string {
  const s = step.step;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    const blocks = (s as Record<string, unknown>).blocks;
    if (Array.isArray(blocks)) {
      const parts: string[] = [];
      for (const b of blocks) {
        if (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string') {
          parts.push((b as Record<string, unknown>).text as string);
        }
      }
      if (parts.length) return parts.join('\n');
    }
  }
  if (Array.isArray(step.components)) {
    const parts: string[] = [];
    for (const c of step.components) {
      if (!c || typeof c !== 'object') continue;
      const comp = c as Record<string, unknown>;
      const text = typeof comp.description === 'string' ? comp.description : typeof comp.name === 'string' ? comp.name : undefined;
      if (text) parts.push(text);
    }
    if (parts.length) return parts.join('\n');
  }
  return '';
}

/** 步骤内 reagent/equipment 实体名称概要（不解析 Draft 细节，design §2.13 假设 2） */
function extractComponentsSummary(step: RawStep): string[] | undefined {
  if (!Array.isArray(step.components)) return undefined;
  const names: string[] = [];
  for (const c of step.components) {
    if (!c || typeof c !== 'object') continue;
    const comp = c as Record<string, unknown>;
    const type = typeof comp.type === 'string' ? comp.type.toLowerCase() : '';
    if ((type.includes('reagent') || type.includes('equipment')) && typeof comp.name === 'string' && comp.name) {
      names.push(comp.name);
    }
  }
  return names.length ? names : undefined;
}

/** previous_id 链重建保序（O(n)，design §2.1.3E）：首步 previous_id=0 起点顺链而下；
 *  断链孤儿按原相对顺序追加尾部如实保留——绝不重排合并（spec 5.5.1 规则 2 语义红线）。 */
export function chainSteps(rawSteps: unknown[]): RawStep[] {
  const steps = rawSteps.map(asStep).filter((s): s is RawStep => s !== null);
  const byId = new Map<string, RawStep>();
  for (const s of steps) {
    if (s.id !== undefined && s.id !== null && s.id !== '') byId.set(String(s.id), s);
  }
  const HEAD = '\0head';
  const byPrev = new Map<string, RawStep[]>();
  for (const s of steps) {
    const prev = s.previous_id;
    const key = prev === 0 || prev === undefined || prev === null || prev === '' || String(prev) === '0' ? HEAD : String(prev);
    const list = byPrev.get(key);
    if (list) list.push(s);
    else byPrev.set(key, [s]);
  }
  const ordered: RawStep[] = [];
  const placed = new Set<RawStep>();
  const walk = (start: RawStep) => {
    let cur: RawStep | undefined = start;
    while (cur && !placed.has(cur)) {
      placed.add(cur);
      ordered.push(cur);
      const id = cur.id !== undefined && cur.id !== null && cur.id !== '' ? String(cur.id) : '';
      cur = id ? byPrev.get(id)?.[0] : undefined;
    }
  };
  for (const head of byPrev.get(HEAD) ?? []) walk(head);
  // 孤儿兜底：不在链序中的步骤（断链/分支/无 id 不可链）按原相对顺序尾部保留
  for (const s of steps) {
    if (!placed.has(s)) {
      placed.add(s);
      ordered.push(s);
    }
  }
  return ordered;
}

/** 链序原始步骤 → 完整层 ProtocolStep（单步 ≤600 截断，≤60 步上限截断标记） */
function buildFullSteps(rawSteps: unknown[]): { steps: ProtocolStep[]; truncated: boolean } {
  const chained = chainSteps(rawSteps);
  const truncated = chained.length > PROTOCOLS_TEXT_BUDGET.stepsFullMax;
  const capped = truncated ? chained.slice(0, PROTOCOLS_TEXT_BUDGET.stepsFullMax) : chained;
  const steps: ProtocolStep[] = [];
  capped.forEach((s, i) => {
    const text = extractStepText(s);
    const step: ProtocolStep = {
      position: i + 1,
      text: text.length > PROTOCOLS_TEXT_BUDGET.step ? `${text.slice(0, PROTOCOLS_TEXT_BUDGET.step)}…(截断)` : text,
    };
    const comps = extractComponentsSummary(s);
    if (comps) step.components_summary = comps;
    const modified = unixToIsoMs(s.modified_on);
    if (modified) step.modified_on = modified;
    steps.push(step);
  });
  return { steps, truncated };
}

/** modified_on 为 Unix 毫秒（上游步骤时间戳形态与 published_on 秒级不同，双兼容） */
function unixToIsoMs(raw: unknown): string | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

/** 概要层 steps_summary：每步「序号 + 首行 ≤120 字」，≤20 步（design §2.1.3F） */
function buildStepsSummary(rawSteps: unknown[]): { summary: ProtocolStepSummary[]; count: number } {
  const chained = chainSteps(rawSteps);
  const summary: ProtocolStepSummary[] = [];
  for (let i = 0; i < Math.min(chained.length, PROTOCOLS_TEXT_BUDGET.stepsSummaryMax); i++) {
    const text = extractStepText(chained[i]);
    const firstLine = text.split('\n')[0]?.trim() ?? '';
    summary.push({
      position: i + 1,
      text: firstLine.length > PROTOCOLS_TEXT_BUDGET.stepSummary ? `${firstLine.slice(0, PROTOCOLS_TEXT_BUDGET.stepSummary)}…` : firstLine,
    });
  }
  return { summary, count: chained.length };
}

// --- 详情缓存复合载体（design §2.6：ProtocolDetail + 完整步骤 markdown ≤32KB + 材料清单） ---

export interface DetailCachePayload {
  /** 详情 DTO（get_steps 先行缓存的载体可能无详情——只含步骤与材料） */
  detail?: ProtocolDetail;
  stepsFull?: ProtocolStep[];
  materials?: ProtocolMaterial[];
}

function detailCacheKey(id: string): string {
  return `detail:${id.toLowerCase()}`;
}

/** 缓存体积预算：超限协议降级只缓存概要（get_steps 重新请求如实组装，design §2.6 协调决策） */
function writeDetailCache(id: string, payload: DetailCachePayload): void {
  let candidate: DetailCachePayload = payload;
  try {
    if (JSON.stringify(candidate).length > PROTOCOLS_TEXT_BUDGET.detailCacheBytes) {
      candidate = { detail: payload.detail };
    }
  } catch { candidate = { detail: payload.detail }; }
  protocolsCacheSet(detailCacheKey(id), candidate, getProtocolsConfig().detailTtlSec || PROTOCOLS_DETAIL_TTL_SEC);
}

// --- v4 payload → ProtocolDetail（design §2.3.2 v4 映射表逐行） ---

function narrowStats(raw: unknown): ProtocolStats | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const stats: ProtocolStats = {};
  let has = false;
  for (const key of ['number_of_views', 'number_of_steps', 'number_of_votes', 'number_of_runs', 'number_of_reagents', 'number_of_equipments'] as const) {
    if (typeof s[key] === 'number') {
      stats[key] = s[key] as number;
      has = true;
    }
  }
  return has ? stats : undefined;
}

function narrowVersions(raw: unknown): ProtocolVersionSummary[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ProtocolVersionSummary[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const versionId = typeof v.version_id === 'number' ? v.version_id : typeof v.id === 'number' ? v.id : undefined;
    if (versionId === undefined) continue;
    const summary: ProtocolVersionSummary = { version_id: versionId };
    if (typeof v.uri === 'string' && v.uri) summary.uri = v.uri;
    const published = unixToIso(v.published_on);
    if (published) summary.published_on = published;
    out.push(summary);
  }
  return out.length ? out : undefined;
}

function narrowDetail(payloadRaw: unknown, id: string): DetailCachePayload | null {
  if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) return null;
  const p = payloadRaw as Record<string, unknown>;
  const title = typeof p.title === 'string' && p.title ? p.title : undefined;
  if (!title) return null;
  const sourceId = p.id !== undefined && p.id !== null && p.id !== '' ? String(p.id) : id;
  const uri = typeof p.uri === 'string' && p.uri ? p.uri : undefined;
  // url：payload.url 原样（实测存在）；缺失回退 view/{uri} 构造（design §2.3.2）
  const url = typeof p.url === 'string' && p.url ? p.url : uri ? `${PROTOCOLS_VIEW_BASE}${uri}` : undefined;
  // doi：剥前缀；is_doi_reserved===true 且 doi 空 → null（未发布 DOI 不虚构）
  const doi = normalizeDoi(p.doi);
  const detail: ProtocolDetail = {
    source: PROTOCOLS_SOURCE,
    source_id: sourceId,
    title,
    authors: narrowAuthors(p.authors),
    doi,
    steps_summary: [],
    materials: [],
    retrieved_at: new Date().toISOString(),
  };
  if (uri) detail.uri = uri;
  if (typeof p.guid === 'string' && p.guid) detail.guid = p.guid;
  if (url) detail.url = url;
  const creator = narrowAuthor(p.creator);
  if (creator) detail.creator = creator;
  // —— 时间三分（spec 6.3.6）：发布 / 版本 / 获取三独立字段，禁止互相冒充 ——
  const publishedAt = unixToIso(p.published_on);
  if (publishedAt) detail.published_at = publishedAt;
  const versions = narrowVersions(p.versions);
  if (versions) {
    detail.versions = versions;
    const latest = versions[versions.length - 1];
    if (latest?.published_on) detail.version_published_at = latest.published_on;
  }
  // 文本预算截断（design §2.3.2：2000/1000/1000/1000/800）
  const description = budgetText(p.description, PROTOCOLS_TEXT_BUDGET.description);
  if (description) detail.description = description;
  const beforeStart = budgetText(p.before_start, PROTOCOLS_TEXT_BUDGET.beforeStart);
  if (beforeStart) detail.before_start = beforeStart;
  const guidelines = budgetText(p.guidelines, PROTOCOLS_TEXT_BUDGET.guidelines);
  if (guidelines) detail.guidelines = guidelines;
  const warning = budgetText(p.warning, PROTOCOLS_TEXT_BUDGET.warning);
  if (warning) detail.warning = warning;
  // 材料清单（payload.materials 保真收窄）与原文材料文本
  detail.materials = narrowMaterials(p.materials);
  const materialsText = budgetText(p.materials_text, PROTOCOLS_TEXT_BUDGET.materialsText);
  if (materialsText) detail.materials_text = materialsText;
  // 步骤概要层 + 完整层（payload 自带 steps，为 get_steps 复用规则预置；缺 steps 视为空数组）
  const rawSteps: unknown[] = Array.isArray(p.steps) ? p.steps : [];
  const { summary, count } = buildStepsSummary(rawSteps);
  detail.steps_summary = summary;
  const stats = narrowStats(p.stats);
  if (stats) {
    detail.stats = stats;
    if (typeof stats.number_of_steps === 'number') detail.steps_count = stats.number_of_steps;
  }
  if (detail.steps_count === undefined && count > 0) detail.steps_count = count;
  if (typeof p.version_id === 'number') detail.version_id = p.version_id;
  const stepsFull = buildFullSteps(rawSteps);
  return { detail, stepsFull: stepsFull.steps, materials: detail.materials };
}

export interface ProtocolDetailArgs { id?: unknown }

/** protocols_get_details 主入口：{success:true, data: ProtocolDetailEnvelope} 信封（单元素数组） */
export async function getProtocolDetails(args: ProtocolDetailArgs): Promise<Json> {
  const id = normalizeProtocolId(args.id);
  const cacheKey = detailCacheKey(id);
  const cached = protocolsCacheGet<DetailCachePayload>(cacheKey);
  if (cached?.detail) {
    const envelope: ProtocolDetailEnvelope = { results: [cached.detail], source: PROTOCOLS_SOURCE };
    return { success: true, data: envelope as unknown as Json };
  }
  let payload: Json;
  try {
    payload = await protocolsFetch(`/v4/protocols/${id}`, { content_format: 'markdown', last_version: '1' });
  } catch (err) {
    if (isProtocolsNotFound(err)) {
      // not_found 信封（design §2.1.3D）：不设 empty 字段——不计 errors 也不计 empties
      const envelope: ProtocolDetailEnvelope = {
        results: [],
        source: PROTOCOLS_SOURCE,
        not_found: true,
        note: '该协议不存在或当前不可访问，可核对标识（数字 ID / URI / DOI）或打开 protocols.io 原文链接核实。',
      };
      return { success: true, data: envelope as unknown as Json };
    }
    throw err;
  }
  const bodyObj = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const payloadRaw = bodyObj?.payload;
  const narrowed = narrowDetail(payloadRaw, id);
  if (!narrowed) {
    // payload 缺失或无 title：不可解析的成功响应，如实按 not_found 处理（不虚构）
    const envelope: ProtocolDetailEnvelope = {
      results: [],
      source: PROTOCOLS_SOURCE,
      not_found: true,
      note: '该协议详情不可解析（上游响应缺少必要字段），可打开 protocols.io 原文链接核实。',
    };
    return { success: true, data: envelope as unknown as Json };
  }
  // 合并缓存中既有的步骤/材料（get_steps 先行缓存的场景），保持复用规则有效
  const merged: DetailCachePayload = {
    detail: narrowed.detail,
    stepsFull: narrowed.stepsFull ?? cached?.stepsFull,
    materials: narrowed.materials ?? cached?.materials,
  };
  writeDetailCache(id, merged);
  const envelope: ProtocolDetailEnvelope = { results: [narrowed.detail], source: PROTOCOLS_SOURCE };
  return { success: true, data: envelope as unknown as Json };
}

export interface ProtocolStepsArgs { id?: unknown }

/** protocols_get_steps 主入口：复用规则 + 链重建保序 + 材料降级（design §2.1.3E 流程图） */
export async function getProtocolSteps(args: ProtocolStepsArgs): Promise<Json> {
  const id = normalizeProtocolId(args.id);
  const cacheKey = detailCacheKey(id);
  const cached = protocolsCacheGet<DetailCachePayload>(cacheKey);

  // 复用规则（spec 5.5.1 规则 1）：详情缓存命中且含可用步骤全文 → 零额外 steps/materials 上游请求
  if (cached?.stepsFull) {
    const envelope = buildStepsEnvelope(cached.stepsFull, cached.materials ?? [], cached?.detail);
    return { success: true, data: envelope as unknown as Json };
  }

  let stepsRaw: unknown[] = [];
  try {
    const resp = await protocolsFetch(`/v4/protocols/${id}/steps`, { content_format: 'markdown', last_version: '1' });
    const bodyObj = resp && typeof resp === 'object' && !Array.isArray(resp) ? resp as Record<string, unknown> : null;
    stepsRaw = Array.isArray(bodyObj?.steps) ? bodyObj.steps : [];
  } catch (err) {
    if (isProtocolsNotFound(err)) {
      const envelope: ProtocolStepsEnvelope = {
        results: [],
        materials: [],
        source: PROTOCOLS_SOURCE,
        empty: true,
        note: '该协议不存在或当前不可访问，可核对标识或打开原文链接核实。',
      };
      return { success: true, data: envelope as unknown as Json };
    }
    throw err;
  }

  // 步骤空（提纲型协议）→ EMPTY 信封（design §2.1.3B EMPTY 行：计 empties 不计 errors）
  if (stepsRaw.length === 0) {
    const envelope: ProtocolStepsEnvelope = {
      results: [],
      materials: [],
      source: PROTOCOLS_SOURCE,
      empty: true,
      note: '该协议未提供详细步骤（提纲型协议），可打开原文链接查看。',
    };
    return { success: true, data: envelope as unknown as Json };
  }

  // 材料获取：详情缓存有则复用；否则请求材料端点；失败 → materials_note 降级（不整体失败）
  let materials: ProtocolMaterial[] = cached?.materials ?? [];
  let materialsNote: string | undefined;
  if (!cached?.materials) {
    try {
      const resp = await protocolsFetch(`/v3/protocols/${id}/materials`);
      const bodyObj = resp && typeof resp === 'object' && !Array.isArray(resp) ? resp as Record<string, unknown> : null;
      materials = Array.isArray(bodyObj?.materials) ? narrowMaterials(bodyObj.materials) : [];
    } catch {
      materialsNote = '材料清单暂不可用（上游材料端点无响应或失败），以 protocols.io 原文为准。';
    }
  }

  const { steps, truncated } = buildFullSteps(stepsRaw);
  const envelope = buildStepsEnvelope(steps, materials, cached?.detail, materialsNote, id);
  if (truncated) envelope.steps_truncated = true;

  // 缓存回写：stepsFull/materials 合入既有缓存（不虚构假 detail——get_steps 先行场景只存步骤与材料）
  writeDetailCache(id, cached
    ? { detail: cached.detail, stepsFull: steps, materials }
    : { stepsFull: steps, materials });
  return { success: true, data: envelope as unknown as Json };
}

function buildStepsEnvelope(
  steps: ProtocolStep[],
  materials: ProtocolMaterial[],
  detail?: ProtocolDetail,
  materialsNote?: string,
  protocolId?: string,
): ProtocolStepsEnvelope {
  const envelope: ProtocolStepsEnvelope = {
    results: steps,
    materials,
    source: PROTOCOLS_SOURCE,
  };
  // 协议级上下文（卡片投影回查锚点）：详情缓存有则取全；否则仅 id（信封字段只增不改）
  if (detail || protocolId) {
    const context: ProtocolContext = detail
      ? {
          id: detail.source_id,
          retrieved_at: detail.retrieved_at,
        }
      : { id: protocolId as string, retrieved_at: new Date().toISOString() };
    if (detail) {
      if (detail.title) context.title = detail.title;
      if (detail.url) context.url = detail.url;
      if (detail.doi !== null) context.doi = detail.doi;
      if (detail.version_id !== undefined) context.version_id = detail.version_id;
      if (detail.published_at) context.published_at = detail.published_at;
    }
    envelope.protocol = context;
  }
  if (detail) {
    // before_start/guidelines/warning 随信封返回（有详情缓存时）；warning 非空置 has_warning（截断不丢警示存在性，spec 6.3.2）
    if (detail.before_start) envelope.before_start = detail.before_start;
    if (detail.guidelines) envelope.guidelines = detail.guidelines;
    if (detail.warning) {
      envelope.warning = detail.warning;
      envelope.has_warning = true;
    }
    if (detail.materials_text) envelope.materials_text = detail.materials_text;
  }
  if (materialsNote) envelope.materials_note = materialsNote;
  return envelope;
}