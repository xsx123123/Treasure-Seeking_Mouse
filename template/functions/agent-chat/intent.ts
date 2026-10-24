// intent.ts：意图中间表示（IR）的 schema、校验与归一化——纯框架，零领域内容。
//
// 背景：把「用户问题 → 结构化意图」落成显式 IR。模型经 intent_plan 工具产出意图 JSON，
// 本模块负责校验与归一化（纯函数、离线可测），归一化结果回灌模型作为后续工具参数的依据；
// 校验失败由调用方识别（判别联合 ok:false）并降级为无意图直连行为，绝不猜值。
//
// 领域词表与槽位定义全部外置于 intent-vocab.ts（单点），本文件只保留通用校验骨架。

import {
  INTENT_FILTER_SLOTS,
  INTENT_NEEDS_FLAG,
  INTENT_NEEDS_IMPLYING_TARGET,
  INTENT_TARGETS,
  type IntentFilterSlot,
  type IntentTarget,
} from './intent-vocab.ts';

export { INTENT_TARGETS };
export type { IntentTarget };

export interface ResearchIntent {
  /** 用户问题的一句话概括 */
  question: string;
  targets: IntentTarget[];
  /** 过滤槽位（由 intent-vocab.ts 的 INTENT_FILTER_SLOTS 定义；值恒为 string | boolean） */
  filters: Record<string, string | boolean>;
  /** needs 标志（字段名由 intent-vocab.ts 的 INTENT_NEEDS_FLAG 定义） */
  needs_reference: boolean;
}

/** 判别联合：ok:false 携带可读原因，调用方据此降级为无意图直连路径 */
export type ParseIntentResult =
  | { ok: true; intent: ResearchIntent; notes: string[] }
  | { ok: false; reason: string };

type NormalizeResult = { ok: true; value: string; note?: string } | { ok: false; reason: string };

/** 词表归一化：别名表（大小写不敏感）→ 规范值；未收录即 ok:false，不猜值 */
function normalizeByAlias(raw: string, aliases: Record<string, string>, label: string): NormalizeResult {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return { ok: false, reason: `${label} 为空` };
  const hit = aliases[v.toLowerCase()];
  if (hit) return { ok: true, value: hit, note: hit === v ? undefined : `${label}: ${v} → ${hit}` };
  return { ok: false, reason: `${label}「${v}」不在归一化词表内（合法取值见 intent-vocab.ts 的词表定义）` };
}

// ---------- IR 整体验证 ----------

const QUESTION_MAX = 500;
const FREETEXT_MAX = 120;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 自由文本槽位：截断+去空白，无词表校验；空串视为未提供 */
function freeText(raw: unknown, field: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  if (typeof raw !== 'string') return { ok: false, reason: `${field} 必须是字符串` };
  const v = raw.replace(/\s+/g, ' ').trim();
  if (!v) return { ok: true };
  return { ok: true, value: v.slice(0, FREETEXT_MAX) };
}

/** 按槽位定义校验单个 filter 值；返回 [值, note] 或失败原因 */
function validateSlot(slot: IntentFilterSlot, raw: unknown): { ok: true; value?: string | boolean; note?: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  if (slot.kind === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, reason: `filters.${slot.key} 必须是布尔值` };
    return { ok: true, value: raw };
  }
  if (typeof raw !== 'string') return { ok: false, reason: `filters.${slot.key} 必须是字符串` };
  if (slot.kind === 'freetext') {
    const t = freeText(raw, `filters.${slot.key}`);
    if (t.ok === false) return { ok: false, reason: t.reason };
    return { ok: true, value: t.value };
  }
  const n = normalizeByAlias(raw, slot.aliases ?? {}, `filters.${slot.key}`);
  if (n.ok === false) return { ok: false, reason: n.reason };
  return { ok: true, value: n.value, note: n.note };
}

/**
 * 校验并归一化模型产出的意图 JSON。
 * 严格项（任一失败整体 ok:false，调用方降级）：question 必填非空、targets 为已知目标非空数组、
 * 枚举槽位若提供必须可归一化、布尔槽位与 needs 标志必须是真布尔、未知 filter 键拒绝。
 * 宽松项：filters 可整体缺省或为空对象；自由文本槽位截断透传。
 * 一致性修正（记 notes 不判负）：targets 含 INTENT_NEEDS_IMPLYING_TARGET 时强制 needs 标志=true。
 */
export function parseResearchIntent(raw: unknown): ParseIntentResult {
  if (!isPlainObject(raw)) return { ok: false, reason: '意图不是 JSON 对象' };
  const notes: string[] = [];

  const questionRaw = raw.question;
  if (typeof questionRaw !== 'string' || !questionRaw.trim()) return { ok: false, reason: 'question 缺失或为空' };
  const question = questionRaw.replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX);

  const targetsRaw = raw.targets;
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) return { ok: false, reason: `targets 必须是非空数组（取值 ${INTENT_TARGETS.join('/')}）` };
  const targets: IntentTarget[] = [];
  for (const t of targetsRaw) {
    if (typeof t !== 'string' || !(INTENT_TARGETS as readonly string[]).includes(t)) {
      return { ok: false, reason: `targets 含未知目标「${String(t)}」（取值 ${INTENT_TARGETS.join('/')}）` };
    }
    if (!targets.includes(t as IntentTarget)) targets.push(t as IntentTarget);
  }

  const filtersRaw = raw.filters;
  if (filtersRaw !== undefined && filtersRaw !== null && !isPlainObject(filtersRaw)) {
    return { ok: false, reason: 'filters 必须是对象' };
  }
  const f = (filtersRaw ?? {}) as Record<string, unknown>;
  const filters: Record<string, string | boolean> = {};

  // 未知 filter 键拒绝：防止模型自造槽位（框架对词表外输入零容忍）
  const knownKeys = INTENT_FILTER_SLOTS.map((s) => s.key);
  for (const key of Object.keys(f)) {
    if (!knownKeys.includes(key)) return { ok: false, reason: `filters 含未知槽位「${key}」（合法槽位 ${knownKeys.join('/')}）` };
  }
  for (const slot of INTENT_FILTER_SLOTS) {
    const result = validateSlot(slot, f[slot.key]);
    if (result.ok === false) return { ok: false, reason: result.reason };
    if (result.value !== undefined) filters[slot.key] = result.value;
    if (result.note) notes.push(result.note);
  }

  const needsRaw = raw[INTENT_NEEDS_FLAG];
  if (typeof needsRaw !== 'boolean') return { ok: false, reason: `${INTENT_NEEDS_FLAG} 必须是布尔值` };
  let needs = needsRaw;
  if (INTENT_NEEDS_IMPLYING_TARGET && targets.includes(INTENT_NEEDS_IMPLYING_TARGET) && !needs) {
    needs = true; // 目标含参考资料库却标不需要，以前者为准
    notes.push(`${INTENT_NEEDS_FLAG}: false → true（targets 含 ${INTENT_NEEDS_IMPLYING_TARGET}）`);
  }

  return { ok: true, intent: { question, targets, filters, needs_reference: needs }, notes };
}