// clinvar.ts：ClinVar 适配器（clinvar_search 检索 / clinvar_get 详情），供 biomed/index.ts 分发调用。
// 上游 API 实测要点（2026-10-18 探测固化，样本存 /tmp/biomed-probe/）：
// - esearch(db=clinvar) 返回数字 VariationID uid 列表（esummary 的 id 形态）；
// - esummary(db=clinvar) 字段名：germline_classification / **clinical_impact_classification**（= somatic，
//   映射到本模块 somatic_impact）/ oncogenicity_classification；三类均为对象
//   {description, last_evaluated, review_status, trait_set}，空 description 表示该类不适用；
// - efetch rettype=vcv：根元素 ClinVarResult-Set>VariationArchive；聚合级三类分类标签为
//   GermlineClassification / **SomaticClinicalImpact**（不是 design 初稿的 SomaticImpactClassification）/
//   OncogenicityClassification，各自含 <ReviewStatus> + <Description>，DateLastEvaluated 在分类标签属性上；
//   RCV 级分类在 RCVAccession/RCVClassifications 内（DateLastEvaluated 在 Description 属性上）；
// - efetch rettype=clinvarset：根元素 ClinVarSet>ReferenceClinVarAssertion（Acc=RCV…），父级 VCV 在
//   MeasureSet@Acc，基因符号在 Measure/MeasureRelationship/Symbol/ElementValue；
// - SCV 级（ClinicalAssertion 内）分类是直接文本，形态如
//   <SomaticClinicalImpact ClinicalImpactAssertionType="therapeutic" …>Tier I - Strong</SomaticClinicalImpact>；
//   提交者在 ClinVarAccession@SubmitterName（vcv 形态）或 ClinVarSubmissionID@submitter（clinvarset 形态）；
// - efetch 对臆造 ID 返回 <eFetchResult><ERROR>…</ERROR></eFetchResult>（HTTP 200），提取器按 null 处理并转述原文；
// - XXE 防护（spec 4.3.2）：提取器为纯函数（无网络、无 DOM 解析——双运行时无 DOMParser），
//   DOCTYPE/注释整段丢弃不解析，仅解码 5 个预定义实体，其余实体引用（如 &xxe;）原样保留不展开。
// 网络预算：共享 ncbiBucket（每次上游调用前 acquireNcbi，无 token 抛可重试错误、绝不表述为未找到）；
// 超时 8000ms、retries=1（429 快速放弃，把配额让给文献链路）。
// ClinVar 无实测可用的数据版本元数据端点，build_version 如实标 'unknown' 不拼造。

import { EUTILS, acquireNcbi, eutilsParams, fetchTextWithRetry, fetchWithRetry } from '../shared.ts';
import { CLINVAR_DISCLAIMER } from './types.ts';
import type { ClinVarAssertionType, ClinVarEntry, ClinVarRcvItem, ClinVarScvAssertion } from './types.ts';

type Json = Record<string, unknown> | string | number | boolean | null | Json[];

const NCBI_HEADERS: Record<string, string> = { 'User-Agent': 'ResearchTreasureMouse/1.0' };

const CLINVAR_BUILD_VERSION = 'unknown';

/** 三类分类标签（实测名，聚合级与 RCV 级同名；SCV 级同名但内容为直接文本） */
const CLASSIFICATION_TAG: Record<ClinVarAssertionType, string> = {
  germline: 'GermlineClassification',
  somatic: 'SomaticClinicalImpact',
  oncogenic: 'OncogenicityClassification',
};
const CLASSIFICATION_KINDS: ClinVarAssertionType[] = ['germline', 'somatic', 'oncogenic'];

/** 「未给出分类」的官方取值：保留在断言明细中，但排除出冲突判定 */
const NON_CLASSIFICATIONS = new Set(['', 'not provided', 'not applicable', 'no classification provided', 'no classification for the single condition']);

// ========== 2.4 安全 XML 提取器（纯函数，无网络无副作用） ==========

/** 仅解码 5 个 XML 预定义实体；其余实体引用（如 &xxe;）原样保留不展开（单遍替换不二次解码） */
function xmlDecode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name: string) =>
    name === 'amp' ? '&' : name === 'lt' ? '<' : name === 'gt' ? '>' : name === 'quot' ? '"' : "'");
}

/** 预处理：剥离注释与 DOCTYPE 声明（含内部实体表——不解析、不展开、不发网络请求，整段丢弃），
 *  防止注释/DTD 内的伪造标签干扰标签级扫描；实体引用保持字面。 */
function sanitizeXml(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>\[]*(?:\[[\s\S]*?\])?\s*>/g, '');
}

interface XmlBlock {
  /** 开标签内属性串（不含标签名与尖括号） */
  attrs: string;
  /** 开标签结束后到闭标签前的内容 */
  inner: string;
  /** 块整体结束位置（闭标签后或自闭合标签后） */
  end: number;
}

/** 查找下一个精确命名的开标签；<Gene 不得误匹配 <GeneList（标签名后必须紧跟空白/>） */
function findTagOpen(xml: string, tagName: string, from: number): { start: number; afterOpen: number; attrs: string; selfClosing: boolean } | null {
  let search = from;
  for (;;) {
    const idx = xml.indexOf(`<${tagName}`, search);
    if (idx === -1) return null;
    const nextCh = xml[idx + 1 + tagName.length];
    if (!nextCh || !/[\s/>]/.test(nextCh)) { search = idx + 1; continue; }
    const gt = xml.indexOf('>', idx);
    if (gt === -1) return null;
    const selfClosing = xml[gt - 1] === '/';
    return {
      start: idx,
      afterOpen: gt + 1,
      attrs: xml.slice(idx + 1 + tagName.length, selfClosing ? gt - 1 : gt),
      selfClosing,
    };
  }
}

/** 查找下一个精确命名的闭标签位置（</Gene 不得误匹配 </GeneList） */
function findCloseExact(xml: string, tagName: string, from: number): number {
  let search = from;
  for (;;) {
    const idx = xml.indexOf(`</${tagName}`, search);
    if (idx === -1) return -1;
    const after = xml[idx + 2 + tagName.length];
    if (after === undefined || after === '>' || after === ' ' || after === '\t' || after === '\n' || after === '\r') return idx;
    search = idx + 1;
  }
}

/** 定位一个完整标签块（同名嵌套深度计数；自闭合返回 inner=''） */
function findBlock(xml: string, tagName: string, from = 0): XmlBlock | null {
  const open = findTagOpen(xml, tagName, from);
  if (!open) return null;
  if (open.selfClosing) return { attrs: open.attrs, inner: '', end: open.afterOpen };
  let depth = 1;
  let scan = open.afterOpen;
  for (;;) {
    const closeIdx = findCloseExact(xml, tagName, scan);
    if (closeIdx === -1) return null;
    const nextOpen = findTagOpen(xml, tagName, scan);
    if (nextOpen !== null && nextOpen.start < closeIdx) {
      depth++;
      scan = nextOpen.afterOpen;
      continue;
    }
    depth--;
    const closeGt = xml.indexOf('>', closeIdx);
    if (closeGt === -1) return null;
    const end = closeGt + 1;
    if (depth === 0) return { attrs: open.attrs, inner: xml.slice(open.afterOpen, closeIdx), end };
    scan = end;
  }
}

/** 收集全部同名块（顺序遍历，位置递进） */
function findBlocks(xml: string, tagName: string, from = 0): XmlBlock[] {
  const out: XmlBlock[] = [];
  let scan = from;
  for (;;) {
    const block = findBlock(xml, tagName, scan);
    if (!block) break;
    out.push(block);
    scan = block.end;
  }
  return out;
}

/** 从标签串提取双引号属性值（ClinVar 全部使用双引号；已做实体解码） */
function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? xmlDecode(m[1]) : undefined;
}

/** 剥离内嵌标签 + 实体解码 + 折叠空白（提取纯文本内容用） */
function stripTags(s: string): string {
  return xmlDecode(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** 取第一个 tagName 的文本内容 */
function textOf(xml: string, tagName: string, from = 0): string | undefined {
  const block = findBlock(xml, tagName, from);
  if (!block) return undefined;
  const t = stripTags(block.inner);
  return t || undefined;
}

/** 分类块 → 分类文本：优先 <Description> 子元素（聚合级/RCV 级形态）；
 *  无 Description 且 inner 为纯文本时取直接文本（SCV 级形态，如 Tier I - Strong）。 */
function classificationText(block: XmlBlock): string | undefined {
  const desc = findBlock(block.inner, 'Description');
  if (desc) {
    const t = stripTags(desc.inner);
    return t || undefined;
  }
  if (!block.inner.includes('<')) {
    const t = xmlDecode(block.inner).replace(/\s+/g, ' ').trim();
    return t || undefined;
  }
  return undefined;
}

/** 分类块 → 最后评估日期：分类标签自身属性（聚合级）或 Description 属性（RCV 级） */
function classificationDate(block: XmlBlock): string | undefined {
  const own = attr(block.attrs, 'DateLastEvaluated');
  if (own) return own;
  const desc = findBlock(block.inner, 'Description');
  return desc ? attr(desc.attrs, 'DateLastEvaluated') : undefined;
}

interface AggregateClassifications {
  germline?: string;
  somatic?: string;
  oncogenic?: string;
  reviewStatus?: string;
  lastEvaluated?: string;
}

/** 分类容器（Classifications 或 RCVClassifications 的 inner）→ 三类分列 + 主分类的审评状态/日期。
 *  空分类（如 esummary 的空 description 对应块缺失/空文本）不落字段。 */
function extractAggregateClassifications(inner: string): AggregateClassifications {
  const out: AggregateClassifications = {};
  for (const kind of CLASSIFICATION_KINDS) {
    const block = findBlock(inner, CLASSIFICATION_TAG[kind]);
    if (!block) continue;
    const desc = classificationText(block);
    if (!desc) continue;
    out[kind] = desc;
    if (!out.reviewStatus || !out.lastEvaluated) {
      const review = textOf(block.inner, 'ReviewStatus');
      const date = classificationDate(block);
      if (review && !out.reviewStatus) out.reviewStatus = review;
      if (date && !out.lastEvaluated) out.lastEvaluated = date;
    }
  }
  return out;
}

/** 同类型断言分类不一致即 true（排除「未给出分类」取值；冲突各方断言在明细中并列保留） */
function computeSubmitterConflict(assertions: ClinVarScvAssertion[]): boolean {
  const byType = new Map<ClinVarAssertionType, Set<string>>();
  for (const a of assertions) {
    if (NON_CLASSIFICATIONS.has(a.classification.trim().toLowerCase())) continue;
    let set = byType.get(a.assertion_type);
    if (!set) { set = new Set(); byType.set(a.assertion_type, set); }
    set.add(a.classification);
  }
  for (const set of byType.values()) if (set.size > 1) return true;
  return false;
}

/** SCV 断言明细提取（vcv 形态标签名 ClinicalAssertion / clinvarset 形态标签名 ClinVarAssertion）：
 *  每个分类标签生成一条断言（一类一条，断言类型由标签名映射），提交者双形态取值。 */
function extractScvAssertions(xml: string, tagName: 'ClinicalAssertion' | 'ClinVarAssertion'): ClinVarScvAssertion[] {
  const assertions: ClinVarScvAssertion[] = [];
  for (const block of findBlocks(xml, tagName)) {
    const acc = findBlock(block.inner, 'ClinVarAccession');
    const submitter = (acc ? attr(acc.attrs, 'SubmitterName') : undefined)
      ?? (() => { const sub = findBlock(block.inner, 'ClinVarSubmissionID'); return sub ? attr(sub.attrs, 'submitter') : undefined; })()
      ?? '未知提交者';
    const classificationBlock = findBlock(block.inner, 'Classification');
    const reviewStatus = classificationBlock ? textOf(classificationBlock.inner, 'ReviewStatus') : undefined;
    const date = classificationBlock ? attr(classificationBlock.attrs, 'DateLastEvaluated') : undefined;
    for (const kind of CLASSIFICATION_KINDS) {
      const cb = findBlock(block.inner, CLASSIFICATION_TAG[kind]);
      if (!cb) continue;
      const classification = classificationText(cb);
      if (!classification) continue;
      const assertion: ClinVarScvAssertion = { submitter, assertion_type: kind, classification };
      if (reviewStatus) assertion.review_status = reviewStatus;
      if (date) assertion.date = date;
      assertions.push(assertion);
    }
  }
  return assertions;
}

/** 「变体 AND 疾病」标题 → 疾病部分（变体名不含 ' AND '，取首个分隔后的全部） */
function conditionFromTitle(title: string): string {
  const idx = title.indexOf(' AND ');
  return idx >= 0 ? title.slice(idx + 5) : '';
}

/** VariationArchive（rettype=vcv）→ ClinVarEntry；无 VariationArchive/Accession 返回 null（ERROR XML 等） */
export function extractVcvEntry(rawXml: string): ClinVarEntry | null {
  const xml = sanitizeXml(rawXml);
  const archive = findBlock(xml, 'VariationArchive');
  if (!archive) return null;
  const accession = attr(archive.attrs, 'Accession');
  if (!accession) return null;
  const record = findBlock(xml, 'ClassifiedRecord');
  const recordInner = record ? record.inner : xml;

  const entry: ClinVarEntry = {
    vcv_accession: accession,
    rcv_list: [],
    scv_assertions: [],
    submitter_conflict: false,
    disclaimer: CLINVAR_DISCLAIMER,
  };
  const versionAttr = attr(archive.attrs, 'Version');
  if (versionAttr) entry.version = `.${versionAttr}`;
  const title = attr(archive.attrs, 'VariationName');
  if (title) entry.title = title;

  // 基因：顶层 SimpleAllele/GeneList/Gene@Symbol（SCV 级同名块在 ClinicalAssertion 内，首个必为顶层）
  const allele = findBlock(recordInner, 'SimpleAllele');
  if (allele) {
    const geneList = findBlock(allele.inner, 'GeneList');
    const gene = geneList ? findBlock(geneList.inner, 'Gene') : null;
    const symbol = gene ? attr(gene.attrs, 'Symbol') : undefined;
    if (symbol) entry.gene = symbol;
  }

  // RCV 列表：编号 + 疾病名（ClassifiedCondition 优先，标题兜底）+ RCV 级分类
  const rcvList = findBlock(recordInner, 'RCVList');
  if (rcvList) {
    for (const rcv of findBlocks(rcvList.inner, 'RCVAccession')) {
      const rcvAcc = attr(rcv.attrs, 'Accession');
      if (!rcvAcc) continue;
      const rcvTitle = attr(rcv.attrs, 'Title') ?? '';
      const conditions: string[] = [];
      for (const cond of findBlocks(rcv.inner, 'ClassifiedCondition')) {
        const t = stripTags(cond.inner);
        if (t) conditions.push(t);
      }
      const condition = conditions.length ? conditions.join('; ') : conditionFromTitle(rcvTitle);
      const item: ClinVarRcvItem = { rcv_accession: rcvAcc, condition };
      const rcvClass = findBlock(rcv.inner, 'RCVClassifications');
      if (rcvClass) {
        const cls = extractAggregateClassifications(rcvClass.inner);
        const c = cls.germline ?? cls.somatic ?? cls.oncogenic;
        if (c) item.classification = c;
      }
      entry.rcv_list.push(item);
    }
  }

  // 聚合三类分类（分列呈现，spec 5.4.1）+ 审评状态/最后评估日期
  const classifications = findBlock(recordInner, 'Classifications');
  if (classifications) {
    const cls = extractAggregateClassifications(classifications.inner);
    if (cls.germline) entry.germline_classification = cls.germline;
    if (cls.somatic) entry.somatic_impact = cls.somatic;
    if (cls.oncogenic) entry.oncogenicity = cls.oncogenic;
    if (cls.reviewStatus) entry.review_status = cls.reviewStatus;
    if (cls.lastEvaluated) entry.last_evaluated = cls.lastEvaluated;
  }

  // SCV 断言明细 + 冲突判定
  const assertionList = findBlock(recordInner, 'ClinicalAssertionList');
  if (assertionList) {
    entry.scv_assertions = extractScvAssertions(assertionList.inner, 'ClinicalAssertion');
    entry.submitter_conflict = computeSubmitterConflict(entry.scv_assertions);
  }
  return entry;
}

/** ClinVarSet（rettype=clinvarset）→ ClinVarEntry（RCV 中心记录；父级 VCV 取自 MeasureSet@Acc） */
export function extractRcvEntry(rawXml: string): ClinVarEntry | null {
  const xml = sanitizeXml(rawXml);
  const set = findBlock(xml, 'ClinVarSet');
  if (!set) return null;
  const ref = findBlock(set.inner, 'ReferenceClinVarAssertion');
  const refAcc = ref ? findBlock(ref.inner, 'ClinVarAccession') : null;
  const rcvAcc = refAcc ? attr(refAcc.attrs, 'Acc') : undefined;
  if (!ref || !refAcc || !rcvAcc) return null;

  const title = textOf(set.inner, 'Title') ?? '';
  const entry: ClinVarEntry = {
    vcv_accession: rcvAcc, // 兜底：无 MeasureSet@Acc 时至少有本记录标识
    rcv_list: [],
    scv_assertions: [],
    submitter_conflict: false,
    disclaimer: CLINVAR_DISCLAIMER,
  };

  const measureSet = findBlock(ref.inner, 'MeasureSet');
  if (measureSet) {
    const vcvAcc = attr(measureSet.attrs, 'Acc');
    if (vcvAcc) entry.vcv_accession = vcvAcc;
    const v = attr(measureSet.attrs, 'Version');
    if (v) entry.version = `.${v}`;
    // 基因：Measure/MeasureRelationship/Symbol/ElementValue（实测 clinvarset 形态无 Gene@Symbol 属性）
    const rel = findBlock(measureSet.inner, 'MeasureRelationship');
    const symbolBlock = rel ? findBlock(rel.inner, 'Symbol') : null;
    const gene = symbolBlock ? textOf(symbolBlock.inner, 'ElementValue') : undefined;
    if (gene) entry.gene = gene;
  }
  if (!entry.gene && title) {
    const m = /\(([A-Za-z][A-Za-z0-9_-]*)\):/.exec(title);
    if (m) entry.gene = m[1];
  }
  if (title) entry.title = title;

  // RCV 级三类分类（ReferenceClinVarAssertion/Classifications）
  const classifications = findBlock(ref.inner, 'Classifications');
  const cls = classifications ? extractAggregateClassifications(classifications.inner) : {};
  if (cls.germline) entry.germline_classification = cls.germline;
  if (cls.somatic) entry.somatic_impact = cls.somatic;
  if (cls.oncogenic) entry.oncogenicity = cls.oncogenic;
  if (cls.reviewStatus) entry.review_status = cls.reviewStatus;
  if (cls.lastEvaluated) entry.last_evaluated = cls.lastEvaluated;

  // rcv_list：本 RCV 自身（疾病名取标题 AND 分割，TraitSet Preferred 名兜底）
  let condition = conditionFromTitle(title);
  if (!condition) {
    const traitSet = findBlock(ref.inner, 'TraitSet');
    const trait = traitSet ? findBlock(traitSet.inner, 'Trait') : null;
    const name = trait ? findBlock(trait.inner, 'Name') : null;
    condition = name ? (textOf(name.inner, 'ElementValue') ?? '') : '';
  }
  const item: ClinVarRcvItem = { rcv_accession: rcvAcc, condition };
  const c = cls.germline ?? cls.somatic ?? cls.oncogenic;
  if (c) item.classification = c;
  entry.rcv_list.push(item);

  // SCV 断言明细（clinvarset 形态标签名为 ClinVarAssertion）
  entry.scv_assertions = extractScvAssertions(set.inner, 'ClinVarAssertion');
  entry.submitter_conflict = computeSubmitterConflict(entry.scv_assertions);
  return entry;
}

// ========== 2.5 检索与详情网络链路 ==========

/** clinvar_search 概览级条目（esummary 投影；SCV 明细走 clinvar_get） */
export interface ClinVarSummaryEntry {
  vcv_accession: string;
  version?: string;
  title?: string;
  gene?: string;
  condition: string;
  germline_classification?: string;
  somatic_impact?: string;
  oncogenicity?: string;
  review_status?: string;
  last_evaluated?: string;
  url: string;
  disclaimer: string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 配额耗尽：error 语义、标注可重试，绝不表述为未找到（spec 4.2.2 红线） */
function quotaError(): Error {
  return new Error('NCBI 公共接口调用频率限制（共享配额已耗尽），请稍后重试；本轮其他数据库检索不受影响。');
}

/** 上游错误统一映射（服务异常可重试，绝不算未找到） */
function mapClinvarError(err: unknown): Error {
  const cause = err instanceof Error ? err.message : String(err);
  if (err instanceof SyntaxError || /Unexpected token|is not valid JSON/i.test(cause)) {
    return new Error(`上游返回了非预期的响应格式，已按服务异常处理（NCBI E-utilities：${cause.slice(0, 80)}）`);
  }
  return new Error(`临床证据服务暂时不可用（NCBI E-utilities 异常：${cause}），可稍后重试；本轮其余检索不受影响`);
}

function emptyClinvarEnvelope(note: string): Json {
  return {
    success: true,
    data: {
      results: [],
      total: 0,
      source: 'clinvar',
      build_version: CLINVAR_BUILD_VERSION,
      empty: true,
      not_found: true,
      note,
    },
  };
}

function classSummaryField(raw: unknown): { description: string; review_status: string; last_evaluated: string; trait_names: string[] } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const traitNames: string[] = [];
  if (Array.isArray(c.trait_set)) {
    for (const ts of c.trait_set) {
      if (!ts || typeof ts !== 'object' || Array.isArray(ts)) continue;
      const name = (ts as Record<string, unknown>).trait_name;
      if (typeof name === 'string' && name) traitNames.push(name);
    }
  }
  return {
    description: typeof c.description === 'string' ? c.description.trim() : '',
    review_status: typeof c.review_status === 'string' ? c.review_status.trim() : '',
    last_evaluated: typeof c.last_evaluated === 'string' ? c.last_evaluated.trim() : '',
    trait_names: traitNames,
  };
}

/** esummary 单 uid 记录 → 概览条目（畸形行返回 null 防御性丢弃） */
function toSummaryEntry(uid: string, raw: unknown): ClinVarSummaryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const accession = typeof r.accession === 'string' && r.accession ? r.accession : '';
  if (!accession) return null;
  const entry: ClinVarSummaryEntry = {
    vcv_accession: accession,
    condition: '',
    url: `https://www.ncbi.nlm.nih.gov/clinvar/variation/${uid}/`,
    disclaimer: CLINVAR_DISCLAIMER,
  };
  if (typeof r.accession_version === 'string') {
    const m = /^VCV\d+(\.\d+)$/.exec(r.accession_version);
    if (m) entry.version = m[1];
  }
  if (typeof r.title === 'string' && r.title) entry.title = r.title;
  if (Array.isArray(r.genes)) {
    const firstGene = r.genes.find((g): g is Record<string, unknown> => !!g && typeof g === 'object' && !Array.isArray(g) && typeof (g as Record<string, unknown>).symbol === 'string');
    if (firstGene) entry.gene = firstGene.symbol as string;
  }
  // esummary 的 clinical_impact_classification 即 somatic 分类（实测字段名），映射为 somatic_impact
  const germline = classSummaryField(r.germline_classification);
  const somatic = classSummaryField(r.clinical_impact_classification);
  const oncogenic = classSummaryField(r.oncogenicity_classification);
  if (germline?.description) entry.germline_classification = germline.description;
  if (somatic?.description) entry.somatic_impact = somatic.description;
  if (oncogenic?.description) entry.oncogenicity = oncogenic.description;
  const primary = germline?.description ? germline : somatic?.description ? somatic : oncogenic?.description ? oncogenic : undefined;
  if (primary) {
    if (primary.review_status) entry.review_status = primary.review_status;
    if (primary.last_evaluated) entry.last_evaluated = primary.last_evaluated;
    if (primary.trait_names.length) entry.condition = primary.trait_names.join('; ');
  }
  return entry;
}

export interface ClinvarSearchArgs {
  term: unknown;
  limit?: unknown;
}

/** clinvar_search：esearch（数字 UID）→ esummary（概览）两段链路，各消耗 1 个 ncbiBucket token。
 *  term 透传 ClinVar 原生字段语法（如 TP53[gene] AND Val600Glu[protein change]），原生接受自由文本。 */
export async function searchClinvar(args: ClinvarSearchArgs): Promise<Json> {
  const term = String(args.term ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!term) {
    throw new Error('检索词为空或只含控制字符。请给出基因符号（如 TP53）、疾病名、变异标识或 ClinVar 字段语法（如 BRAF[gene] AND Val600Glu[protein change]）。');
  }
  if (term.length > 300) {
    throw new Error(`检索词过长（${term.length} 字符，上限 300）。请精简检索条件。`);
  }
  if (!/[\p{L}\p{N}]/u.test(term)) {
    throw new Error(`检索词「${term.slice(0, 50)}」不含任何字母或数字，无法检索。`);
  }
  const limit = clampInt(args.limit, 10, 1, 20);

  if (!acquireNcbi()) throw quotaError();
  let idlist: string[] = [];
  try {
    const search = await fetchWithRetry(`${EUTILS}/esearch.fcgi?${eutilsParams({ db: 'clinvar', term, retmode: 'json', retmax: String(limit) })}`, 8000, 1, NCBI_HEADERS);
    const result = (search as Record<string, unknown>).esearchresult;
    const ids = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).idlist : undefined;
    idlist = (Array.isArray(ids) ? ids : []).map((v) => String(v)).filter((v) => /^\d+$/.test(v)).slice(0, limit);
  } catch (err) {
    throw mapClinvarError(err);
  }
  if (idlist.length === 0) {
    return emptyClinvarEnvelope(`ClinVar 未命中检索词「${term}」。可尝试 ClinVar 字段语法（如 TP53[gene]、BRAF[gene] AND Val600Glu[protein change]），或改用更宽泛的疾病名/基因符号。`);
  }

  if (!acquireNcbi()) throw quotaError();
  let entries: ClinVarSummaryEntry[] = [];
  try {
    const summary = await fetchWithRetry(`${EUTILS}/esummary.fcgi?${eutilsParams({ db: 'clinvar', id: idlist.join(','), retmode: 'json' })}`, 8000, 1, NCBI_HEADERS);
    const result = (summary as Record<string, unknown>).result;
    entries = result && typeof result === 'object' && !Array.isArray(result)
      ? idlist.map((uid) => toSummaryEntry(uid, (result as Record<string, unknown>)[uid])).filter((e): e is ClinVarSummaryEntry => e !== null)
      : [];
  } catch (err) {
    throw mapClinvarError(err);
  }
  if (entries.length === 0) {
    return emptyClinvarEnvelope(`ClinVar 命中 ${idlist.length} 条记录但概览获取失败。可稍后重试，或直接用 clinvar_get 按编号查询详情。`);
  }

  const data: Record<string, unknown> = {
    results: entries,
    total: entries.length,
    source: 'clinvar',
    build_version: CLINVAR_BUILD_VERSION,
  };
  if (entries.some((e) => e.germline_classification === 'Conflicting classifications of pathogenicity')) {
    data.note = '一个或多个记录存在提交者分类冲突，请并列呈现各方断言，不要只取单一总分；详情用 clinvar_get 查询。';
  }
  return { success: true, data };
}

export interface ClinvarGetArgs {
  accession: unknown;
}

/** clinvar_get：VCV（rettype=vcv）/ RCV（rettype=clinvarset）分流 efetch XML，经安全提取器解析；
 *  SCV 前缀专属拒绝（单提交者断言，不支持直接查询）。 */
export async function getClinvar(args: ClinvarGetArgs): Promise<Json> {
  const raw = String(args.accession ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (/^SCV\d/i.test(raw)) {
    throw new Error('编号类型无法识别：SCV 为单提交者断言记录，不支持直接查询。应传 VCV 编号（变异汇总记录，如 VCV000065533）或 RCV 编号（变异-疾病关系记录，如 RCV000055723）；如需提交者明细，用 clinvar_get 查对应 VCV 记录，其 scv_assertions 已含各提交者断言。');
  }
  const m = /^(VCV|RCV)(\d{6,10})(?:\.(\d+))?$/i.exec(raw);
  if (!m) {
    throw new Error(`编号格式不正确：${raw || '(空)'}。应为 VCV 编号（变异汇总记录，如 VCV000065533）或 RCV 编号（变异-疾病关系记录，如 RCV000055723），可带版本号（如 VCV000065533.11）。`);
  }
  const kind = m[1].toUpperCase();
  const bare = `${kind}${m[2]}`;
  const requestedVersion = m[3] ? `.${m[3]}` : undefined;

  if (!acquireNcbi()) throw quotaError();
  let xml: string;
  try {
    xml = await fetchTextWithRetry(
      `${EUTILS}/efetch.fcgi?${eutilsParams({ db: 'clinvar', id: bare, rettype: kind === 'VCV' ? 'vcv' : 'clinvarset', retmode: 'xml' })}`,
      8000, 1, NCBI_HEADERS,
    );
  } catch (err) {
    throw mapClinvarError(err);
  }

  const entry = kind === 'VCV' ? extractVcvEntry(xml) : extractRcvEntry(xml);
  if (!entry) {
    // efetch 对非法/不存在编号返回 200 + <eFetchResult><ERROR>…</ERROR>：如实转述上游原文，不吞成「未找到」
    const errText = textOf(sanitizeXml(xml), 'ERROR');
    if (errText) {
      return emptyClinvarEnvelope(`ClinVar 无法返回「${bare}」的记录（上游响应：${errText.slice(0, 120)}）。请检查编号拼写与层级（VCV=变异汇总 / RCV=变异-疾病关系），或先用 clinvar_search 按基因或变异检索获取编号。`);
    }
    return emptyClinvarEnvelope(`ClinVar 无 ${kind} 记录「${bare}」。请检查编号拼写与层级（VCV=变异汇总 / RCV=变异-疾病关系），或先用 clinvar_search 按基因或变异检索获取编号。`);
  }

  const data: Record<string, unknown> = {
    results: [entry],
    total: 1,
    source: 'clinvar',
    build_version: CLINVAR_BUILD_VERSION,
  };
  if (requestedVersion && entry.version && requestedVersion !== entry.version) {
    data.note = `请求的版本 ${bare}${requestedVersion} 非最新（当前为 ${entry.vcv_accession}${entry.version}），已返回最新版本记录。`;
  }
  return { success: true, data };
}