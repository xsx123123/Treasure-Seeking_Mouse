// intent.ts：检索意图中间表示（IR）的 schema、校验与归一化。
//
// 背景：意图翻译此前 100% 委托给提示词规则，seqout_search_structured 的槽位由模型自由文本直传，
// 无中间 schema、无落盘、无校验。本模块把「用户问题 → 检索意图」落成显式 IR：
// 模型经 intent_plan 工具产出 ResearchIntent JSON，本模块负责校验与归一化（纯函数、离线可测），
// 归一化结果回灌模型作为后续工具参数的依据；校验失败由调用方识别（判别联合 ok:false）并降级为
// 现有工具直连行为，绝不猜值。

/** 意图目标库：geo=GEO 数据集，sra=SRA 测序记录，ena=ENA 欧洲核酸库，ngdc=NGDC 国内库，literature=文献 */
export const INTENT_TARGETS = ['geo', 'sra', 'ena', 'ngdc', 'literature'] as const;
export type IntentTarget = (typeof INTENT_TARGETS)[number];

export interface ResearchIntentFilters {
  /** 物种二名法学名（归一化后，如 Mus musculus） */
  organism?: string;
  /** 实验/测序类型（归一化到 library_strategy 词表，如 scRNA-Seq） */
  assay?: string;
  /** 组织或细胞类型（自由文本，原样保留） */
  tissue_or_celltype?: string;
  /** 疾病/处理条件（自由文本，原样保留） */
  condition?: string;
  /** 是否要求含对照组（仅接受真布尔） */
  has_control?: boolean;
}

export interface ResearchIntent {
  /** 用户研究问题的一句话概括 */
  question: string;
  targets: IntentTarget[];
  filters: ResearchIntentFilters;
  needs_literature: boolean;
}

/** 判别联合：ok:false 携带可读原因，调用方据此降级为无意图直连路径 */
export type ParseIntentResult =
  | { ok: true; intent: ResearchIntent; notes: string[] }
  | { ok: false; reason: string };

// ---------- organism：常见种中文/俗名 → 二名法学名 ----------

/** 二名法（允许三亚名，如 Canis lupus familiaris）学名形 */
const BINOMIAL_PATTERN = /^[A-Z][a-z]+( [a-z][a-z-]+){1,2}$/;

/** 常见种归一化映射表：key 为小写化后的中文名/俗名/学名。只收录组学检索高频种，不收长尾（宁缺勿猜） */
const ORGANISM_ALIASES: Record<string, string> = {
  '人': 'Homo sapiens', '人类': 'Homo sapiens', 'human': 'Homo sapiens', 'homo sapiens': 'Homo sapiens',
  '小鼠': 'Mus musculus', '老鼠': 'Mus musculus', 'mouse': 'Mus musculus', 'mus musculus': 'Mus musculus',
  '大鼠': 'Rattus norvegicus', 'rat': 'Rattus norvegicus', 'rattus norvegicus': 'Rattus norvegicus',
  '斑马鱼': 'Danio rerio', 'zebrafish': 'Danio rerio', 'danio rerio': 'Danio rerio',
  '果蝇': 'Drosophila melanogaster', 'drosophila': 'Drosophila melanogaster', 'fruit fly': 'Drosophila melanogaster', 'drosophila melanogaster': 'Drosophila melanogaster',
  '拟南芥': 'Arabidopsis thaliana', 'arabidopsis': 'Arabidopsis thaliana', 'arabidopsis thaliana': 'Arabidopsis thaliana',
  '酿酒酵母': 'Saccharomyces cerevisiae', '酵母': 'Saccharomyces cerevisiae', 'yeast': 'Saccharomyces cerevisiae', 'saccharomyces cerevisiae': 'Saccharomyces cerevisiae',
  '线虫': 'Caenorhabditis elegans', '秀丽隐杆线虫': 'Caenorhabditis elegans', 'c. elegans': 'Caenorhabditis elegans', 'caenorhabditis elegans': 'Caenorhabditis elegans',
  '猪': 'Sus scrofa', 'pig': 'Sus scrofa', 'sus scrofa': 'Sus scrofa',
  '牛': 'Bos taurus', 'cattle': 'Bos taurus', 'bovine': 'Bos taurus', 'bos taurus': 'Bos taurus',
  '犬': 'Canis lupus familiaris', '狗': 'Canis lupus familiaris', 'dog': 'Canis lupus familiaris', 'canis lupus familiaris': 'Canis lupus familiaris',
  '鸡': 'Gallus gallus', 'chicken': 'Gallus gallus', 'gallus gallus': 'Gallus gallus',
  '恒河猴': 'Macaca mulatta', '猕猴': 'Macaca mulatta', 'rhesus macaque': 'Macaca mulatta', 'macaca mulatta': 'Macaca mulatta',
};

type NormalizeResult = { ok: true; value: string; note?: string } | { ok: false; reason: string };

/** organism 归一化：先查映射表（大小写不敏感），再按二名法形校验（首字母自动大写）。
 *  映射表之外且不符二名法形的一律拒绝（ok:false），不猜学名。 */
export function normalizeOrganism(raw: string): NormalizeResult {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return { ok: false, reason: 'organism 为空' };
  const alias = ORGANISM_ALIASES[v.toLowerCase()];
  if (alias) return { ok: true, value: alias, note: alias === v ? undefined : `organism: ${v} → ${alias}` };
  // 学名形：修正首字母大小写后复核（mus musculus → Mus musculus）
  const fixed = v.replace(/^[a-z]/, (c) => c.toUpperCase());
  if (BINOMIAL_PATTERN.test(fixed)) return { ok: true, value: fixed, note: fixed === v ? undefined : `organism: ${v} → ${fixed}` };
  return { ok: false, reason: `organism「${v}」既不在常见种映射表也不符合二名法学名形（如 Mus musculus）` };
}

// ---------- assay：中英文别名 → library_strategy 词表 ----------

/**
 * assay 归一化词表：value 是可直接传给 seqout_search_structured.library_strategy 的规范值。
 * key 为小写化别名（含中文）。词表有意保持收敛：未收录的技术走 ok:false 降级，
 * 防止模型把自由文本（如"蛋白质组学"）当成合法 library_strategy 直传上游。
 */
const ASSAY_ALIASES: Record<string, string> = {
  'rna-seq': 'RNA-Seq', 'rnaseq': 'RNA-Seq', 'rna seq': 'RNA-Seq', '转录组': 'RNA-Seq', '转录组测序': 'RNA-Seq', 'bulk rna-seq': 'RNA-Seq', 'bulk': 'RNA-Seq',
  'scrna-seq': 'scRNA-Seq', 'scrnaseq': 'scRNA-Seq', 'scrna': 'scRNA-Seq', 'single cell': 'scRNA-Seq', 'single-cell': 'scRNA-Seq', 'single-cell rna-seq': 'scRNA-Seq', '单细胞': 'scRNA-Seq', '单细胞转录组': 'scRNA-Seq', '单细胞测序': 'scRNA-Seq', '10x': 'scRNA-Seq',
  'snrna-seq': 'snRNA-Seq', 'snrnaseq': 'snRNA-Seq', 'single nucleus': 'snRNA-Seq', 'single-nucleus': 'snRNA-Seq', '单核': 'snRNA-Seq', '单细胞核': 'snRNA-Seq',
  'atac-seq': 'ATAC-Seq', 'atacseq': 'ATAC-Seq', 'atac': 'ATAC-Seq', '染色质可及性': 'ATAC-Seq', '染色质开放性': 'ATAC-Seq',
  'chip-seq': 'ChIP-Seq', 'chipseq': 'ChIP-Seq', 'chip': 'ChIP-Seq', '染色质免疫沉淀': 'ChIP-Seq',
  'wgs': 'WGS', 'whole genome': 'WGS', 'whole-genome sequencing': 'WGS', '全基因组': 'WGS', '全基因组测序': 'WGS',
  'wes': 'WES', 'whole exome': 'WES', 'whole-exome sequencing': 'WES', '全外显子': 'WES', '全外显子组': 'WES',
  'hi-c': 'Hi-C', 'hic': 'Hi-C', '三维基因组': 'Hi-C',
  'bisulfite-seq': 'Bisulfite-Seq', 'bisulfite': 'Bisulfite-Seq', 'wgbs': 'Bisulfite-Seq', '甲基化': 'Bisulfite-Seq', '甲基化测序': 'Bisulfite-Seq', '亚硫酸氢盐': 'Bisulfite-Seq',
  'mirna-seq': 'miRNA-Seq', 'mirna': 'miRNA-Seq', 'small rna': 'miRNA-Seq', 'small rna-seq': 'miRNA-Seq', '小rna': 'miRNA-Seq', '微小rna': 'miRNA-Seq',
  'ribo-seq': 'Ribo-Seq', 'riboseq': 'Ribo-Seq', 'ribosome profiling': 'Ribo-Seq', '核糖体图谱': 'Ribo-Seq',
  'dnase-seq': 'DNase-Seq', 'dnaseseq': 'DNase-Seq', 'dnase': 'DNase-Seq',
  'metagenomic': 'Metagenomic', 'metagenomics': 'Metagenomic', '宏基因组': 'Metagenomic', '宏基因组学': 'Metagenomic',
  'amplicon': 'Amplicon', '16s': 'Amplicon', '16s rrna': 'Amplicon', '扩增子': 'Amplicon',
};

/** assay 归一化：别名表（大小写不敏感）→ library_strategy 规范值；未收录即 ok:false */
export function normalizeAssay(raw: string): NormalizeResult {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return { ok: false, reason: 'assay 为空' };
  const hit = ASSAY_ALIASES[v.toLowerCase()];
  if (hit) return { ok: true, value: hit, note: hit === v ? undefined : `assay: ${v} → ${hit}` };
  return { ok: false, reason: `assay「${v}」不在 library_strategy 词表内（如 RNA-Seq / scRNA-Seq / ATAC-Seq / ChIP-Seq / WGS）` };
}

// ---------- IR 整体验验 ----------

const QUESTION_MAX = 500;
const FREETEXT_MAX = 120;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 自由文本槽位（tissue_or_celltype / condition）：截断+去空白，无词表校验；空串视为未提供 */
function freeText(raw: unknown, field: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  if (typeof raw !== 'string') return { ok: false, reason: `${field} 必须是字符串` };
  const v = raw.replace(/\s+/g, ' ').trim();
  if (!v) return { ok: true };
  return { ok: true, value: v.slice(0, FREETEXT_MAX) };
}

/**
 * 校验并归一化模型产出的意图 JSON。
 * 严格项（任一失败整体 ok:false，调用方降级）：question 必填非空、targets 为已知目标非空数组、
 * organism/assay 若提供必须可归一化、has_control/needs_literature 必须是真布尔。
 * 宽松项：filters 可整体缺省或为空对象；tissue_or_celltype/condition 自由文本透传。
 * 一致性修正（记 notes 不判负）：targets 含 literature 时强制 needs_literature=true。
 */
export function parseResearchIntent(raw: unknown): ParseIntentResult {
  if (!isPlainObject(raw)) return { ok: false, reason: '意图不是 JSON 对象' };
  const notes: string[] = [];

  const questionRaw = raw.question;
  if (typeof questionRaw !== 'string' || !questionRaw.trim()) return { ok: false, reason: 'question 缺失或为空' };
  const question = questionRaw.replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX);

  const targetsRaw = raw.targets;
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) return { ok: false, reason: 'targets 必须是非空数组（取值 geo/sra/ngdc/literature）' };
  const targets: IntentTarget[] = [];
  for (const t of targetsRaw) {
    if (typeof t !== 'string' || !(INTENT_TARGETS as readonly string[]).includes(t)) {
      return { ok: false, reason: `targets 含未知目标「${String(t)}」（取值 geo/sra/ngdc/literature）` };
    }
    if (!targets.includes(t as IntentTarget)) targets.push(t as IntentTarget);
  }

  const filtersRaw = raw.filters;
  if (filtersRaw !== undefined && filtersRaw !== null && !isPlainObject(filtersRaw)) {
    return { ok: false, reason: 'filters 必须是对象' };
  }
  const f = (filtersRaw ?? {}) as Record<string, unknown>;
  const filters: ResearchIntentFilters = {};

  if (f.organism !== undefined && f.organism !== null && f.organism !== '') {
    if (typeof f.organism !== 'string') return { ok: false, reason: 'filters.organism 必须是字符串' };
    const n = normalizeOrganism(f.organism);
    if (n.ok === false) return { ok: false, reason: n.reason };
    filters.organism = n.value;
    if (n.note) notes.push(n.note);
  }
  if (f.assay !== undefined && f.assay !== null && f.assay !== '') {
    if (typeof f.assay !== 'string') return { ok: false, reason: 'filters.assay 必须是字符串' };
    const n = normalizeAssay(f.assay);
    if (n.ok === false) return { ok: false, reason: n.reason };
    filters.assay = n.value;
    if (n.note) notes.push(n.note);
  }
  const tissue = freeText(f.tissue_or_celltype, 'filters.tissue_or_celltype');
  if (tissue.ok === false) return { ok: false, reason: tissue.reason };
  if (tissue.value) filters.tissue_or_celltype = tissue.value;
  const condition = freeText(f.condition, 'filters.condition');
  if (condition.ok === false) return { ok: false, reason: condition.reason };
  if (condition.value) filters.condition = condition.value;
  if (f.has_control !== undefined && f.has_control !== null) {
    if (typeof f.has_control !== 'boolean') return { ok: false, reason: 'filters.has_control 必须是布尔值' };
    filters.has_control = f.has_control;
  }

  if (typeof raw.needs_literature !== 'boolean') return { ok: false, reason: 'needs_literature 必须是布尔值' };
  let needsLiterature = raw.needs_literature;
  if (targets.includes('literature') && !needsLiterature) {
    needsLiterature = true; // 目标含文献库却标不需要文献，以前者为准
    notes.push('needs_literature: false → true（targets 含 literature）');
  }

  return { ok: true, intent: { question, targets, filters, needs_literature: needsLiterature }, notes };
}
