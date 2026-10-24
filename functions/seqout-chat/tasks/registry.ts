// tasks/registry.ts：归属校验、并发上限、幂等防重、过期清理、孤儿标记的单点。
// 红线：四个校验点（创建/续传/拉取/取消）的归属比较统一走 ownerEquals 单点；
// 归属不符一律由调用方映射为 404 not_found（与「不存在」无区分，spec 5.3.1 规则 5）。
import { envGet } from '../shared.ts';
import {
  ACTIVE_STATUSES,
  TASK_HARD_TIMEOUT_MS,
  TASK_MAX_CONCURRENT_PER_OWNER,
  TASK_RESULT_TTL_MS,
  TERMINAL_STATUSES,
  type ChatTask,
  type OwnerRef,
} from './types.ts';
import { TaskStoreError, type TaskStore } from './store.ts';

/* ---------- 配置读取单点（design §2.4 红线：禁多点定义） ---------- */

/** 单身份并发活跃任务上限（TASK_MAX_CONCURRENT_PER_OWNER，1–10 钳制，默认 3） */
export function maxConcurrentPerOwner(): number {
  const n = Number(envGet('TASK_MAX_CONCURRENT_PER_OWNER'));
  if (!Number.isFinite(n) || n <= 0) return TASK_MAX_CONCURRENT_PER_OWNER;
  return Math.min(10, Math.max(1, Math.floor(n)));
}

/** 终态结果保留窗口（TASK_RESULT_TTL_MS，≥1h 钳制，默认 24h） */
export function resultTtlMs(): number {
  const n = Number(envGet('TASK_RESULT_TTL_MS'));
  if (!Number.isFinite(n) || n <= 0) return TASK_RESULT_TTL_MS;
  return Math.max(3_600_000, Math.floor(n));
}

/** 任务硬超时（TASK_HARD_TIMEOUT_MS，≥60s 钳制，默认 30min） */
export function hardTimeoutMs(): number {
  const n = Number(envGet('TASK_HARD_TIMEOUT_MS'));
  if (!Number.isFinite(n) || n <= 0) return TASK_HARD_TIMEOUT_MS;
  return Math.max(60_000, Math.floor(n));
}

/** 终态时刻 → expires_at 计算单点 */
export function computeExpiresAt(finishedAt: number): number {
  return finishedAt + resultTtlMs();
}

/** suspended/活跃任务的硬超时判定（纯函数，注入 now）：累计时长超上限即不再续跑 */
export function isHardTimedOut(task: Pick<ChatTask, 'created_at'>, now: number): boolean {
  return now - task.created_at > hardTimeoutMs();
}

/* ---------- 归属解析与比较（单点） ---------- */

/**
 * 三类身份折叠为 OwnerRef：
 * - 平台登录用户：verifiedActor（Supabase auth 核验结果）→ supabase_user
 * - 自托管本地账号：Node 桥 chat-access 核验后写 x-stats-actor=账号 id 并加 x-account-kind=local → local_account
 * - 游客：x-stats-actor 头原值（设备指纹，与排行榜身份源同源）→ guest_device
 * 无身份返回 null（public 模式下裸无头请求）。
 */
export function resolveOwner(req: Request, verifiedActor: string | null): OwnerRef | null {
  if (verifiedActor) return { kind: 'supabase_user', id: verifiedActor };
  const actor = req.headers.get('x-stats-actor');
  if (!actor) return null;
  const kind = req.headers.get('x-account-kind') === 'local' ? 'local_account' : 'guest_device';
  return { kind, id: actor };
}

/** 归属一致性比较唯一实现（四校验点共用） */
export function ownerEquals(a: OwnerRef, b: OwnerRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/* ---------- 创建前置校验（四连） ---------- */

export type CreatePrecheck =
  | { ok: true }
  | { ok: false; error: 'task_limit' | 'session_busy' }
  | { ok: false; error: 'task_duplicate'; existing: ChatTask };

/**
 * 创建前置四连校验：
 * ① 归属必填（owner null 由调用方提前拒绝）② 并发上限 → task_limit
 * ③ queue_id 幂等命中 → 返回既有任务（调用方转 resume/result，不新建）
 * ④ 会话内串行 → session_busy
 */
export async function createPrecheck(store: TaskStore, owner: OwnerRef, queueId: string | null, sessionRef: string): Promise<CreatePrecheck> {
  if (queueId) {
    const existing = await store.getByOwnerQueueId(owner, queueId);
    if (existing) return { ok: false, error: 'task_duplicate', existing };
  }
  const active = await store.countActiveByOwner(owner);
  if (active >= maxConcurrentPerOwner()) return { ok: false, error: 'task_limit' };
  const siblings = await store.listActiveByOwner(owner);
  if (siblings.some((t) => t.session_ref === sessionRef && ACTIVE_STATUSES.includes(t.status))) {
    return { ok: false, error: 'session_busy' };
  }
  return { ok: true };
}

/* ---------- 取消（幂等）与任务级中止信号登记 ---------- */

/** runner 登记的任务级取消钩子（触发主循环下一检查点退出） */
const cancelHooks = new Map<string, () => void>();

export function registerCancelHook(taskId: string, hook: () => void): void {
  cancelHooks.set(taskId, hook);
}

export function unregisterCancelHook(taskId: string): void {
  cancelHooks.delete(taskId);
}

/**
 * 幂等取消：已终态直接返回当前终态（零副作用）；running/queued 触发取消钩子，
 * 实际状态迁移由 runner 检查点收口（已产出部分落库，status=cancelled error='aborted'）。
 * 归属不符/不存在返回 null（调用方映射 404）。
 */
export async function cancelTask(store: TaskStore, taskId: string, owner: OwnerRef): Promise<ChatTask | null> {
  const task = await store.getById(taskId);
  if (!task || !ownerEquals(task.owner, owner)) return null;
  if (TERMINAL_STATUSES.includes(task.status)) return task;
  cancelHooks.get(taskId)?.();
  return task;
}

/* ---------- 过期清理（懒清理）与孤儿标记 ---------- */

/** 懒清理封装：任何访问路径顺手删过期终态任务（spec 5.3.1 规则 6） */
export async function sweepExpired(store: TaskStore): Promise<number> {
  try {
    return await store.deleteExpired();
  } catch (err) {
    console.warn('[seqout-chat/tasks] 懒清理失败：', (err as Error)?.message || err);
    return 0;
  }
}

/**
 * 启动孤儿收口：store 中 running/queued 且 instance_id ≠ 当前实例 → failed/service_restart。
 * 内部 catch 永不抛出；返回标记数。
 */
export async function markOrphansOnBoot(store: TaskStore, instanceId: string): Promise<number> {
  try {
    const marked = await store.markOrphansFailed(instanceId);
    if (marked) console.info(`[seqout-chat/tasks] 启动孤儿收口：${marked} 个 running/queued 任务标记 failed/service_restart`);
    return marked;
  } catch (err) {
    console.warn('[seqout-chat/tasks] 孤儿标记失败（不阻断启动）：', (err as Error)?.message || err);
    return 0;
  }
}

export { TaskStoreError };