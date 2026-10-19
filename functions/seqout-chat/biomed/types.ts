// types.ts：biomed 领域对象类型定义（全具名 interface，禁止 any）。
// 三条类型级红线（spec 6.2~6.4 数据约束的类型级落地）：
// 1. ClinVar 三类断言（germline/somatic/oncogenicity）为独立可空字段 + scv_assertions 分组标记，
//    结构上不可合并为单一布尔或单一总分；
// 2. ClinVarEntry.disclaimer 必填（证据性质限定语，spec 6.4.9）；
// 3. VariantEntry.assembly 为 'hg19'|'hg38' 字面量联合，唯一性键 = variant_id + assembly，
//    坐标字段缺失如实留空，禁止跨 assembly 补值。

export type Assembly = 'hg19' | 'hg38';

export interface GeneGenomicPos {
  chr: string;
  start: number;
  end: number;
  /** MyGene 聚合坐标的 assembly 标注（可能缺失）；该坐标非所有物种的最新参考坐标 */
  assembly?: string;
  strand?: number;
}

export interface GeneEntry {
  symbol: string;
  name?: string;
  taxid: string;
  species?: string;
  /** MyGene 的 entrezgene 实测可能返回字符串（CygnusX 调查结论），统一字符串类型 */
  entrez_gene_id?: string;
  ensembl_gene_id?: string;
  uniprot_ids?: string[];
  /** 基因别名（检索投影含 alias，详情工具描述明确承诺别名输出） */
  aliases?: string[];
  /** HGNC 数字标识（人类基因详情级，存在时保留；上游为数值，统一转字符串） */
  hgnc_id?: string;
  /** MGI 标识（小鼠基因详情级，存在时保留，如 MGI:95495） */
  mgi_id?: string;
  summary?: string;
  genomic_pos?: GeneGenomicPos;
  url: string;
}

/** 批量映射逐项保真载体：输出项数与输入项数一致（spec 5.2.1 规则 4） */
export interface GeneQueryResult {
  query: string;
  not_found: boolean;
  matches: GeneEntry[];
}

export interface VariantEntry {
  variant_id: string;
  rsid?: string;
  assembly: Assembly;
  gene?: string;
  chr?: string;
  pos?: string;
  ref?: string;
  alt?: string;
  /** 细胞遗传学条带（如 11p15.4），投影含 cytoband，存在时保留 */
  cytoband?: string;
  sources_summary: string;
  missing_note?: string;
  /** variant_get 详情级：ClinVar 聚合子对象原样透传（分类/冲突/版本），服务端不二次解读临床结论 */
  clinvar?: Record<string, unknown>;
}

export interface ClinVarRcvItem {
  rcv_accession: string;
  condition: string;
  classification?: string;
}

export type ClinVarAssertionType = 'germline' | 'somatic' | 'oncogenic';

export interface ClinVarScvAssertion {
  submitter: string;
  assertion_type: ClinVarAssertionType;
  classification: string;
  review_status?: string;
  date?: string;
}

export interface ClinVarEntry {
  vcv_accession: string;
  version?: string;
  title?: string;
  gene?: string;
  rcv_list: ClinVarRcvItem[];
  germline_classification?: string;
  somatic_impact?: string;
  oncogenicity?: string;
  scv_assertions: ClinVarScvAssertion[];
  /** 同类型断言分类不一致即 true，冲突各方断言并列保留（禁止单一总分掩盖） */
  submitter_conflict: boolean;
  review_status?: string;
  last_evaluated?: string;
  /** 必填：证据性质限定语（spec 6.4.9），前端灰字小号展示 */
  disclaimer: string;
}

/** 工具信封 data 结构：条目数组固定命名 results（对齐 trimForLLM 的 data.results 瘦身分支零改动复用） */
export interface BiomedEnvelope {
  results: (GeneQueryResult | VariantEntry | ClinVarEntry)[];
  total: number;
  source: 'mygene' | 'myvariant' | 'clinvar';
  build_version: string;
  assembly?: Assembly;
}

/** ClinVar 固定限定语：卡片与信封共用同一份文案（zh 服务端下发，en 前端另有翻译键） */
export const CLINVAR_DISCLAIMER = 'ClinVar 记录需由专业人士审阅后方可用于医学决策，本结果不构成诊断或用药建议';