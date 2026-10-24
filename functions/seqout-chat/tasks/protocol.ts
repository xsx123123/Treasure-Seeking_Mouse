// tasks/protocol.ts：task/snapshot 帧构造解析与 resume/result 载荷组装的纯函数层（零网络零 IO）。
// 协议只加不改：本模块只定义新增帧；既有 delta/tool/cards/grounding/end/error/[DONE]/心跳语义冻结。
// 校验模式对齐 intent.ts parseResearchIntent：判别联合收窄，未知值一律失败不猜。
import type { Json } from '../shared.ts';
import {
  TASK_EVENT_NAMES,
  type ChatTask,
  type TaskErrorKind,
  type TaskEvent,
  type TaskStatus,
  type ToolLogEntry,
} from './types.ts';

/* ---------- 帧载荷类型（SSE 下行新增帧） ---------- */

export interface TaskEventFrame {
  event: typeof TASK_EVENT_NAMES.task;
  task_id: string;
  status: TaskStatus;
  session_ref?: string;
  queue_id?: string;
  error?: TaskErrorKind;
  seq?: number;
}

export interface SnapshotFrame {
  event: typeof TASK_EVENT_NAMES.snapshot;
  task_id: string;
  /** 快照水位：其后帧 seq 严格大于此值 */
  seq: number;
  content: string;
  cards: Json[];
  tools: ToolLogEntry[];
  grounding?: Json;
  boost?: { accession: string | null };
  /** 语义锚：快照只描述进行中任务；终态走 result 载荷 */
  completion: 'running';
}

export interface ResultPayload {
  task_id: string;
  status: TaskStatus;
  message?: {
    content: string;
    cards: Json[];
    toolLogs: ToolLogEntry[];
    grounding?: Json;
    boost?: { accession: string | null };
    error?: string;
  };
  session_ref?: string;
  finished_at?: string;
}

/* ---------- 校验辅助 ---------- */

const STATUS_SET: ReadonlySet<string> = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'expired']);
const ERROR_SET: ReadonlySet<string> = new Set(['llm_error', 'timeout', 'aborted', 'service_restart']);

function assertStatus(v: string): TaskStatus {
  if (!STATUS_SET.has(v)) throw new Error(`taskFrame: 未知 status "${v}"`);
  return v as TaskStatus;
}
function assertErrorKind(v: string): TaskErrorKind {
  if (!ERROR_SET.has(v)) throw new Error(`taskFrame: 未知 error "${v}"`);
  return v as TaskErrorKind;
}

/* ---------- ① task 帧构造 ---------- */

export function taskFrame(args: {
  task_id: string;
  status: string;
  session_ref?: string;
  queue_id?: string;
  error?: string;
  seq?: number;
}): TaskEventFrame {
  const status = assertStatus(args.status);
  const frame: TaskEventFrame = { event: TASK_EVENT_NAMES.task, task_id: args.task_id, status };
  if ((status === 'failed' || status === 'cancelled') && !args.error) {
    throw new Error(`taskFrame: status=${status} 时 error 必填`);
  }
  if (args.error) frame.error = assertErrorKind(args.error);
  if (args.session_ref) frame.session_ref = args.session_ref;
  if (args.queue_id) frame.queue_id = args.queue_id;
  if (typeof args.seq === 'number') frame.seq = args.seq;
  return frame;
}

/* ---------- ② snapshot 帧构造 ---------- */

export function snapshotFrame(args: {
  task_id: string;
  seq: number;
  content: string;
  cards: Json[];
  tools: ToolLogEntry[];
  grounding?: Json | null;
  boost?: { accession: string | null } | null;
}): SnapshotFrame {
  const frame: SnapshotFrame = {
    event: TASK_EVENT_NAMES.snapshot,
    task_id: args.task_id,
    seq: args.seq,
    content: args.content,
    cards: args.cards,
    tools: args.tools,
    completion: 'running',
  };
  if (args.grounding) frame.grounding = args.grounding;
  if (args.boost) frame.boost = args.boost;
  return frame;
}

/* ---------- ③ 续传流首段组装：snapshot 帧 + seq 水位大于快照的缓冲帧 ---------- */

export function buildResumeHead(task: ChatTask, bufferedEvents: TaskEvent[]): Json[] {
  const snap = task.progress_snapshot;
  const head = snapshotFrame({
    task_id: task.task_id,
    seq: snap?.seq ?? 0,
    content: snap?.content ?? '',
    cards: snap?.cards ?? [],
    tools: snap?.tools ?? [],
    grounding: (snap?.grounding ?? null) as Json | null,
    boost: snap?.boost ?? null,
  });
  const watermark = snap?.seq ?? 0;
  const tail = bufferedEvents.filter((e) => e.seq > watermark).map((e) => e.frame);
  return [head as unknown as Json, ...tail];
}

/* ---------- ④ 结果拉取载荷组装（等价 end 帧累积 + 消息元信息；expired 态 message 缺省） ---------- */

export function buildResultPayload(task: ChatTask): ResultPayload {
  const payload: ResultPayload = { task_id: task.task_id, status: task.status };
  if (task.status === 'expired') return payload;
  if (task.session_ref) payload.session_ref = task.session_ref;
  if (task.finished_at) payload.finished_at = new Date(task.finished_at).toISOString();
  const r = task.result;
  if (r) {
    payload.message = {
      content: r.content,
      cards: r.cards,
      toolLogs: r.toolLogs,
    };
    if (r.grounding) payload.message.grounding = r.grounding as unknown as Json;
    if (r.boost) payload.message.boost = r.boost;
    if (r.error) payload.message.error = r.error;
  }
  return payload;
}

/* ---------- ⑤ 卡片合并的服务端极简版（与前端 cardIdentity/mergeCards 同规则；跨端零 import） ---------- */

function metaOf(card: Json): Record<string, string> {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return {};
  const m = (card as Record<string, Json>).meta;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m as Record<string, Json>)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

function str(v: Json | undefined): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function cardIdentityOf(card: Json): string {
  const c = (card && typeof card === 'object' && !Array.isArray(card) ? card : {}) as Record<string, Json>;
  const m = metaOf(card);
  const source = m.source ?? 'omics';
  const accession = str(c.accession);
  if (source === 'variant') {
    const fallback = [accession, m.chr ?? '', m.pos ?? '', m.ref ?? '', m.alt ?? ''].join(':');
    return `variant:${m.assembly ?? ''}:${m.variant_id || fallback}`;
  }
  if (source === 'gene') {
    return `gene:${m.taxid || m.species || ''}:${m.entrez_gene_id || m.ensembl_gene_id || accession}`;
  }
  if (source === 'literature') {
    const doi = (m.doi ?? '').toLowerCase();
    return `literature:${doi || m.pmid || `${m.literature_source ?? ''}:${accession}`}`;
  }
  return `${source}:${accession ? accession.toUpperCase() : JSON.stringify([c.tool ?? '', c.title ?? '', c.summary ?? '', m])}`;
}

/** 同前端 mergeCards：按身份键去重，新卡覆盖旧卡但保留旧卡非空 title/summary/meta（空值不覆盖） */
export function mergeCardsForSnapshot(previous: Json[], incoming: Json[]): Json[] {
  const map = new Map(previous.map((c) => [cardIdentityOf(c), c]));
  for (const card of incoming) {
    const key = cardIdentityOf(card);
    const old = map.get(key);
    if (!old) {
      map.set(key, card);
      continue;
    }
    const o = old as Record<string, Json>;
    const n = card as Record<string, Json>;
    const mergedMeta = { ...metaOf(old) };
    for (const [k, v] of Object.entries(metaOf(card))) {
      if (v !== '') mergedMeta[k] = v;
    }
    map.set(key, {
      ...o,
      ...n,
      title: str(n.title) || str(o.title),
      summary: str(n.summary) || str(o.summary),
      meta: mergedMeta,
    });
  }
  return [...map.values()];
}