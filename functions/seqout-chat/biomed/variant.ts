// variant.ts：MyVariant 适配器（variant_search 检索 / variant_get 详情），供 biomed/index.ts 分发调用。
// 上游 API 实测要点（2026-10-18 探测固化）：
// - /query?q=rs58991260&assembly=hg19|hg38：同一 rsID 双组装返回不同坐标文档（hg19→chr1:g.218631822G>A、
//   hg38→chr1:g.218458480G>A），多等位 rsID（如 rs334=HBB 三等位）每等位一条全保留；
// - HGVS 直塞 /query 的 q 会 0 命中（`>`/`:` 破坏查询语法），`_id:"…"` 引号短语形式可用但属 Lucene
//   特定语法——HGVS 属精确标识，一律改走 /variant/{id} 端点（规范用法，实测 200）；
// - /variant/{id} 的 assembly 参数是**严格过滤器**：hg19 坐标 id + assembly=hg38 → 404；rsID 亦可作 id
//   （自动解析为指定 assembly 的文档，实测 rs58991260+assembly=hg38 → chr1:g.218458480G>A）；
// - URL 编码：`>` 必须编码为 %3E；`:` 编码为 %3A 或保留原文均返回 200（design「冒号必须保留否则 404」
//   结论已被实测推翻，实现仍按 design 取保留冒号形态，与任务 7.3⑤ 断言一致）；
// - 来源覆盖缺口按**实际响应内容**判定：CADD 在 hg38 为集合级缺失（rs334 三等位均无），但 ClinVar/
//   gnomAD exome 在 hg38 对部分变异存在（勿按 assembly 硬编码「无覆盖」）；hg19 亦可能变异级缺失；
// - /v1/metadata → build_version=20250624。
// 网络预算：超时 7000ms、retries=2（最坏 24s ≤ 25s 红线）。

import { envGet, fetchWithRetry } from '../shared.ts';
import type { Assembly, VariantEntry } from './types.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

export const MYVARIANT_BASE_URL = envGet('MYVARIANT_BASE_URL') || 'https://myvariant.info/v1';

const VARIANT_FIELDS = 'dbsnp.rsid,dbsnp.hg19,dbsnp.hg38,clinvar,cadd,gnomad_exome,symbol,cytoband,hg19,hg38';

const MYVARIANT_HEADERS: Record<string, string> = { 'User-Agent': 'ResearchTreasureMouse/1.0' };

const RSID_PATTERN = /^rs\d+$/;
const HGVS_PATTERN = /^chr(1?\d|2[0-2]|X|Y|M|MT):g\./i;
const CHROM_PATTERN = /^(1?\d|2[0-2]|X|Y|M|MT)$/i;
/** c./p. HGVS 拒绝（spec 5.3.1 规则 3）。design 正则 /(^|[\s,;])(c|p)\./ 漏掉最常见的转录本限定形态
 *  「NM_000546.5:c.997C>T」（c. 前是冒号），此处锚点放宽为 ^|[\s,;:] 并要求点后紧跟字母数字，防误伤。 */
const CP_HGVS_PATTERN = /(^|[\s,;:])(c|p)\.[A-Za-z0-9]/;
const MAX_REGION_SPAN = 5_000_000;

// --- build_version 惰性缓存：TTL 24h、单键；失败不缓存、返回 'unknown'（不拼造） ---
const metaCache = new Map<string, { expires: number; version: string }>();

async function myvariantBuildVersion(): Promise<string> {
  const hit = metaCache.get('myvariant');
  if (hit && hit.expires > Date.now()) return hit.version;
  try {
    const meta = await fetchWithRetry(variantUrl('/metadata'), 7000, 2, MYVARIANT_HEADERS);
    const version = (meta as Record<string, unknown>).build_version;
    if (typeof version === 'string' && version) {
      metaCache.set('myvariant', { expires: Date.now() + 24 * 3600 * 1000, version });
      return version;
    }
  } catch { /* 失败置 unknown，不缓存——下次调用重试 */ }
  return 'unknown';
}

function variantUrl(path: string, params?: Record<string, string>): string {
  const usp = new URLSearchParams(params ?? {});
  const email = envGet('NCBI_EMAIL');
  if (email) usp.set('email', email);
  const qs = usp.toString();
  return `${MYVARIANT_BASE_URL}${path}${qs ? `?${qs}` : ''}`;
}

function mapUpstreamError(err: unknown): Error {
  const cause = err instanceof Error ? err.message : String(err);
  if (err instanceof SyntaxError || /Unexpected token|is not valid JSON/i.test(cause)) {
    return new Error(`上游返回了非预期的响应格式，已按服务异常处理（MyVariant：${cause.slice(0, 80)}）`);
  }
  return new Error(`变异注释服务暂时不可用（MyVariant 上游异常：${cause}），可稍后重试；本轮其余检索不受影响`);
}

/** assembly 必填（spec 5.3.1 规则 2：缺组装先反问，禁止默认或偷偷换算） */
export function requireAssembly(raw: unknown): Assembly {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v !== 'hg19' && v !== 'hg38') {
    throw new Error('参考基因组组装（assembly）必填且只能为 hg19（GRCh37）或 hg38（GRCh38）。会话无组装上下文时请先向用户确认并解释二者差异，不要默认取值或跨组装换算坐标。');
  }
  return v;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** 非空对象守卫：ClinVar/CADD/gnomAD 上游对无覆盖来源返回 {} 空对象，视为「无该来源数据」 */
function nonEmptyObj(value: unknown): Record<string, unknown> | undefined {
  const o = obj(value);
  return o && Object.keys(o).length > 0 ? o : undefined;
}

/** HGVS 形态 _id → 坐标分量（chr1:g.218458480G>A → {chr:'1', pos:'218458480', ref:'G', alt:'A'}）；
 *  indel 等复杂形态只取 chr/pos，ref/alt 缺省不猜。 */
function parseHgvsId(id: string): { chr?: string; pos?: string; ref?: string; alt?: string } {
  const m = /^chr([^:]+):g\.(\d+)(?:([A-Za-z]+)>([A-Za-z]+))?$/i.exec(id);
  if (m) return { chr: m[1].toUpperCase(), pos: m[2], ref: m[3]?.toUpperCase(), alt: m[4]?.toUpperCase() };
  return {};
}

/** 上游命中文档 → VariantEntry（类型守卫收窄，禁 any）；缺 _id 的畸形行返回 null */
function toVariantEntry(hit: Record<string, unknown>, assembly: Assembly): VariantEntry | null {
  const variantId = typeof hit._id === 'string' ? hit._id : '';
  if (!variantId) return null;
  const parsed = parseHgvsId(variantId);
  const dbsnp = nonEmptyObj(hit.dbsnp);
  const rsid = typeof dbsnp?.rsid === 'string' ? dbsnp.rsid : undefined;
  const clinvar = nonEmptyObj(hit.clinvar);
  const cadd = nonEmptyObj(hit.cadd);
  const gnomad = nonEmptyObj(hit.gnomad_exome);
  // 坐标兜底链：_id 解析 → assembly 坐标对象 → cadd.chrom/pos（cadd 仅 hg19 有覆盖，不跨组装补值）
  const coords = obj(hit[assembly]);
  const posFallback = typeof coords?.start === 'number' ? String(coords.start) : undefined;
  const entry: VariantEntry = {
    variant_id: variantId,
    assembly,
    sources_summary: `dbSNP ${dbsnp ? '✓' : '✗'} / ClinVar 聚合 ${clinvar ? '✓' : '✗'} / gnomAD exome ${gnomad ? '✓' : '✗'} / CADD ${cadd ? '✓' : '✗'}`,
  };
  if (rsid) entry.rsid = rsid;
  if (typeof hit.symbol === 'string' && hit.symbol) entry.gene = hit.symbol;
  if (parsed.chr) entry.chr = parsed.chr;
  else if (typeof cadd?.chrom !== 'undefined') entry.chr = String(cadd.chrom).toUpperCase();
  entry.pos = parsed.pos ?? posFallback ?? (typeof cadd?.pos === 'number' ? String(cadd.pos) : undefined);
  if (parsed.ref) entry.ref = parsed.ref;
  if (parsed.alt) entry.alt = parsed.alt;
  if (typeof hit.cytoband === 'string' && hit.cytoband) entry.cytoband = hit.cytoband;
  if (clinvar) entry.clinvar = clinvar;

  const missing: string[] = [];
  if (!dbsnp) missing.push('无 dbSNP rsID（可能为 novel 或未提交变异）');
  if (!clinvar) missing.push('ClinVar 聚合无该变异记录');
  if (!gnomad) missing.push('gnomAD exome 无该变异频率数据');
  if (!cadd) missing.push(assembly === 'hg38' ? 'CADD 在 hg38 集合暂无覆盖（集合级缺口，非该变异特有）' : 'CADD 未覆盖该变异');
  if (missing.length) entry.missing_note = missing.join('；');
  return entry;
}

/** HGVS URL 编码（实测固化）：`>` 编码为 %3E；`:` 保留原文（编码为 %3A 实测亦可，取 design 约定形态） */
function encodeVariantId(id: string): string {
  return encodeURIComponent(id).replace(/%3A/g, ':');
}

export interface VariantSearchArgs {
  variant?: unknown;
  region?: unknown;
  assembly: unknown;
  limit?: unknown;
}

/** variant_search：rsID 走 /query（多等位全保留，size 钳至 ≥20）；HGVS 走 /variant/{id} 精确查
 *  （直塞 /query 会 0 命中，实测）；region 走 /query 区间语法。variant 与 region 服务端二选一。 */
export async function searchVariants(args: VariantSearchArgs): Promise<Json> {
  const assembly = requireAssembly(args.assembly);
  const hasVariant = args.variant !== undefined && args.variant !== null && args.variant !== '';
  const hasRegion = args.region !== undefined && args.region !== null && args.region !== '';
  if (hasVariant && hasRegion) {
    throw new Error('variant 与 region 参数只能二选一：variant 用于按变异标识（rsID/基因组 HGVS）检索，region 用于按坐标区间检索。');
  }
  if (!hasVariant && !hasRegion) {
    throw new Error('缺少检索条件：必须提供 variant（rsID（如 rs58991260）或基因组 HGVS（如 chr1:g.218458480G>A））或 region（坐标区间）之一。');
  }
  const limit = clampInt(args.limit, 10, 1, 50);

  let entries: VariantEntry[] = [];
  if (hasVariant) {
    const variant = String(args.variant).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (CP_HGVS_PATTERN.test(variant)) {
      throw new Error('当前不支持转录本（c.）或蛋白（p.）HGVS 自动转换，请提供 rsID 或基因组级别（g.）HGVS（如 chr1:g.218458480G>A），不得返回编造坐标。');
    }
    if (RSID_PATTERN.test(variant)) {
      // rsID 精确检索：size 钳至 ≥20 保证多等位候选全保留（spec 5.3.1 规则 5）
      const size = Math.max(20, limit);
      let resp: Json;
      try {
        resp = await fetchWithRetry(variantUrl('/query', { q: variant, assembly, fields: VARIANT_FIELDS, size: String(size) }), 7000, 2, MYVARIANT_HEADERS);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        if (/HTTP 400|HTTP 422/.test(cause)) {
          throw new Error(`变异标识「${variant.slice(0, 50)}」不被 MyVariant 识别（上游报错：${cause}）。请检查 rsID 格式（rs + 数字）。`);
        }
        throw mapUpstreamError(err);
      }
      const hits = (resp as Record<string, unknown>).hits;
      entries = (Array.isArray(hits) ? hits : []).slice(0, Math.max(size, limit))
        .map((h) => (h && typeof h === 'object' && !Array.isArray(h) ? toVariantEntry(h as Record<string, unknown>, assembly) : null))
        .filter((e): e is VariantEntry => e !== null);
      if (entries.length === 0) {
        return emptyVariantEnvelope(assembly, `rsID「${variant}」在 ${assembly} 集合无记录。可能该 rsID 尚未映射到此组装版本，可尝试另一 assembly，或用 ClinVar 工具按 rsID 检索临床证据。`);
      }
    } else if (HGVS_PATTERN.test(variant)) {
      return await fetchVariantDetail(variant, assembly);
    } else {
      throw new Error(`变异标识格式不正确：${variant.slice(0, 50)}。应为 rsID（rs + 数字，如 rs58991260）或基因组级别 HGVS（如 chr1:g.218458480G>A）；转录本（c.）与蛋白（p.）HGVS 不受支持。`);
    }
  } else {
    // region 坐标区间检索
    const region = obj(args.region);
    if (!region) throw new Error('region 参数格式不正确：应为对象 { chromosome, start, end }，如 {"chromosome": "7", "start": 140453100, "end": 140453200}。');
    const chromosome = String(region.chromosome ?? '').trim();
    if (!CHROM_PATTERN.test(chromosome)) {
      throw new Error(`染色体格式不正确：${chromosome || '(空)'}。应为 1-22、X、Y、M 或 MT。`);
    }
    const start = clampInt(region.start, NaN, 1, Number.MAX_SAFE_INTEGER);
    const end = clampInt(region.end, NaN, 1, Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error('region.start 与 region.end 必须为正整数（1-based 闭区间）。');
    }
    if (start > end) throw new Error(`region 区间不合法：start（${start}）大于 end（${end}）。`);
    if (end - start + 1 > MAX_REGION_SPAN) {
      throw new Error(`region 区间过宽（${(end - start + 1).toLocaleString()} bp，上限 5,000,000 bp）。请缩小范围后重试，防止全染色体扫描。`);
    }
    let resp: Json;
    try {
      resp = await fetchWithRetry(variantUrl('/query', { q: `chr${chromosome.toUpperCase()}:${start}-${end}`, assembly, fields: VARIANT_FIELDS, size: String(limit) }), 7000, 2, MYVARIANT_HEADERS);
    } catch (err) {
      throw mapUpstreamError(err);
    }
    const hits = (resp as Record<string, unknown>).hits;
    entries = (Array.isArray(hits) ? hits : []).slice(0, limit)
      .map((h) => (h && typeof h === 'object' && !Array.isArray(h) ? toVariantEntry(h as Record<string, unknown>, assembly) : null))
      .filter((e): e is VariantEntry => e !== null);
    if (entries.length === 0) {
      return emptyVariantEnvelope(assembly, `区间 chr${chromosome.toUpperCase()}:${start}-${end}（${assembly}）在 MyVariant 无变异记录。可尝试扩大区间或检查坐标与组装版本是否匹配。`);
    }
  }
  return variantEnvelope(entries, assembly);
}

export interface VariantGetArgs {
  variant_id: unknown;
  assembly: unknown;
}

/** variant_get：单变异完整聚合注释（含 ClinVar 聚合子对象原样透传）。variant_id 接受 rsID 或
 *  基因组 HGVS（rsID 亦可作 /variant/{id} 的 id，上游自动解析到指定 assembly，实测确认）。 */
export async function getVariant(args: VariantGetArgs): Promise<Json> {
  const assembly = requireAssembly(args.assembly);
  const id = String(args.variant_id ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (CP_HGVS_PATTERN.test(id)) {
    throw new Error('当前不支持转录本（c.）或蛋白（p.）HGVS 自动转换，请提供 rsID 或基因组级别（g.）HGVS（如 chr1:g.218458480G>A），不得返回编造坐标。');
  }
  if (!RSID_PATTERN.test(id) && !HGVS_PATTERN.test(id)) {
    throw new Error(`变异标识格式不正确：${id || '(空)'}。应为 rsID（rs + 数字，如 rs58991260）或基因组级别 HGVS（如 chr1:g.218458480G>A）。`);
  }
  return await fetchVariantDetail(id, assembly);
}

/** /variant/{id} 精确查询（HGVS 或 rsID）：404 → not_found 信封（含组装偏移提示，绝不算工具失败） */
async function fetchVariantDetail(id: string, assembly: Assembly): Promise<Json> {
  let doc: Json;
  try {
    doc = await fetchWithRetry(variantUrl(`/variant/${encodeVariantId(id)}`, { assembly, fields: VARIANT_FIELDS }), 7000, 2, MYVARIANT_HEADERS);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    if (/HTTP 404/.test(cause)) {
      return emptyVariantEnvelope(assembly,
        `变异「${id}」在 ${assembly} 集合不存在。同一变异在 hg19 与 hg38 的坐标不同（存在偏移），请确认标识对应的组装版本；也可改用 rsID 由上游自动解析，或先用 variant_search 按 rsID 检索。`);
    }
    if (/HTTP 400|HTTP 422/.test(cause)) {
      throw new Error(`变异标识「${id.slice(0, 50)}」不被 MyVariant 识别（上游报错：${cause}）。请检查 HGVS 语法（如 chr1:g.218458480G>A）或 rsID 格式。`);
    }
    throw mapUpstreamError(err);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw mapUpstreamError(new SyntaxError('响应不是 JSON 对象'));
  const entry = toVariantEntry(doc as Record<string, unknown>, assembly);
  if (!entry) throw mapUpstreamError(new SyntaxError('响应缺少 _id 字段'));
  return variantEnvelope([entry], assembly);
}

async function variantEnvelope(entries: VariantEntry[], assembly: Assembly): Promise<Json> {
  return {
    success: true,
    data: {
      results: entries,
      total: entries.length,
      source: 'myvariant',
      build_version: await myvariantBuildVersion(),
      assembly,
    },
  };
}

async function emptyVariantEnvelope(assembly: Assembly, note: string): Promise<Json> {
  return {
    success: true,
    data: {
      results: [],
      total: 0,
      source: 'myvariant',
      build_version: await myvariantBuildVersion(),
      assembly,
      empty: true,
      not_found: true,
      note,
    },
  };
}