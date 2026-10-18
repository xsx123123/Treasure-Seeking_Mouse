// index.ts：biomed 领域模块出口（design 模块 A 的组装层）。
// 导出六项：BIOMED_TOOL_DEFS / BIOMED_TOOL_NAMES / executeBiomedTool / BIOMED_TOOL_LABELS /
// extractBiomedCards / isBiomedTool，供 index.ts 单点接入（任务 4.1 五处改动）。
// 工具命名不带前缀（与 ena_search / ngdc_* 同构）；schema 辅助形态（tool/reqStr/strOpt/intOpt）
// 与 index.ts 同构复制——biomed 不得反向 import index.ts（消除循环依赖，design 模块 B）。
// 卡片 accession 规范形与二期 grounding pattern 对齐（design 2.4.3）：rsID 小写 rs、VCV 大写（含版本号）。

import { searchGenes, getGene } from './gene.ts';
import type { GeneSearchArgs, GeneGetArgs } from './gene.ts';
import { searchVariants, getVariant } from './variant.ts';
import type { VariantSearchArgs, VariantGetArgs } from './variant.ts';
import { searchClinvar, getClinvar } from './clinvar.ts';
import type { ClinvarSearchArgs, ClinvarGetArgs } from './clinvar.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

// --- schema 辅助（与 index.ts 的 tool()/reqStr()/strOpt()/intOpt() 同构） ---
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}
function reqStr(desc: string) { return { type: 'string', description: desc }; }
function strOpt(desc: string) { return { type: 'string', description: desc, nullable: true }; }
function intOpt(desc: string) { return { type: 'integer', description: desc, nullable: true }; }

const ASSEMBLY_ENUM = { type: 'string', enum: ['hg19', 'hg38'] };

export const BIOMED_TOOL_DEFS = [
  tool('gene_search', '检索基因或批量映射基因标识（MyGene 聚合库）。按基因符号、Entrez ID、Ensembl ID 或 UniProt ID 查基因条目；一次可传 1~100 个查询词（多词时逐项返回映射结果，无命中/多匹配都逐项标注）。物种必填：优先使用 intent_plan 归一化返回的二名法学名。', {
    queries: { type: 'array', items: { type: 'string' }, description: '查询词列表（1-100 项，每项一个基因符号或 ID）' },
    species: reqStr('物种，二名法学名（如 Mus musculus）或 taxid（如 10090），必填；不得默认人类'),
    scopes: { type: 'string', enum: ['symbol', 'entrezgene', 'ensembl.gene', 'uniprot.Swiss-Prot', 'alias'], description: '匹配字段，默认 symbol' },
    limit: intOpt('每个查询词最多保留的命中条数，默认 5，最大 20'),
  }, ['queries', 'species']),
  tool('gene_get', '获取基因详情（功能摘要、别名、跨库标识映射：Entrez/Ensembl/UniProt）。gene_id 接受 Entrez 数字 ID（如 7157）或 Ensembl Gene ID（如 ENSG00000123374）。', {
    gene_id: reqStr('基因 ID：Entrez 数字 ID 或 ENSG 开头的 Ensembl Gene ID'),
    species: strOpt('可选物种（学名或 taxid），传入时校验返回条目一致，不一致则标注警告'),
  }, ['gene_id']),
  tool('variant_search', '按 rsID、基因组 HGVS 或坐标区间检索人类变异聚合注释（MyVariant：dbSNP/ClinVar 聚合/gnomAD/CADD 等，来源覆盖随 assembly 不同）。assembly 必填；缺 assembly 时先向用户确认 hg19 还是 hg38。rsID 多等位候选全部返回。', {
    variant: strOpt('变异标识：rsID（如 rs58991260）或基因组 HGVS（如 chr1:g.218458480G>A）'),
    region: { type: 'object', nullable: true, description: '坐标区间（与 variant 二选一），1-based 闭区间', properties: {
      chromosome: reqStr('染色体，如 7 或 X'),
      start: intOpt('起始位置'),
      end: intOpt('结束位置') } },
    assembly: { ...ASSEMBLY_ENUM, description: '参考基因组组装，必填' },
    limit: intOpt('返回条数上限，默认 10，最大 50；rsID 精确检索时多等位候选不受此截断'),
  }, ['assembly']),
  tool('variant_get', '获取单个变异的完整聚合注释。variant_id 为基因组级别（g.）HGVS 或 rsID；不接受转录本（c.）或蛋白（p.）HGVS，也不自动转换。', {
    variant_id: reqStr('基因组 HGVS（如 chr1:g.218458480G>A）或 rsID（如 rs58991260）'),
    assembly: { ...ASSEMBLY_ENUM, description: '参考基因组组装，必填' },
  }, ['variant_id', 'assembly']),
  tool('clinvar_search', '检索 ClinVar 临床变异证据（按基因、疾病、变异或 rsID）。返回 VCV 变异汇总记录概览：临床分类、审评状态、版本与最后评估日期。临床证据需专业审阅后方可用于医学决策，本工具不提供医疗建议。', {
    term: reqStr('检索条件，如 TP53[gene]、DMD[pathogenic]、rs28934574 或疾病名'),
    limit: intOpt('返回条数，默认 10，最大 20'),
  }, ['term']),
  tool('clinvar_get', '获取 ClinVar 记录详情（含 SCV 提交者断言明细与冲突呈现）。accession 接受 VCV（变异汇总记录）或 RCV（变异-疾病关系记录），两者层级不同不可混用。', {
    accession: reqStr('VCV 或 RCV 编号，如 VCV000065533（可带版本号 .11）'),
  }, ['accession']),
];

export const BIOMED_TOOL_NAMES = ['gene_search', 'gene_get', 'variant_search', 'variant_get', 'clinvar_search', 'clinvar_get'] as const;

const BIOMED_TOOL_SET = new Set<string>(BIOMED_TOOL_NAMES);

export function isBiomedTool(name: string): boolean {
  return BIOMED_TOOL_SET.has(name);
}

export const BIOMED_TOOL_LABELS: Record<string, string> = {
  gene_search: '检索基因（MyGene）',
  gene_get: '查询基因详情（MyGene）',
  variant_search: '检索变异（MyVariant）',
  variant_get: '查询变异详情（MyVariant）',
  clinvar_search: '检索临床变异证据（ClinVar）',
  clinvar_get: '查询临床证据详情（ClinVar）',
};

/** 与 executeTool 同签名同信封的分发入口：参数校验（失败抛中文消息+格式示例，不发上游请求）
 *  → 网络调用（ClinVar 工具在适配器内先 acquireNcbi）→ 解析收窄为领域对象 → 组装信封。
 *  空命中（not_found）由各适配器以 {success:true, data:{empty:true,...}} 信封返回，不计 errors。 */
export async function executeBiomedTool(name: string, args: Record<string, Json | undefined>): Promise<Json> {
  switch (name) {
    case 'gene_search': return searchGenes(args as unknown as GeneSearchArgs);
    case 'gene_get': return getGene(args as unknown as GeneGetArgs);
    case 'variant_search': return searchVariants(args as unknown as VariantSearchArgs);
    case 'variant_get': return getVariant(args as unknown as VariantGetArgs);
    case 'clinvar_search': return searchClinvar(args as unknown as ClinvarSearchArgs);
    case 'clinvar_get': return getClinvar(args as unknown as ClinvarGetArgs);
    default: throw new Error(`未知 biomed 工具：${name}`);
  }
}

// --- 卡片投影（{tool, accession, title, summary, meta}，meta 值全字符串） ---

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** GeneEntry → 基因卡片：meta.source='gene'，双标识（存在时）+ species/taxid + url */
function geneCard(tool: string, entry: unknown): Json | null {
  const g = obj(entry);
  if (!g) return null;
  const symbol = str(g.symbol);
  if (!symbol) return null;
  const entrez = str(g.entrez_gene_id);
  const ensembl = str(g.ensembl_gene_id);
  const accession = entrez ?? ensembl ?? symbol;
  const meta: Record<string, string> = { source: 'gene' };
  if (entrez) meta.entrez_gene_id = entrez;
  if (ensembl) meta.ensembl_gene_id = ensembl;
  if (str(g.species)) meta.species = g.species as string;
  if (g.taxid !== undefined && g.taxid !== null && g.taxid !== '') meta.taxid = String(g.taxid);
  if (Array.isArray(g.uniprot_ids) && typeof g.uniprot_ids[0] === 'string') meta.uniprot_id = g.uniprot_ids[0];
  if (str(g.url)) meta.url = g.url as string;
  const name = str(g.name);
  return {
    tool,
    accession,
    title: name ? `${symbol} — ${name}` : symbol,
    summary: str(g.summary) ? (g.summary as string).slice(0, 600) : '',
    meta,
  };
}

/** VariantEntry → 变异卡片：meta.source='variant'，assembly 必带；accession 优先 rsID（小写规范形） */
function variantCard(tool: string, entry: unknown): Json | null {
  const v = obj(entry);
  if (!v) return null;
  const variantId = str(v.variant_id);
  const rsid = str(v.rsid)?.toLowerCase();
  if (!variantId && !rsid) return null;
  const meta: Record<string, string> = { source: 'variant', assembly: String(v.assembly ?? '') };
  if (rsid) {
    meta.rsid = rsid;
    meta.url = `https://www.ncbi.nlm.nih.gov/snp/${rsid}/`;
  }
  if (variantId) meta.variant_id = variantId;
  if (str(v.gene)) meta.gene = v.gene as string;
  if (v.chr !== undefined && v.chr !== null && v.chr !== '') meta.chr = String(v.chr);
  if (v.pos !== undefined && v.pos !== null && v.pos !== '') meta.pos = String(v.pos);
  if (v.ref !== undefined && v.ref !== null && v.ref !== '') meta.ref = String(v.ref);
  if (v.alt !== undefined && v.alt !== null && v.alt !== '') meta.alt = String(v.alt);
  if (str(v.cytoband)) meta.cytoband = v.cytoband as string;
  if (str(v.sources_summary)) meta.sources_summary = v.sources_summary as string;
  return {
    tool,
    accession: rsid ?? variantId,
    title: variantId && rsid ? `${variantId}（${rsid}）` : (variantId ?? rsid),
    summary: str(v.missing_note) ?? str(v.sources_summary) ?? '',
    meta,
  };
}

/** ClinVar 条目（详情 ClinVarEntry / 概览 ClinVarSummaryEntry）→ 临床卡片：
 *  meta.source='clinvar'，三类分类分列 + review_status + submitter_conflict + disclaimer；
 *  accession = VCV 大写 + 版本号（与二期 grounding pattern 的 normalize 形一致）。 */
function clinvarCard(tool: string, entry: unknown): Json | null {
  const c = obj(entry);
  if (!c) return null;
  const accession = str(c.vcv_accession);
  if (!accession) return null;
  const version = str(c.version) ?? '';
  const meta: Record<string, string> = { source: 'clinvar' };
  const parts: string[] = [];
  if (str(c.germline_classification)) { meta.germline_classification = c.germline_classification as string; parts.push(`germline：${meta.germline_classification}`); }
  if (str(c.somatic_impact)) { meta.somatic_impact = c.somatic_impact as string; parts.push(`somatic：${meta.somatic_impact}`); }
  if (str(c.oncogenicity)) { meta.oncogenicity = c.oncogenicity as string; parts.push(`oncogenicity：${meta.oncogenicity}`); }
  if (str(c.review_status)) meta.review_status = c.review_status as string;
  meta.submitter_conflict = c.submitter_conflict === true ? 'true' : 'false';
  if (str(c.disclaimer)) meta.disclaimer = c.disclaimer as string;
  let condition = str(c.condition) ?? '';
  if (!condition && Array.isArray(c.rcv_list) && c.rcv_list.length > 0) {
    const first = obj(c.rcv_list[0]);
    condition = str(first?.condition) ?? '';
  }
  if (condition) meta.condition = condition;
  if (str(c.gene)) meta.gene = c.gene as string;
  if (str(c.url)) meta.url = c.url as string;
  else {
    // 详情条目无 url 字段——从 VCV 编号构造（数字部分去前导零，与 esummary uid 同构）
    const digits = accession.replace(/^VCV0*(?=\d)/, '');
    if (/^\d+$/.test(digits)) meta.url = `https://www.ncbi.nlm.nih.gov/clinvar/variation/${digits}/`;
  }
  if (Array.isArray(c.scv_assertions)) meta.scv_count = String(c.scv_assertions.length);
  const title = str(c.title) ?? `${accession}${version}${condition ? ` — ${condition}` : ''}`;
  return {
    tool,
    accession: `${accession}${version}`,
    title,
    summary: parts.join('；').slice(0, 600),
    meta,
  };
}

/** 按工具名投影卡片（调用点：index.ts extractCards 头部单点委托）；异常一律空数组（卡片失败不影响消息） */
export function extractBiomedCards(name: string, payload: Json): Json[] {
  try {
    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== 'object') return [];
    const obj = data as Record<string, unknown>;
    const list = Array.isArray(obj.results) ? obj.results : [];
    const cards: Json[] = [];
    if (name === 'gene_search' || name === 'gene_get') {
      for (const item of list) {
        // gene_search 的 results 为 GeneQueryResult{query, matches}（批量保真分组）；gene_get 为 GeneEntry 直列
        const entries = item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).matches)
          ? (item as Record<string, unknown>).matches
          : [item];
        for (const e of entries) {
          const card = geneCard(name, e);
          if (card) cards.push(card);
        }
      }
    } else if (name === 'variant_search' || name === 'variant_get') {
      for (const item of list) {
        const card = variantCard(name, item);
        if (card) cards.push(card);
      }
    } else if (name === 'clinvar_search' || name === 'clinvar_get') {
      for (const item of list) {
        const card = clinvarCard(name, item);
        if (card) cards.push(card);
      }
    }
    return cards.slice(0, 20);
  } catch {
    return [];
  }
}