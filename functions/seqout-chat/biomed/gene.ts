// gene.ts：MyGene 适配器（gene_search 检索+批量映射 / gene_get 详情），供 biomed/index.ts 分发调用。
// 上游 API 实测要点（2026-10-18 探测固化，样本存 /tmp/biomed-probe/）：
// - GET /v3/query?q=<词> 为模糊检索，返回 {total, hits:[...]}（CDK2 → 16 候选，含 CACUL1/CDK2AP1 等模糊命中）；
// - POST /v3/query（表单 q=词1,词2&scopes=...）为批量精确映射，返回**扁平数组**：命中项为
//   {query, _id, _score, ...投影字段}（同一 query 多命中时重复多条），未命中项为 {query, notfound:true}
//   ——不存在 {query, hits:[...]} 包裹形态（design 初稿假设已按实测修正），解析按 query 字段分组；
// - 字段限定查询（symbol:CDK2 / ensembl.gene:ENSG… / uniprot.Swiss-Prot:P24941）GET 可用，
//   供 scopes≠symbol 的单词检索走精确语义；
// - entrezgene 实测为字符串；HGNC 为数值（1771）；genomic_pos 无 assembly 字段时如实缺省不补造；
// - /v3/gene/{id} 对不存在 ID 返回 404 + {"success":false,"error":"Not Found."}。
// 网络预算：超时 7000ms、retries=2（最坏 24s ≤ 25s 红线）；User-Agent 必须 ASCII。

import { envGet, fetchWithRetry } from '../shared.ts';
import type { GeneEntry, GeneGenomicPos, GeneQueryResult } from './types.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

export const MYGENE_BASE_URL = envGet('MYGENE_BASE_URL') || 'https://mygene.info/v3';

/** 固定投影：不依赖上游默认值（spec 6.2 全字段） */
const GENE_SEARCH_FIELDS = 'symbol,name,taxid,entrezgene,ensembl.gene,uniprot.Swiss-Prot,alias';
const GENE_DETAIL_FIELDS = `${GENE_SEARCH_FIELDS},summary,genomic_pos,MGI,HGNC`;

const MYGENE_HEADERS: Record<string, string> = { 'User-Agent': 'ResearchTreasureMouse/1.0' };

const GENE_SCOPES = new Set(['symbol', 'entrezgene', 'ensembl.gene', 'uniprot.Swiss-Prot', 'alias']);

/** NCBI 分类学稳定的 taxid→二名法学名映射（常见模式生物；未知 taxid 不补造，species 留空）。
 *  实测 MyGene /query 只接受常用名（human/mouse…）与 taxid，二名法学名（Homo sapiens）一律 400
 *  "cannot map some species to taxids"——intent_plan 归一化产物恰是二名法，故须本地翻译后再上行。 */
const TAXID_TO_BINOMIAL: Record<string, string> = {
  '9606': 'Homo sapiens', '10090': 'Mus musculus', '10116': 'Rattus norvegicus',
  '7955': 'Danio rerio', '7227': 'Drosophila melanogaster', '6239': 'Caenorhabditis elegans',
  '4932': 'Saccharomyces cerevisiae', '4896': 'Schizosaccharomyces pombe',
  '3702': 'Arabidopsis thaliana', '9031': 'Gallus gallus', '9615': 'Canis lupus familiaris',
  '9823': 'Sus scrofa', '9913': 'Bos taurus', '9598': 'Pan troglodytes',
  '9544': 'Macaca mulatta', '10029': 'Cricetulus griseus', '8364': 'Xenopus tropicalis',
  '8355': 'Xenopus laevis', '9986': 'Oryctolagus cuniculus', '10141': 'Cavia porcellus',
  '9940': 'Ovis aries', '9685': 'Felis catus', '9796': 'Equus caballus', '9593': 'Gorilla gorilla',
  '13616': 'Monodelphis domestica', '4530': 'Oryza sativa', '4577': 'Zea mays',
  '4081': 'Solanum lycopersicum', '3847': 'Glycine max', '5141': 'Neurospora crassa',
  '7165': 'Anopheles gambiae', '44689': 'Dictyostelium discoideum',
};

const BINOMIAL_TO_TAXID: Record<string, string> = {};
for (const [taxid, binomial] of Object.entries(TAXID_TO_BINOMIAL)) BINOMIAL_TO_TAXID[binomial.toLowerCase()] = taxid;

/** 物种参数上行翻译：taxid 原样；二名法学名（大小写不敏感）→ taxid；其余（human/mouse 等常用名）原样透传 */
function resolveSpeciesForUpstream(species: string): string {
  if (/^\d+$/.test(species)) return species;
  return BINOMIAL_TO_TAXID[species.toLowerCase()] ?? species;
}

// --- build_version 惰性缓存：TTL 24h、单键（模块内单库）；失败不缓存、返回 'unknown'（不拼造） ---
const metaCache = new Map<string, { expires: number; version: string }>();

async function mygeneBuildVersion(): Promise<string> {
  const hit = metaCache.get('mygene');
  if (hit && hit.expires > Date.now()) return hit.version;
  try {
    const meta = await fetchWithRetry(geneUrl('/metadata'), 7000, 2, MYGENE_HEADERS);
    const version = (meta as Record<string, unknown>).build_version;
    if (typeof version === 'string' && version) {
      metaCache.set('mygene', { expires: Date.now() + 24 * 3600 * 1000, version });
      return version;
    }
  } catch { /* 失败置 unknown，不缓存——下次调用重试 */ }
  return 'unknown';
}

function geneUrl(path: string, params?: Record<string, string>): string {
  const usp = new URLSearchParams(params ?? {});
  const email = envGet('NCBI_EMAIL');
  if (email) usp.set('email', email); // MyGene 官方建议的联系方式（非密钥）
  const qs = usp.toString();
  return `${MYGENE_BASE_URL}${path}${qs ? `?${qs}` : ''}`;
}

/** 上游错误统一映射（spec 4.2.2 红线：绝不表述为「未找到记录」；上游故障是可重试的链路失败） */
function mapUpstreamError(err: unknown): Error {
  const cause = err instanceof Error ? err.message : String(err);
  if (err instanceof SyntaxError || /Unexpected token|is not valid JSON/i.test(cause)) {
    return new Error(`上游返回了非预期的响应格式，已按服务异常处理（MyGene：${cause.slice(0, 80)}）`);
  }
  return new Error(`基因注释服务暂时不可用（MyGene 上游异常：${cause}），可稍后重试；本轮其余检索不受影响`);
}

/** 查询词清洗（格式层，validateSearchQuery 同模式）：控制字符归一、折叠空白；
 *  拒绝空/超长/含逗号或冒号/纯符号——逗号破坏批量 q 的分隔语义，冒号与字段限定语法冲突。 */
export function cleanGeneTerm(raw: unknown): string {
  const cleaned = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    throw new Error('基因查询词为空或只含控制字符。请给出基因符号（如 TP53）、Entrez ID（如 7157）或 Ensembl ID（如 ENSG00000141510）后重试。');
  }
  if (cleaned.length > 100) {
    throw new Error(`基因查询词过长（${cleaned.length} 字符，上限 100）。每项应为单个基因符号或 ID。`);
  }
  if (/[,:]/.test(cleaned)) {
    throw new Error(`基因查询词「${cleaned.slice(0, 50)}」包含逗号或冒号。每个查询词必须是单个基因符号或 ID，不要在词内使用分隔符。`);
  }
  if (!/[\p{L}\p{N}]/u.test(cleaned)) {
    throw new Error(`基因查询词「${cleaned.slice(0, 50)}」不含任何字母或数字，无法检索。`);
  }
  return cleaned;
}

/** species 必填（spec 5.2.1 规则 1 的服务端兜底：无物种上下文时引导反问，禁止默认人类） */
export function requireSpecies(raw: unknown): string {
  const species = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!species) {
    throw new Error('基因检索必须指定物种（如 Homo sapiens 或 9606）；会话无物种上下文时请先向用户确认，不得默认人类。');
  }
  if (species.length > 100) {
    throw new Error(`物种参数过长（${species.length} 字符，上限 100）。应为二名法学名（如 Mus musculus）或 taxid（如 10090）。`);
  }
  return species;
}

function normalizeScopes(raw: unknown): string {
  const scopes = raw === undefined || raw === null || raw === '' ? 'symbol' : String(raw).trim();
  if (!GENE_SCOPES.has(scopes)) {
    throw new Error(`匹配字段不正确：${scopes}（应为 symbol / entrezgene / ensembl.gene / uniprot.Swiss-Prot / alias 之一，默认 symbol）`);
  }
  return scopes;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseGenomicPos(raw: unknown): GeneGenomicPos | undefined {
  // 上游极少数基因返回数组（多位点），取首个主位点；无 assembly 字段时如实缺省
  const item = Array.isArray(raw) ? raw[0] : raw;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const gp = item as Record<string, unknown>;
  if (typeof gp.chr !== 'string' || typeof gp.start !== 'number' || typeof gp.end !== 'number') return undefined;
  return {
    chr: gp.chr,
    start: gp.start,
    end: gp.end,
    assembly: typeof gp.assembly === 'string' ? gp.assembly : undefined,
    strand: typeof gp.strand === 'number' ? gp.strand : undefined,
  };
}

function parseStringArray(raw: unknown): string[] | undefined {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '') : [];
  return list.length ? list : undefined;
}

/** MyGene 原始条目 → GeneEntry（类型守卫收窄，禁 any）；缺 _id/symbol 的畸形行返回 null（防御性丢弃） */
function toGeneEntry(hit: Record<string, unknown>, detail: boolean): GeneEntry | null {
  const id = typeof hit._id === 'string' ? hit._id : typeof hit._id === 'number' ? String(hit._id) : '';
  const symbol = typeof hit.symbol === 'string' ? hit.symbol : '';
  if (!id || !symbol) return null;
  const taxid = hit.taxid === undefined || hit.taxid === null ? '' : String(hit.taxid);
  const ensemblRaw = hit.ensembl && typeof hit.ensembl === 'object' && !Array.isArray(hit.ensembl)
    ? (hit.ensembl as Record<string, unknown>).gene : undefined;
  const uniprotRaw = hit.uniprot && typeof hit.uniprot === 'object' && !Array.isArray(hit.uniprot)
    ? (hit.uniprot as Record<string, unknown>)['Swiss-Prot'] : undefined;
  const entry: GeneEntry = {
    symbol,
    taxid,
    species: TAXID_TO_BINOMIAL[taxid],
    entrez_gene_id: hit.entrezgene === undefined || hit.entrezgene === null ? id : String(hit.entrezgene),
    ensembl_gene_id: typeof ensemblRaw === 'string' && ensemblRaw ? ensemblRaw
      : Array.isArray(ensemblRaw) ? (ensemblRaw.find((v): v is string => typeof v === 'string' && v !== '') ?? undefined) : undefined,
    uniprot_ids: parseStringArray(uniprotRaw),
    aliases: parseStringArray(hit.alias),
    url: `${MYGENE_BASE_URL}/gene/${id}`,
  };
  if (typeof hit.name === 'string' && hit.name) entry.name = hit.name;
  if (detail) {
    if (typeof hit.summary === 'string' && hit.summary) entry.summary = hit.summary;
    const gp = parseGenomicPos(hit.genomic_pos);
    if (gp) entry.genomic_pos = gp;
    if (hit.HGNC !== undefined && hit.HGNC !== null) entry.hgnc_id = String(hit.HGNC);
    if (hit.MGI !== undefined && hit.MGI !== null) entry.mgi_id = String(hit.MGI);
  }
  return entry;
}

export interface GeneSearchArgs {
  queries: unknown;
  species: unknown;
  scopes?: unknown;
  limit?: unknown;
}

/** gene_search：单词走 GET 模糊检索（发现语义，多候选全保留）；多词（2~100）走 POST 批量精确映射。
 *  批量保真（spec 5.2.1 规则 4）：输出项数与输入项数一致，未命中逐项标注 not_found。 */
export async function searchGenes(args: GeneSearchArgs): Promise<Json> {
  if (!Array.isArray(args.queries) || args.queries.length === 0) {
    throw new Error('queries 参数缺失或为空。请传入 1~100 个基因查询词的数组，如 ["CDK2", "TP53"]。');
  }
  if (args.queries.length > 100) {
    throw new Error(`查询词数量超限（${args.queries.length} 项，上限 100）。请分批检索。`);
  }
  const queries = args.queries.map((t) => cleanGeneTerm(t));
  const species = requireSpecies(args.species);
  const upstreamSpecies = resolveSpeciesForUpstream(species);
  const scopes = normalizeScopes(args.scopes);
  const limit = clampInt(args.limit, 5, 1, 20);

  let results: GeneQueryResult[];
  try {
    if (queries.length === 1) {
      // 单词：scopes=symbol 走模糊检索（发现语义）；scopes≠symbol 用字段限定查询走精确语义（实测可用）
      const q = scopes === 'symbol' ? queries[0] : `${scopes}:${queries[0]}`;
      const resp = await fetchWithRetry(geneUrl('/query', { q, species: upstreamSpecies, fields: GENE_SEARCH_FIELDS, size: String(limit) }), 7000, 2, MYGENE_HEADERS);
      const hits = (resp as Record<string, unknown>).hits;
      const matches = (Array.isArray(hits) ? hits : []).slice(0, limit)
        .map((h) => (h && typeof h === 'object' && !Array.isArray(h) ? toGeneEntry(h as Record<string, unknown>, false) : null))
        .filter((g): g is GeneEntry => g !== null);
      results = [{ query: queries[0], not_found: matches.length === 0, matches }];
    } else {
      // 多词：POST 表单批量映射；上游按 query 字段分组的扁平数组（实测形态），防御性兼容 hits 包裹形态
      const body = new URLSearchParams({ q: queries.join(','), scopes, species: upstreamSpecies, fields: GENE_SEARCH_FIELDS, size: String(limit) }).toString();
      const email = envGet('NCBI_EMAIL');

      const resp = await fetchWithRetry(geneUrl('/query'), 7000, 2,
        { ...MYGENE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        { method: 'POST', body: email ? `${body}&email=${encodeURIComponent(email)}` : body });
      const flat: { query: string; hit: Record<string, unknown> }[] = [];
      if (Array.isArray(resp)) {
        for (const item of resp) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const row = item as Record<string, unknown>;
          const queryKey = typeof row.query === 'string' ? row.query : '';
          if (row.notfound === true) continue;
          if (Array.isArray(row.hits)) {
            for (const h of row.hits) {
              if (h && typeof h === 'object' && !Array.isArray(h) && queryKey) flat.push({ query: queryKey, hit: h as Record<string, unknown> });
            }
          } else if (queryKey) {
            flat.push({ query: queryKey, hit: row });
          }
        }
      }
      const grouped = new Map<string, GeneEntry[]>();
      for (const { query, hit } of flat) {
        const entry = toGeneEntry(hit, false);
        if (!entry) continue;
        const bucket = grouped.get(query) ?? [];
        bucket.push(entry);
        grouped.set(query, bucket);
      }
      results = queries.map((query) => {
        const matches = (grouped.get(query) ?? []).slice(0, limit);
        return { query, not_found: matches.length === 0, matches };
      });
    }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    // 400/422 是「参数不被上游识别」（实测唯一自由形态来源是 species），属使用者可修正的错误，
    // 绝不能表述为「未找到记录」或「服务不可用」（spec 4.2.2 红线）
    if (/HTTP 400|HTTP 422/.test(cause)) {
      throw new Error(`物种「${species}」不被 MyGene 识别（上游报错：${cause}）。请改用 taxid（如 9606 / 10090）或英文常用名（如 human、mouse）后重试。`);
    }
    throw mapUpstreamError(err);
  }

  const totalMatches = results.reduce((n, r) => n + r.matches.length, 0);
  const data: Record<string, unknown> = {
    results,
    total: totalMatches,
    source: 'mygene',
    build_version: await mygeneBuildVersion(),
  };
  if (totalMatches === 0) {
    data.empty = true;
    data.not_found = true;
    data.note = `MyGene 在物种「${species}」下未命中任何查询词。请检查拼写、换用基因别名或历史符号，或确认物种是否正确（二名法学名或 taxid，如 Homo sapiens / 9606）。`;
  } else if (results.some((r) => r.matches.length > 1)) {
    data.note = '一个或多个查询词命中多个候选基因（可能来自别名、历史符号或同物种种间同源），已全部并列返回；请向用户呈现候选列表并确认目标基因，不要静默取第一条。';
  }
  return { success: true, data };
}

export interface GeneGetArgs {
  gene_id: unknown;
  species?: unknown;
}

/** gene_get：基因详情（功能摘要/别名/跨库标识/聚合坐标）。404 → not_found 信封（附修正建议）。 */
export async function getGene(args: GeneGetArgs): Promise<Json> {
  const id = String(args.gene_id ?? '').trim();
  if (!/^(\d+|[ENSG]\w{10,})$/.test(id)) {
    throw new Error(`基因 ID 格式不正确：${id || '(空)'}。应为 Entrez 数字 ID（如 7157）或 Ensembl Gene ID（如 ENSG00000141510，含其他物种的 ENSMUSG 等形态）。`);
  }

  let doc: Json;
  try {
    doc = await fetchWithRetry(geneUrl(`/gene/${encodeURIComponent(id)}`, { fields: GENE_DETAIL_FIELDS }), 7000, 2, MYGENE_HEADERS);
  } catch (err) {
    if (err instanceof Error && /HTTP 404/.test(err.message)) {
      return {
        success: true,
        data: {
          results: [], total: 0, source: 'mygene', build_version: await mygeneBuildVersion(),
          empty: true, not_found: true,
          note: `MyGene 未收录基因 ID「${id}」。请检查 ID 拼写是否正确，或先用 gene_search 按基因符号解析出正确的 Entrez/Ensembl ID。`,
        },
      };
    }
    throw mapUpstreamError(err);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw mapUpstreamError(new SyntaxError('响应不是 JSON 对象'));

  const entry = toGeneEntry(doc as Record<string, unknown>, true);
  if (!entry) throw mapUpstreamError(new SyntaxError('响应缺少 _id/symbol 字段'));

  const notes: string[] = [];
  if (args.species !== undefined && args.species !== null && args.species !== '') {
    const expected = String(args.species).trim();
    const argTaxid = /^\d+$/.test(expected) ? expected
      : Object.entries(TAXID_TO_BINOMIAL).find(([, name]) => name.toLowerCase() === expected.toLowerCase())?.[0];
    // 仅当传入物种可解析为 taxid 时才比对；无法判定时不打警告（不猜）
    if (argTaxid && entry.taxid && argTaxid !== entry.taxid) {
      notes.push(`传入物种与条目不匹配（期望 ${TAXID_TO_BINOMIAL[argTaxid] ?? argTaxid}（taxid ${argTaxid}），实际 ${entry.species ?? 'taxid ' + entry.taxid}），请确认目标基因是否正确`);
    }
  }
  if (entry.genomic_pos) {
    notes.push('该坐标来自 MyGene 聚合，非所有物种的最新参考坐标；跨库做变异区间检索时请先确认参考组装版本');
  }

  const data: Record<string, unknown> = {
    results: [entry],
    total: 1,
    source: 'mygene',
    build_version: await mygeneBuildVersion(),
  };
  if (notes.length) data.note = notes.join('；');
  return { success: true, data };
}