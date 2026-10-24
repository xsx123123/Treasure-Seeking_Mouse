// tasks/store.ts：任务持久化抽象。接口 + Memory（测试/纯离线兜底）+ File（自托管落盘）+ Postgres（平台）。
// 约束：
// - 事件环形缓冲为进程内存，永不落盘/落库（delta 帧不落库红线）；
// - 状态迁移审计日志白名单：task_id + owner 哈希 + 状态 + 时间戳，绝无正文明文（spec 4.4 规则 2）；
// - 23505 唯一违例 → task_duplicate/session_busy 业务错误映射唯一确定（按 constraint 名）。
import { envGet, sleep, type Json } from '../shared.ts';
import {
  ACTIVE_STATUSES,
  TASK_EVENT_BUFFER_BYTES,
  TASK_EVENT_BUFFER_SIZE,
  TERMINAL_STATUSES,
  type ChatTask,
  type OwnerRef,
  type ProgressSnapshot,
  type TaskErrorKind,
  type TaskEvent,
  type TaskResult,
  type TaskStatus,
} from './types.ts';

/* ---------- 审计日志（白名单字段，无正文） ---------- */

function ownerHash(owner: OwnerRef): string {
  const s = `${owner.kind}:${owner.id}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function logTransition(taskId: string, owner: OwnerRef, from: string, to: string): void {
  console.info(`[seqout-chat/tasks] transition task=${taskId} owner=${ownerHash(owner)} ${from}->${to} at=${new Date().toISOString()}`);
}

/* ---------- 错误与迁移语义 ---------- */

export type CreateOutcome = 'ok' | 'task_duplicate' | 'session_busy';
export class TaskStoreError extends Error {
  code: 'task_duplicate' | 'session_busy';
  constructor(code: 'task_duplicate' | 'session_busy', message: string) {
    super(message);
    this.name = 'TaskStoreError';
    this.code = code;
  }
}

/** 合法迁移守卫：终态不可逆（仅允许终态 → expired 的清理迁移） */
export function isTransitionLegal(from: TaskStatus, to: TaskStatus): boolean {
  if (to === 'expired') return TERMINAL_STATUSES.includes(from) && from !== 'expired';
  if (TERMINAL_STATUSES.includes(from)) return false;
  return true;
}

/* ---------- TaskStore 接口（13 方法，design §2.1.2） ---------- */

export interface TaskStore {
  /** 创建任务；幂等/串行违例抛 TaskStoreError（task_duplicate/session_busy） */
  create(task: ChatTask): Promise<void>;
  getById(taskId: string): Promise<ChatTask | null>;
  getByOwnerQueueId(owner: OwnerRef, queueId: string): Promise<ChatTask | null>;
  /**
   * 条件迁移：当前状态 ∈ from 且迁移合法才生效；冲突返回 'conflict'（以存储中状态为准，防并发竞态）。
   * patch 携带同事务更新的字段（suspended/heartbeat/progress_snapshot 等）。
   */
  updateStatus(taskId: string, from: TaskStatus[], to: TaskStatus, patch?: Partial<Pick<ChatTask, 'suspended' | 'progress_snapshot' | 'heartbeat_at'>>): Promise<'ok' | 'conflict'>;
  /** 里程碑快照落库 + heartbeat 刷新 */
  saveSnapshot(taskId: string, snapshot: ProgressSnapshot, heartbeatAt: number): Promise<void>;
  /** 终态落定：result + status + finished_at + expires_at（expires_at 由 registry 计算单点传入），progress_snapshot 清空 */
  saveResult(taskId: string, fields: { status: TaskStatus; result: TaskResult; error: TaskErrorKind | null; finished_at: number; expires_at: number }): Promise<void>;
  /** 事件追加进进程内环形缓冲（每任务 200 帧 / 200KB，超限丢最旧） */
  appendEvents(taskId: string, events: TaskEvent[]): Promise<void>;
  /** 读 seq 水位之后的缓冲帧（升序） */
  readEventsSince(taskId: string, seq: number): Promise<TaskEvent[]>;
  /** 本身份任务列表：活跃态全量 + 终态未过期全量（list action 语义），created_at 降序 */
  listActiveByOwner(owner: OwnerRef, now?: number): Promise<ChatTask[]>;
  /** 活跃任务计数（并发上限判定） */
  countActiveByOwner(owner: OwnerRef): Promise<number>;
  /** 启动孤儿收口：instance_id ≠ 当前实例的 running/queued → failed/service_restart；返回标记数 */
  markOrphansFailed(instanceId: string, now?: number): Promise<number>;
  /** 懒清理：删除 expires_at 已过期的终态任务；返回删除数 */
  deleteExpired(now?: number): Promise<number>;
}

/* ---------- 环形缓冲（三实现共用的内存事件缓冲） ---------- */

class EventRing {
  private map = new Map<string, TaskEvent[]>();
  private bytes = new Map<string, number>();

  append(taskId: string, events: TaskEvent[]): void {
    if (!events.length) return;
    const list = this.map.get(taskId) ?? [];
    let size = this.bytes.get(taskId) ?? 0;
    for (const e of events) {
      const s = JSON.stringify(e.frame).length;
      list.push(e);
      size += s;
    }
    while (list.length > TASK_EVENT_BUFFER_SIZE || size > TASK_EVENT_BUFFER_BYTES) {
      const dropped = list.shift();
      if (!dropped) break;
      size -= JSON.stringify(dropped.frame).length;
    }
    this.map.set(taskId, list);
    this.bytes.set(taskId, size);
  }

  since(taskId: string, seq: number): TaskEvent[] {
    return (this.map.get(taskId) ?? []).filter((e) => e.seq > seq);
  }

  drop(taskId: string): void {
    this.map.delete(taskId);
    this.bytes.delete(taskId);
  }
}

/* ---------- MemoryTaskStore（离线测试 / 纯离线兜底） ---------- */

export class MemoryTaskStore implements TaskStore {
  protected tasks = new Map<string, ChatTask>();
  protected ring = new EventRing();

  private sweep(now = Date.now()): void {
    for (const [id, t] of this.tasks) {
      if (t.expires_at !== null && t.expires_at <= now && TERMINAL_STATUSES.includes(t.status)) {
        t.status = 'expired';
      }
    }
  }

  async create(task: ChatTask): Promise<void> {
    this.sweep();
    if (task.queue_id) {
      const dup = await this.getByOwnerQueueId(task.owner, task.queue_id);
      if (dup) throw new TaskStoreError('task_duplicate', `同 (owner, queue_id) 任务已存在: ${dup.task_id}`);
    }
    for (const t of this.tasks.values()) {
      if (t.owner.kind === task.owner.kind && t.owner.id === task.owner.id
        && t.session_ref === task.session_ref && ACTIVE_STATUSES.includes(t.status)) {
        throw new TaskStoreError('session_busy', `会话内已有活跃任务: ${t.task_id}`);
      }
    }
    this.tasks.set(task.task_id, structuredClone(task));
    logTransition(task.task_id, task.owner, '∅', task.status);
  }

  async getById(taskId: string): Promise<ChatTask | null> {
    this.sweep();
    const t = this.tasks.get(taskId);
    return t ? structuredClone(t) : null;
  }

  async getByOwnerQueueId(owner: OwnerRef, queueId: string): Promise<ChatTask | null> {
    this.sweep();
    for (const t of this.tasks.values()) {
      if (t.queue_id === queueId && t.owner.kind === owner.kind && t.owner.id === owner.id) return structuredClone(t);
    }
    return null;
  }

  async updateStatus(taskId: string, from: TaskStatus[], to: TaskStatus, patch: Partial<Pick<ChatTask, 'suspended' | 'progress_snapshot' | 'heartbeat_at'>> = {}): Promise<'ok' | 'conflict'> {
    this.sweep();
    const t = this.tasks.get(taskId);
    if (!t) return 'conflict';
    if (!from.includes(t.status) || !isTransitionLegal(t.status, to)) return 'conflict';
    const prev = t.status;
    t.status = to;
    if (patch.suspended !== undefined) t.suspended = patch.suspended;
    if (patch.progress_snapshot !== undefined) t.progress_snapshot = patch.progress_snapshot;
    if (patch.heartbeat_at !== undefined) t.heartbeat_at = patch.heartbeat_at;
    logTransition(taskId, t.owner, prev, to);
    return 'ok';
  }

  async saveSnapshot(taskId: string, snapshot: ProgressSnapshot, heartbeatAt: number): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t || !ACTIVE_STATUSES.includes(t.status)) return;
    t.progress_snapshot = structuredClone(snapshot);
    t.heartbeat_at = heartbeatAt;
  }

  async saveResult(taskId: string, fields: { status: TaskStatus; result: TaskResult; error: TaskErrorKind | null; finished_at: number; expires_at: number }): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const prev = t.status;
    t.status = fields.status;
    t.result = structuredClone(fields.result);
    t.error = fields.error;
    t.finished_at = fields.finished_at;
    t.expires_at = fields.expires_at;
    t.progress_snapshot = null;
    t.suspended = false;
    this.ring.drop(taskId);
    logTransition(taskId, t.owner, prev, fields.status);
  }

  async appendEvents(taskId: string, events: TaskEvent[]): Promise<void> {
    this.ring.append(taskId, events);
  }

  async readEventsSince(taskId: string, seq: number): Promise<TaskEvent[]> {
    return this.ring.since(taskId, seq);
  }

  async listActiveByOwner(owner: OwnerRef, now = Date.now()): Promise<ChatTask[]> {
    this.sweep(now);
    return [...this.tasks.values()]
      .filter((t) => t.owner.kind === owner.kind && t.owner.id === owner.id
        && (ACTIVE_STATUSES.includes(t.status) || (t.expires_at !== null && t.expires_at > now)))
      .sort((a, b) => b.created_at - a.created_at)
      .map((t) => structuredClone(t));
  }

  async countActiveByOwner(owner: OwnerRef): Promise<number> {
    this.sweep();
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.owner.kind === owner.kind && t.owner.id === owner.id && ACTIVE_STATUSES.includes(t.status)) n++;
    }
    return n;
  }

  async markOrphansFailed(instanceId: string, now = Date.now()): Promise<number> {
    let marked = 0;
    for (const t of this.tasks.values()) {
      if (ACTIVE_STATUSES.includes(t.status) && t.instance_id !== instanceId) {
        t.status = 'failed';
        t.error = 'service_restart';
        t.finished_at = now;
        t.suspended = false;
        marked++;
        logTransition(t.task_id, t.owner, 'running', 'failed');
      }
    }
    return marked;
  }

  async deleteExpired(now = Date.now()): Promise<number> {
    let n = 0;
    for (const [id, t] of this.tasks) {
      if (t.expires_at !== null && t.expires_at <= now) {
        this.tasks.delete(id);
        this.ring.drop(id);
        n++;
      }
    }
    return n;
  }
}

/* ---------- FileTaskStore（自托管落盘：DATA_DIR/tasks.json，tmp+rename 原子替换） ---------- */

interface TaskFileShape {
  version: 1;
  tasks: ChatTask[];
  instance_boot_at: string;
}

export class FileTaskStore extends MemoryTaskStore {
  private filePath: string;
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  /** 工厂：读文件恢复索引（缺失/损坏按空库启动并记日志）；启动 15s 防抖落盘定时器 */
  static async create(filePath: string): Promise<FileTaskStore> {
    const store = new FileTaskStore(filePath);
    const fs = await import('node:fs');
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as TaskFileShape;
      if (raw && raw.version === 1 && Array.isArray(raw.tasks)) {
        for (const t of raw.tasks) store.tasks.set(t.task_id, t);
        console.info(`[seqout-chat/tasks] 已恢复任务登记：${raw.tasks.length} 条 ← ${filePath}`);
      }
    } catch {
      console.info('[seqout-chat/tasks] 任务登记文件缺失或损坏，按空库启动');
    }
    store.timer = setInterval(() => { void store.flushIfDirty(); }, 15_000);
    store.timer.unref?.();
    return store;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  async flushIfDirty(): Promise<void> {
    if (!this.dirty) return;
    const fs = await import('node:fs');
    const payload: TaskFileShape = { version: 1, tasks: [...this.tasks.values()], instance_boot_at: new Date().toISOString() };
    const text = JSON.stringify(payload);
    if (text.length > 10 * 1024 * 1024) console.warn('[seqout-chat/tasks] tasks.json 体积超 10MB 护栏');
    try {
      fs.writeFileSync(this.filePath + '.tmp', text);
      fs.renameSync(this.filePath + '.tmp', this.filePath);
      this.dirty = false;
    } catch (err) {
      console.warn('[seqout-chat/tasks] 落盘失败：', (err as Error)?.message || err);
    }
  }

  override async create(task: ChatTask): Promise<void> {
    await super.create(task);
    this.markDirty();
  }

  override async updateStatus(taskId: string, from: TaskStatus[], to: TaskStatus, patch: Partial<Pick<ChatTask, 'suspended' | 'progress_snapshot' | 'heartbeat_at'>> = {}): Promise<'ok' | 'conflict'> {
    const r = await super.updateStatus(taskId, from, to, patch);
    if (r === 'ok') this.markDirty();
    return r;
  }

  override async saveSnapshot(taskId: string, snapshot: ProgressSnapshot, heartbeatAt: number): Promise<void> {
    await super.saveSnapshot(taskId, snapshot, heartbeatAt);
    this.markDirty();
  }

  override async saveResult(taskId: string, fields: { status: TaskStatus; result: TaskResult; error: TaskErrorKind | null; finished_at: number; expires_at: number }): Promise<void> {
    await super.saveResult(taskId, fields);
    this.markDirty();
  }

  override async markOrphansFailed(instanceId: string, now = Date.now()): Promise<number> {
    const n = await super.markOrphansFailed(instanceId, now);
    if (n) this.markDirty();
    return n;
  }

  override async deleteExpired(now = Date.now()): Promise<number> {
    const n = await super.deleteExpired(now);
    if (n) this.markDirty();
    return n;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flushIfDirty();
  }
}

/* ---------- PostgresTaskStore（平台形态：PostgREST + service_role） ---------- */

/**
 * 网络层说明：shared.ts 的 fetchWithRetry 在非 ok 时抛 `HTTP {status}` 丢弃响应体，
 * 而唯一约束违例（23505）语义在响应体内（protocols/client.ts 同款坑先例）——
 * 故本实现自建薄封装 pgFetch（仅对 429/5xx 做 ≤2 次退避重试，其余状态读体分类）。
 */
export class PostgresTaskStore implements TaskStore {
  private base: string;
  private key: string;
  private ring = new EventRing();

  constructor() {
    const url = envGet('SUPABASE_URL').replace(/\/+$/, '');
    const key = envGet('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) {
      throw new Error('PostgresTaskStore: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置（任务能力降级由 tasksEnabled 判定承接）');
    }
    this.base = `${url}/rest/v1/chat_tasks`;
    this.key = key;
  }

  private async pgFetch(path: string, init: { method: string; body?: string; prefer?: string }, retries = 2): Promise<{ status: number; body: Json; headers: Headers }> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(path, {
          method: init.method,
          signal: AbortSignal.timeout(8000),
          headers: {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json',
            ...(init.prefer ? { Prefer: init.prefer } : {}),
          },
          body: init.body,
        });
        if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const text = await resp.text();
        let body: Json = null;
        try { body = text ? (JSON.parse(text) as Json) : null; } catch { body = text; }
        return { status: resp.status, body, headers: resp.headers };
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /* 行 ↔ 领域对象 */
  private static rowToTask(row: Record<string, Json>): ChatTask {
    return {
      task_id: String(row.task_id),
      owner: { kind: String(row.owner_kind) as OwnerRef['kind'], id: String(row.owner_id) },
      session_ref: String(row.session_ref),
      queue_id: row.queue_id === null || row.queue_id === undefined ? null : String(row.queue_id),
      status: String(row.status) as TaskStatus,
      suspended: row.suspended === true,
      lang: row.lang === 'en' ? 'en' : 'zh',
      question_snapshot: row.question_snapshot as ChatTask['question_snapshot'],
      progress_snapshot: (row.progress_snapshot ?? null) as ChatTask['progress_snapshot'],
      result: (row.result ?? null) as ChatTask['result'],
      error: (row.error ?? null) as TaskErrorKind | null,
      instance_id: String(row.instance_id),
      heartbeat_at: Date.parse(String(row.heartbeat_at)),
      created_at: Date.parse(String(row.created_at)),
      finished_at: row.finished_at ? Date.parse(String(row.finished_at)) : null,
      expires_at: row.expires_at ? Date.parse(String(row.expires_at)) : null,
    };
  }

  private static taskToRow(task: ChatTask): Record<string, Json> {
    return {
      task_id: task.task_id,
      owner_kind: task.owner.kind,
      owner_id: task.owner.id,
      session_ref: task.session_ref,
      queue_id: task.queue_id,
      status: task.status,
      suspended: task.suspended,
      lang: task.lang,
      question_snapshot: task.question_snapshot as unknown as Json,
      progress_snapshot: task.progress_snapshot as unknown as Json,
      result: task.result as unknown as Json,
      error: task.error,
      instance_id: task.instance_id,
      heartbeat_at: new Date(task.heartbeat_at).toISOString(),
      finished_at: task.finished_at ? new Date(task.finished_at).toISOString() : null,
      expires_at: task.expires_at ? new Date(task.expires_at).toISOString() : null,
    };
  }

  /** 23505 唯一违例 → 业务错误（按 constraint 名单一映射） */
  private static mapUniqueViolation(body: Json): TaskStoreError | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as Record<string, Json>;
    if (b.code !== '23505') return null;
    const constraint = typeof b.constraint === 'string' ? b.constraint : String(b.message ?? '');
    if (constraint.includes('owner_queue')) return new TaskStoreError('task_duplicate', '同 (owner, queue_id) 任务已存在');
    return new TaskStoreError('session_busy', '会话内已有活跃任务');
  }

  async create(task: ChatTask): Promise<void> {
    await this.deleteExpired();
    const { status, body } = await this.pgFetch(this.base, { method: 'POST', body: JSON.stringify(PostgresTaskStore.taskToRow(task)) });
    if (status === 409) {
      const mapped = PostgresTaskStore.mapUniqueViolation(body);
      if (mapped) throw mapped;
    }
    if (status >= 400) throw new Error(`PostgresTaskStore create failed: HTTP ${status}`);
    logTransition(task.task_id, task.owner, '∅', task.status);
  }

  async getById(taskId: string): Promise<ChatTask | null> {
    const { status, body } = await this.pgFetch(`${this.base}?task_id=eq.${encodeURIComponent(taskId)}&limit=1`, { method: 'GET' });
    if (status >= 400) throw new Error(`PostgresTaskStore getById failed: HTTP ${status}`);
    const rows = Array.isArray(body) ? body : [];
    return rows.length ? PostgresTaskStore.rowToTask(rows[0] as Record<string, Json>) : null;
  }

  async getByOwnerQueueId(owner: OwnerRef, queueId: string): Promise<ChatTask | null> {
    const q = `owner_kind=eq.${owner.kind}&owner_id=eq.${encodeURIComponent(owner.id)}&queue_id=eq.${encodeURIComponent(queueId)}&limit=1`;
    const { status, body } = await this.pgFetch(`${this.base}?${q}`, { method: 'GET' });
    if (status >= 400) throw new Error(`PostgresTaskStore getByOwnerQueueId failed: HTTP ${status}`);
    const rows = Array.isArray(body) ? body : [];
    return rows.length ? PostgresTaskStore.rowToTask(rows[0] as Record<string, Json>) : null;
  }

  async updateStatus(taskId: string, from: TaskStatus[], to: TaskStatus, patch: Partial<Pick<ChatTask, 'suspended' | 'progress_snapshot' | 'heartbeat_at'>> = {}): Promise<'ok' | 'conflict'> {
    const fromCond = from.length === 1 ? `status=eq.${from[0]}` : `status=in.(${from.join(',')})`;
    const set: Record<string, Json> = { status: to };
    if (patch.suspended !== undefined) set.suspended = patch.suspended;
    if (patch.progress_snapshot !== undefined) set.progress_snapshot = patch.progress_snapshot as unknown as Json;
    if (patch.heartbeat_at !== undefined) set.heartbeat_at = new Date(patch.heartbeat_at).toISOString();
    const { status, body } = await this.pgFetch(
      `${this.base}?task_id=eq.${encodeURIComponent(taskId)}&${fromCond}`,
      { method: 'PATCH', body: JSON.stringify(set), prefer: 'return=representation' },
    );
    if (status === 409) {
      const mapped = PostgresTaskStore.mapUniqueViolation(body);
      if (mapped) throw mapped;
    }
    if (status >= 400) throw new Error(`PostgresTaskStore updateStatus failed: HTTP ${status}`);
    const rows = Array.isArray(body) ? body : [];
    if (rows.length === 0) return 'conflict';
    const row = rows[0] as Record<string, Json>;
    if (!isTransitionLegal(String(row.status === to ? from[0] : row.status) as TaskStatus, to)) return 'conflict';
    return 'ok';
  }

  async saveSnapshot(taskId: string, snapshot: ProgressSnapshot, heartbeatAt: number): Promise<void> {
    await this.pgFetch(`${this.base}?task_id=eq.${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ progress_snapshot: snapshot as unknown as Json, heartbeat_at: new Date(heartbeatAt).toISOString() }),
    });
  }

  async saveResult(taskId: string, fields: { status: TaskStatus; result: TaskResult; error: TaskErrorKind | null; finished_at: number; expires_at: number }): Promise<void> {
    const { status } = await this.pgFetch(`${this.base}?task_id=eq.${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: fields.status,
        result: fields.result as unknown as Json,
        error: fields.error,
        finished_at: new Date(fields.finished_at).toISOString(),
        expires_at: new Date(fields.expires_at).toISOString(),
        progress_snapshot: null,
        suspended: false,
      }),
    });
    if (status < 400) this.ring.drop(taskId);
  }

  async appendEvents(taskId: string, events: TaskEvent[]): Promise<void> {
    this.ring.append(taskId, events);
  }

  async readEventsSince(taskId: string, seq: number): Promise<TaskEvent[]> {
    return this.ring.since(taskId, seq);
  }

  async listActiveByOwner(owner: OwnerRef, now = Date.now()): Promise<ChatTask[]> {
    const iso = new Date(now).toISOString();
    const or = encodeURIComponent(`(status.in.(queued,running),and(status.in.(completed,failed,cancelled),expires_at.gt.${iso}))`);
    const q = `owner_kind=eq.${owner.kind}&owner_id=eq.${encodeURIComponent(owner.id)}&or=${or}&order=created_at.desc&limit=50`;
    const { status, body } = await this.pgFetch(`${this.base}?${q}`, { method: 'GET' });
    if (status >= 400) throw new Error(`PostgresTaskStore listActiveByOwner failed: HTTP ${status}`);
    return (Array.isArray(body) ? body : []).map((r) => PostgresTaskStore.rowToTask(r as Record<string, Json>));
  }

  async countActiveByOwner(owner: OwnerRef): Promise<number> {
    const q = `owner_kind=eq.${owner.kind}&owner_id=eq.${encodeURIComponent(owner.id)}&status=in.(${ACTIVE_STATUSES.join(',')})`;
    const { status, headers } = await this.pgFetch(`${this.base}?${q}&select=task_id`, { method: 'GET', prefer: 'count=exact' });
    if (status >= 400) throw new Error(`PostgresTaskStore countActiveByOwner failed: HTTP ${status}`);
    const range = headers.get('content-range');
    const total = range ? Number(range.split('/')[1]) : NaN;
    return Number.isFinite(total) ? total : 0;
  }

  async markOrphansFailed(instanceId: string, now = Date.now()): Promise<number> {
    const q = `status=in.(${ACTIVE_STATUSES.join(',')})&instance_id=neq.${encodeURIComponent(instanceId)}`;
    const { status, body } = await this.pgFetch(`${this.base}?${q}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', error: 'service_restart', finished_at: new Date(now).toISOString(), suspended: false }),
      prefer: 'return=representation',
    });
    if (status >= 400) throw new Error(`PostgresTaskStore markOrphansFailed failed: HTTP ${status}`);
    return Array.isArray(body) ? body.length : 0;
  }

  async deleteExpired(now = Date.now()): Promise<number> {
    const q = `expires_at=lt.${encodeURIComponent(new Date(now).toISOString())}`;
    const { status, body } = await this.pgFetch(`${this.base}?${q}`, { method: 'DELETE', prefer: 'return=representation' });
    if (status >= 400) return 0;
    return Array.isArray(body) ? body.length : 0;
  }
}