// tasks/index.ts：任务模块单点出口（对齐 protocols/index.ts 契约范式）。
// 导出六项：tasksEnabled / TASKS_CAPABILITIES / handleTaskAction / createTaskWithRunner /
// markOrphansOnBoot / resolveOwner。模块红线：禁止反向 import 主文件 index.ts。
import type { Json } from '../shared.ts';
import { envGet } from '../shared.ts';
import type { ChatLoopDeps, ChatTask, OwnerRef, TaskStatus } from './types.ts';
import { buildResultPayload, buildResumeHead, taskFrame } from './protocol.ts';
import {
  cancelTask as registryCancelTask,
  createPrecheck,
  isHardTimedOut,
  markOrphansOnBoot as registryMarkOrphans,
  maxConcurrentPerOwner,
  ownerEquals,
  resolveOwner as registryResolveOwner,
  sweepExpired,
  computeExpiresAt,
} from './registry.ts';
import { MemoryTaskStore, PostgresTaskStore, TaskStoreError, type TaskStore } from './store.ts';
import { TaskRunner } from './runner.ts';

/* ---------- 模块级装配态 ---------- */

let storeInstance: TaskStore | null = null;
let runtimeKind: 'node' | 'edge' = 'edge';
let instanceId = '';
let edgeWaitUntilFn: ((p: Promise<unknown>) => void) | null = null;
let systemPromptFn: ((lang: 'zh' | 'en') => string) | null = null;
let depsFactory: ((model: string, req: Request) => ChatLoopDeps) | null = null;

/** 内存中活跃 runner 注册表（同 isolate/进程内的实时订阅源） */
const activeRunners = new Map<string, TaskRunner>();

/**
 * 装配（启动时调用一次）：
 * - Node 自托管：local.mjs 传入 FileTaskStore 实例 + runtime='node'
 * - 平台 Edge：不传 store（惰性构造 PostgresTaskStore）+ runtime='edge' + edgeWaitUntil/systemPrompt/depsFactory
 */
export function configureTasks(args: {
  store?: TaskStore;
  runtime: 'node' | 'edge';
  instanceId: string;
  edgeWaitUntil?: ((p: Promise<unknown>) => void) | null;
  systemPromptFor?: (lang: 'zh' | 'en') => string;
  depsFactory?: (model: string, req: Request) => ChatLoopDeps;
}): void {
  if (args.store) storeInstance = args.store;
  runtimeKind = args.runtime;
  instanceId = args.instanceId;
  edgeWaitUntilFn = args.edgeWaitUntil ?? null;
  systemPromptFn = args.systemPromptFor ?? null;
  depsFactory = args.depsFactory ?? null;
}

function store(): TaskStore | null {
  if (storeInstance) return storeInstance;
  if (runtimeKind === 'edge' && envGet('SUPABASE_URL') && envGet('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      storeInstance = new PostgresTaskStore();
    } catch (err) {
      console.warn('[seqout-chat/tasks] PostgresTaskStore 初始化失败：', (err as Error)?.message || err);
    }
  }
  return storeInstance;
}

/** 能力探测：自托管 Node=已装配 store / 平台=service_role key 存在 / 纯离线=false。永不抛 */
export function tasksEnabled(): boolean {
  return store() !== null;
}

export const TASKS_CAPABILITIES = { tasks: true, get task_max_concurrent() { return maxConcurrentPerOwner(); } };

export const resolveOwner = registryResolveOwner;

/** 启动孤儿收口（内部取 store 单例 + instanceId；内部 catch 不阻断启动，返回标记数） */
export async function bootMarkOrphans(): Promise<number> {
  const s = store();
  if (!s) return 0;
  return registryMarkOrphans(s, instanceId);
}

/* ---------- 通用辅助 ---------- */

function jsonResponse(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sseResponseFrom(subscribe: (write: (f: Json) => void, close: () => void) => void): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
      }, 10_000);
      const write = (f: Json) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`)); } catch { /* closed */ }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } catch { /* closed */ }
      };
      subscribe(write, close);
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}

/** 任务摘要（list 响应形态：轻量、无正文快照） */
function taskSummary(t: ChatTask): Json {
  return {
    task_id: t.task_id,
    session_ref: t.session_ref,
    status: t.status,
    queue_id: t.queue_id,
    created_at: new Date(t.created_at).toISOString(),
    finished_at: t.finished_at ? new Date(t.finished_at).toISOString() : null,
    error: t.error,
  };
}

/** 唤醒 suspended 任务续跑（Edge 由 waitUntil 承接 / Node 进程内直接续跑） */
function resumeSuspended(task: ChatTask, req: Request): void {
  const s = store();
  if (!s || !depsFactory || !systemPromptFn) return;
  if (isHardTimedOut(task, Date.now())) {
    const finishedAt = Date.now();
    void s.saveResult(task.task_id, {
      status: 'failed',
      result: { content: task.progress_snapshot?.content ?? '', cards: task.progress_snapshot?.cards ?? [], toolLogs: task.progress_snapshot?.tools ?? [], grounding: task.progress_snapshot?.grounding ?? null, boost: task.progress_snapshot?.boost ?? null, error: '任务执行超时' },
      error: 'timeout',
      finished_at: finishedAt,
      expires_at: computeExpiresAt(finishedAt),
    });
    return;
  }
  const runner = new TaskRunner({
    task,
    store: s,
    deps: depsFactory(task.question_snapshot.model ?? '', req),
    runtime: runtimeKind,
    budgetStartedAt: Date.now(),
    edgeWaitUntil: edgeWaitUntilFn,
    systemPromptFor: systemPromptFn,
  });
  activeRunners.set(task.task_id, runner);
  const p = runner.run().finally(() => activeRunners.delete(task.task_id));
  if (runtimeKind === 'edge' && edgeWaitUntilFn) edgeWaitUntilFn(p);
  else void p;
}

/* ---------- action 分派（鉴权之后调用，红线） ---------- */

export async function handleTaskAction(body: Record<string, Json | undefined>, req: Request, verifiedActor: string | null): Promise<Response> {
  const action = typeof body.action === 'string' ? body.action : '';
  const owner = registryResolveOwner(req, verifiedActor);
  if (!owner) return jsonResponse({ error: 'owner_required' }, 400);
  const s = store();
  if (!s) return jsonResponse({ error: 'tasks_unavailable' }, 503);
  await sweepExpired(s);

  if (action === 'list') {
    const tasks = await s.listActiveByOwner(owner);
    // 副作用：suspended 任务逐个唤醒续跑（Edge 语义；list 是用户行为自然触发点，非轮询保活）
    for (const t of tasks) {
      if (t.status === 'running' && t.suspended && !activeRunners.has(t.task_id)) {
        const resumed = { ...t, suspended: false };
        const migrated = await s.updateStatus(t.task_id, ['running'], 'running', { suspended: false, heartbeat_at: Date.now() });
        if (migrated === 'ok') resumeSuspended(resumed, req);
      }
    }
    return jsonResponse({ tasks: tasks.map(taskSummary) as unknown as Json });
  }

  const taskId = typeof body.task_id === 'string' ? body.task_id : '';
  if (!taskId) return jsonResponse({ error: 'task_id required' }, 400);
  const task = await s.getById(taskId);
  // 归属不符与不存在无区分（无信息泄露）
  if (!task || !ownerEquals(task.owner, owner)) return jsonResponse({ error: 'not_found' }, 404);

  if (action === 'cancel') {
    const t = await registryCancelTask(s, taskId, owner);
    if (!t) return jsonResponse({ error: 'not_found' }, 404);
    activeRunners.get(taskId)?.cancel();
    const after = await s.getById(taskId);
    return jsonResponse({ task_id: taskId, status: (after ?? t).status });
  }

  if (action === 'result') {
    // 进行中：告知状态，前端转 resume（非流式一次性响应只服务终态）
    if (task.status === 'running' || task.status === 'queued') {
      return jsonResponse({ task_id: taskId, status: task.status });
    }
    return jsonResponse(buildResultPayload(task) as unknown as Json);
  }

  if (action === 'resume') {
    // 竞态收口：已终态 → 直接 result JSON
    if (task.status !== 'running' && task.status !== 'queued') {
      return jsonResponse(buildResultPayload(task) as unknown as Json);
    }
    // suspended 唤醒（内存无 runner 时）
    let live = activeRunners.get(taskId);
    if (!live && task.suspended) {
      const migrated = await s.updateStatus(taskId, ['running'], 'running', { suspended: false, heartbeat_at: Date.now() });
      if (migrated === 'ok') {
        resumeSuspended({ ...task, suspended: false }, req);
        live = activeRunners.get(taskId);
      }
    }
    const snapSeq = task.progress_snapshot?.seq ?? 0;
    const buffered = await s.readEventsSince(taskId, snapSeq);
    const head = buildResumeHead(task, buffered);
    return sseResponseFrom((write, close) => {
      // 时序：先挂订阅收 pending → 重放 head（snapshot + 缓冲帧）→ flush pending（seq 去重衔接）
      let lastSeq = 0;
      let flushing = true;
      const pending: Json[] = [];
      let unsubscribe: () => void = () => {};
      const writeDedup = (f: Json) => {
        const fr = f as Record<string, Json>;
        const seq = typeof fr.seq === 'number' ? fr.seq : null;
        if (seq !== null && seq <= lastSeq) return;
        if (seq !== null) lastSeq = seq;
        write(f);
        if (fr.event === 'task' && typeof fr.status === 'string' && ['completed', 'failed', 'cancelled', 'expired'].includes(fr.status)) {
          unsubscribe();
          close();
        }
      };
      const liveRunner = activeRunners.get(taskId);
      if (liveRunner) unsubscribe = liveRunner.subscribe((f) => { if (flushing) pending.push(f); else writeDedup(f); });
      for (const f of head) writeDedup(f);
      for (const f of pending) writeDedup(f);
      pending.length = 0;
      flushing = false;
      if (!liveRunner || liveRunner.isFinished) {
        // 跨 isolate/进程边界（任务在他处执行）或已终态：下发快照后收口（不轮询；终态经 list/result 获取）
        unsubscribe();
        close();
      }
    });
  }

  return jsonResponse({ error: 'unknown_action' }, 400);
}

/* ---------- 创建任务（对话请求的任务化路径） ---------- */

export async function createTaskWithRunner(args: {
  messages: { role: string; content: string | null }[];
  question: string;
  model: string;
  lang: 'zh' | 'en';
  queueId?: string;
  sessionRef?: string;
  owner: OwnerRef;
  req: Request;
  deps: ChatLoopDeps;
}): Promise<Response> {
  const s = store();
  if (!s) return jsonResponse({ error: 'tasks_unavailable' }, 503);
  await sweepExpired(s);
  const sessionRef = args.sessionRef ?? '';
  const queueId = args.queueId ?? null;

  // 创建前置四连校验（幂等命中转 resume/result，不新建）
  const precheck = await createPrecheck(s, args.owner, queueId, sessionRef);
  if (!precheck.ok) {
    if (precheck.error === 'task_duplicate' && 'existing' in precheck) {
      const existing = precheck.existing;
      if (existing.status === 'running' || existing.status === 'queued') {
        return handleTaskAction({ action: 'resume', task_id: existing.task_id }, args.req, args.owner.kind === 'supabase_user' ? args.owner.id : null);
      }
      return jsonResponse(buildResultPayload(existing) as unknown as Json);
    }
    return jsonResponse({ error: precheck.error }, 409);
  }

  const now = Date.now();
  const task: ChatTask = {
    task_id: crypto.randomUUID(),
    owner: args.owner,
    session_ref: sessionRef,
    queue_id: queueId,
    status: 'running',
    suspended: false,
    lang: args.lang,
    question_snapshot: {
      content: args.question,
      history: args.messages.map((m) => ({ role: m.role, content: m.content })),
      model: args.model,
    },
    progress_snapshot: null,
    result: null,
    error: null,
    instance_id: instanceId,
    heartbeat_at: now,
    created_at: now,
    finished_at: null,
    expires_at: null,
  };
  try {
    await s.create(task);
  } catch (err) {
    if (err instanceof TaskStoreError) return jsonResponse({ error: err.code }, 409);
    throw err;
  }

  const runner = new TaskRunner({
    task,
    store: s,
    deps: args.deps,
    runtime: runtimeKind,
    budgetStartedAt: now,
    edgeWaitUntil: edgeWaitUntilFn,
    systemPromptFor: systemPromptFn ?? undefined,
  });
  activeRunners.set(task.task_id, runner);
  const runPromise = runner.run().finally(() => activeRunners.delete(task.task_id));
  // 双形态承接：Edge=waitUntil 尽力推进；Node=进程内真后台
  if (runtimeKind === 'edge' && edgeWaitUntilFn) edgeWaitUntilFn(runPromise);
  else void runPromise;

  // 响应 SSE：订阅任务帧；客户端断连仅退订，任务继续（断连存续语义）。
  // 时序保证（首帧 task 帧先于首 delta）：runner 已启动，先挂订阅收集 pending，
  // 再按 seq 重放缓冲帧补齐，最后 flush pending——缓冲与实时帧严格按 seq 衔接不丢不重。
  return sseResponseFrom((write, close) => {
    let lastSeq = 0;
    let flushing = true;
    const pending: Json[] = [];
    const writeDedup = (f: Json) => {
      const fr = f as Record<string, Json>;
      const seq = typeof fr.seq === 'number' ? fr.seq : null;
      if (seq !== null && seq <= lastSeq) return;
      if (seq !== null) lastSeq = seq;
      write(f);
      if (fr.event === 'task' && typeof fr.status === 'string' && ['completed', 'failed', 'cancelled', 'expired'].includes(fr.status)) {
        unsubscribe();
        close();
      }
    };
    const unsubscribe = runner.subscribe((f) => { if (flushing) pending.push(f); else writeDedup(f); });
    void s.readEventsSince(task.task_id, 0).then((events) => {
      for (const e of events) writeDedup(e.frame);
      for (const f of pending) writeDedup(f);
      pending.length = 0;
      flushing = false;
      if (runner.isFinished) {
        unsubscribe();
        close();
      }
    });
    args.req.signal.addEventListener('abort', () => {
      unsubscribe();
      close();
    });
  });
}