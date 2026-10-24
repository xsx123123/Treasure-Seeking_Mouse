// tasks/runner.ts：任务执行单元。runChatLoop 为 index.ts 主循环的整体迁出——
// 业务语义零改动（工具编排/意图拦截/文献补链/grounding/兜底卡片原样），仅事件出口抽象：
// send() → emit() 回调；req.signal → taskSignal（任务级，与 HTTP 连接解耦）；usageStats → deps 回调。
// 模块红线：本文件不得 import 主文件 index.ts（deps 函数指针注入，对齐 protocols/ 契约）。
import type { Json } from '../shared.ts';
import type { ResearchIntent } from '../intent.ts';
import type {
  ChatHistoryMessage,
  ChatLoopArgs,
  ChatLoopDeps,
  ChatLoopHooks,
  ChatLoopOutcome,
  EmitFn,
  RoundDigest,
  ToolLogEntry,
} from './types.ts';

/** 轮摘要的结果摘要护栏：单轮 ≤8KB（复用 trimForLLM 输出再截断） */
const ROUND_DIGEST_MAX_CHARS = 8_000;

/**
 * 主循环（40 轮工具编排上限）。迁移对照：functions/seqout-chat/index.ts 原 L1898–2105。
 * emit 帧集：delta / tool / cards / platform_tool / polariseq / grounding / end / error（与迁出前逐帧一致）。
 */
export async function runChatLoop(
  args: ChatLoopArgs,
  deps: ChatLoopDeps,
  emit: EmitFn,
  taskSignal: AbortSignal,
  hooks: ChatLoopHooks = {},
): Promise<ChatLoopOutcome> {
  const { model, lang, requestId, startTime } = args;
  const messages = args.messages;
  const history = args.history;
  const allCards: Json[] = [];
  const toolLogs: ToolLogEntry[] = [];
  let aborted = false;
  let boostSent = false; // 「下载加速」卡片事件每轮最多发一次
  let fullText = ''; // 各轮助手正文累积（工具轮的前言 + 最终答复），供末尾的兜底卡片检测
  let sessionIntent: ResearchIntent | null = null; // 本轮 intent_plan 校验通过的意图（供文献自动补链判断）
  let litSearched = false; // 模型本轮是否已调用过 literature_search（自动补链防重）
  const rounds: RoundDigest[] = args.initialRounds ? [...args.initialRounds] : [];
  let suspended = false; // Edge 预算哨兵挂起（未走终态帧，由调用方落完整快照 + suspended 标记）
  taskSignal.addEventListener('abort', () => { aborted = true; });

  try {
    for (let round = args.startRound ?? 0; round < 40 && !aborted; round++) {
      // Edge 预算哨兵：本轮开始前判定预算余量，不足则挂起收口（由调用方落快照）
      if (hooks.beforeRound?.(round) === 'suspend') { suspended = true; break; }
      const outcome = await deps.llmRound(messages, (text) => emit({ delta: text }), taskSignal);
      if (!outcome.ok) {
        console.error(`[${deps.logPrefix}] upstream failed ${requestId} status=${outcome.status ?? 'unknown'}`);
        emit({ error: `AI 服务返回 ${outcome.status ?? 'unknown'}` });
        break;
      }
      if (aborted) break; // 断连后不再执行工具、不进入下一轮
      const textBuf = outcome.text ?? '';
      fullText += textBuf;
      const callsArr = outcome.toolCalls ?? [];
      if (!callsArr.length) {
        if (!outcome.sawDone) emit({ delta: '' });
        break;
      }
      // 执行工具，把结果作为 tool message 继续下一轮
      messages.push({ role: 'assistant', content: textBuf || null, tool_calls: callsArr as unknown as Json });
      const roundDigest: RoundDigest = { assistant: textBuf.slice(0, ROUND_DIGEST_MAX_CHARS), toolCalls: [] };
      for (const call of callsArr) {
        const label = deps.labelOf(call.function.name);
        const t0 = Date.now();
        // 意图规划条目：不调外部 API、不发 SSE tool 事件、不计用量统计。
        if (call.function.name === deps.intentToolName) {
          let intentRaw: unknown = null;
          try { intentRaw = JSON.parse(call.function.arguments || '{}'); } catch { /* 非法 JSON 按校验失败处理 */ }
          const parsedIntent = deps.parseIntent(intentRaw);
          if (parsedIntent.ok === false) {
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ success: false, error: `意图校验失败：${parsedIntent.reason}。可修正后重试 ${deps.intentToolName}，或直接调用检索工具。` }) });
            roundDigest.toolCalls.push({ name: call.function.name, args: call.function.arguments.slice(0, 500), resultSummary: `意图校验失败：${parsedIntent.reason}` });
          } else {
            sessionIntent = parsedIntent.intent;
            toolLogs.push({ name: deps.intentToolName, label, ok: true, ms: Date.now() - t0, intent: parsedIntent.intent, notes: parsedIntent.notes });
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ success: true, data: { intent: parsedIntent.intent, normalized: parsedIntent.notes, note: '意图已记录并完成归一化，后续检索请采用归一化取值（organism 用二名法学名、assay 用 library_strategy 词表值）。' } }) });
            roundDigest.toolCalls.push({ name: call.function.name, args: call.function.arguments.slice(0, 500), resultSummary: '意图已记录并归一化' });
          }
          continue;
        }
        deps.trackToolStart(call.function.name);
        if (call.function.name === deps.literatureToolName) litSearched = true; // 无论成败都算"模型已自查"，自动补链不重复
        emit({ event: 'tool', name: call.function.name, label, status: 'running' });
        let resultText: string;
        let callArgs: Record<string, Json | undefined> = {};
        let toolPayload: Json | null = null;
        try {
          callArgs = JSON.parse(call.function.arguments || '{}') as Record<string, Json | undefined>;
          const payload = (deps.platformHas(call.function.name)
            ? await deps.platformCall(call.function.name, callArgs, taskSignal)
            : await deps.executeTool(call.function.name, callArgs)) as Json;
          if (deps.platformHas(call.function.name)) emit({ event: 'platform_tool', result: payload });
          toolPayload = payload;
          if (deps.isBusinessEmpty(payload)) deps.trackToolEmpty(call.function.name); // 空矿 ≠ 失败，分开统计
          const cards = deps.extractCards(call.function.name, payload);
          if (cards.length) { allCards.push(...cards); emit({ event: 'cards', cards }); }
          resultText = deps.trimForLLM(payload);
          toolLogs.push({ name: call.function.name, label, ok: true, ms: Date.now() - t0 });
          emit({ event: 'tool', name: call.function.name, label, status: 'done', ms: Date.now() - t0 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          resultText = JSON.stringify({ success: false, error: message });
          deps.trackToolError(call.function.name);
          toolLogs.push({ name: call.function.name, label, ok: false, ms: Date.now() - t0 });
          emit({ event: 'tool', name: call.function.name, label, status: 'error', ms: Date.now() - t0, error: message });
          console.warn(`[${deps.logPrefix}] tool failed ${requestId} ${call.function.name}: ${message.slice(0, 200)}`);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: resultText });
        roundDigest.toolCalls.push({ name: call.function.name, args: call.function.arguments.slice(0, 500), resultSummary: resultText.slice(0, ROUND_DIGEST_MAX_CHARS) });
        // 下载链接类工具：给前端发固定「下载加速」卡片事件（Polariseq）。
        // 例外：业务性空矿（GEO-only 无公开 run）不发卡片。
        if (deps.downloadLinkTools.has(call.function.name) && !boostSent && !deps.isBusinessEmpty(toolPayload)) {
          boostSent = true;
          const payloadObj = (toolPayload && typeof toolPayload === 'object' && !Array.isArray(toolPayload) ? toolPayload : {}) as Record<string, unknown>;
          const dataObj = (payloadObj.data && typeof payloadObj.data === 'object' && !Array.isArray(payloadObj.data) ? payloadObj.data : {}) as Record<string, unknown>;
          const parsed = typeof dataObj.bioproject === 'string' && /^PRJ/i.test(dataObj.bioproject) ? dataObj.bioproject.toUpperCase() : null;
          const fromArgs = /^PRJ(NA|EB|DB)\d+$/i.test(String(callArgs.study_accession ?? '')) ? String(callArgs.study_accession).toUpperCase() : null;
          const fromResult = /PRJ(?:NA|EB|DB)\d+/i.exec(resultText)?.[0]?.toUpperCase() ?? null;
          emit({ event: 'polariseq', accession: parsed ?? fromArgs ?? fromResult });
        }
      }
      rounds.push(roundDigest);
      hooks.onRound?.(roundDigest);
      if (round === 39) emit({ delta: lang === 'en' ? '\n\n(Reached the maximum queries for this turn; ask a follow-up to continue.)' : '\n\n（已达到本轮最大查询次数，请追问以继续。）' });
    }
    if (suspended) return { fullText, allCards, toolLogs, aborted, rounds, suspended: true };
    // 数据集→文献自动补链：cards 出现 GSE/PRJ 级数据集、有文献需求信号、且模型本轮未调用过
    // literature_search 时，平台自动补一次多源文献检索。模型仍是编排主体——这是兜底补链不是替代。
    if (!aborted) {
      const lastUserMsg = [...history].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
      const followupQuery = (sessionIntent?.question || (typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '') || '').slice(0, 200);
      if (
        followupQuery &&
        deps.needsLiteratureFollowup({
          cards: allCards,
          intentNeedsLiterature: sessionIntent?.needs_literature === true,
          userText: typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '',
          literatureAlreadySearched: litSearched,
        })
      ) {
        const litLabel = deps.labelOf(deps.literatureToolName);
        const litT0 = Date.now();
        deps.trackToolStart(deps.literatureToolName);
        emit({ event: 'tool', name: deps.literatureToolName, label: litLabel, status: 'running' });
        try {
          const payload = deps.wrapLit(await deps.searchAllLiterature({ query: followupQuery }));
          const cards = deps.extractCards(deps.literatureToolName, payload);
          if (cards.length) { allCards.push(...cards); emit({ event: 'cards', cards }); }
          toolLogs.push({ name: deps.literatureToolName, label: litLabel, ok: true, ms: Date.now() - litT0 });
          emit({ event: 'tool', name: deps.literatureToolName, label: litLabel, status: 'done', ms: Date.now() - litT0 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.trackToolError(deps.literatureToolName);
          toolLogs.push({ name: deps.literatureToolName, label: litLabel, ok: false, ms: Date.now() - litT0 });
          emit({ event: 'tool', name: deps.literatureToolName, label: litLabel, status: 'error', ms: Date.now() - litT0, error: message });
          console.warn(`[${deps.logPrefix}] literature followup failed ${requestId}: ${message.slice(0, 200)}`);
        }
      }
    }
    // 兜底推荐：本轮没发过卡片时，看正文是否给出 BioProject / Run 编号。
    if (!boostSent && !aborted) {
      const prj = /PRJ(?:NA|EB|DB)\d{3,}/i.exec(fullText)?.[0]?.toUpperCase() ?? null;
      if (prj) {
        try {
          if (await deps.hasRuns(prj)) { boostSent = true; emit({ event: 'polariseq', accession: prj }); }
        } catch { /* 上游查不动就不发卡片 */ }
      } else if (/(?:SRR|ERR|DRR)\d{5,}/i.test(fullText)) {
        boostSent = true;
        emit({ event: 'polariseq', accession: null });
      }
    }
    // 正文↔证据一致性校验（grounding）。校验失败绝不打断主流程（宁可漏报，不可丢回答）。
    if (!aborted && fullText.trim()) {
      const g0 = Date.now();
      try {
        const report = await deps.groundingCheck(fullText, allCards);
        toolLogs.push({ name: 'grounding_check', label: '正文编号核验', ok: report.unconfirmed.length === 0, ms: Date.now() - g0 });
        if (report.unconfirmed.length > 0) {
          emit({ event: 'grounding', unconfirmed: report.unconfirmed, confirmed: report.confirmed });
          console.warn(`[${deps.logPrefix}] grounding ${requestId} unconfirmed=${report.unconfirmed.map((u) => u.id).join(',')}`);
        }
      } catch (err) {
        console.warn(`[${deps.logPrefix}] grounding failed ${requestId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    emit({ event: 'end', cards: allCards, tools: toolLogs });
    console.info(`[${deps.logPrefix}] stream done ${requestId} tools=${toolLogs.length} durationMs=${Date.now() - startTime}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error(`[${deps.logPrefix}] stream failed ${requestId}: ${message}`);
    emit({ error: message });
  }
  return { fullText, allCards, toolLogs, aborted, rounds, suspended };
}
/* ==================== TaskRunner：任务执行单元（emit 三路分发 + 取消/超时/Edge 哨兵汇聚） ==================== */

import {
  TASK_EDGE_SUSPEND_HEADROOM_MS,
  TASK_EDGE_WALL_BUDGET_MS,
  type ChatTask,
  type ProgressSnapshot,
  type RoundDigest,
  type TaskErrorKind,
  type TaskStatus,
} from './types.ts';
import { buildResultPayload, mergeCardsForSnapshot, taskFrame } from './protocol.ts';
import { computeExpiresAt, hardTimeoutMs, registerCancelHook, unregisterCancelHook } from './registry.ts';
import type { TaskStore } from './store.ts';

/** 里程碑快照节流：每 30 帧或每 15s 先到为准（命名常量，design §2.2.2 红线） */
const SNAPSHOT_EVERY_FRAMES = 30;
const SNAPSHOT_EVERY_MS = 15_000;
/** 快照体积护栏：总 200KB，超限丢最旧轮并置 rounds_truncated */
const SNAPSHOT_MAX_BYTES = 200_000;

export interface TaskRunnerArgs {
  task: ChatTask;
  store: TaskStore;
  deps: ChatLoopDeps;
  /** 显式运行时分叉（禁嗅探全局对象） */
  runtime: 'node' | 'edge';
  /** Edge 形态：wall-clock 预算起点（请求进入时刻 Date.now()） */
  budgetStartedAt?: number;
  /** Edge 形态：EdgeRuntime.waitUntil 承接断连后的继续执行（由 index.ts 从平台全局读入注入） */
  edgeWaitUntil?: ((p: Promise<unknown>) => void) | null;
  /** Edge 唤醒续跑的 system prompt 重建（快照不落 system，按当前版本重新生成） */
  systemPromptFor?: (lang: 'zh' | 'en') => string;
}

export class TaskRunner {
  private task: ChatTask;
  private store: TaskStore;
  private deps: ChatLoopDeps;
  private runtime: 'node' | 'edge';
  private budgetStartedAt: number;
  private systemPromptFor: (lang: 'zh' | 'en') => string;
  private taskController = new AbortController();
  private subscribers = new Set<EmitFn>();
  private seq = 0;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshotAt = 0;
  private framesSinceSnapshot = 0;
  private accContent = '';
  private accCards: Json[] = [];
  private accTools: ToolLogEntry[] = [];
  private accGrounding: Json | null = null;
  private accBoost: { accession: string | null } | null = null;
  private rounds: RoundDigest[] = [];
  private roundsTruncated = false;
  private sawErrorText: string | null = null;
  private cancelledByUser = false;
  private timedOut = false;
  private finished = false;

  constructor(args: TaskRunnerArgs) {
    this.task = args.task;
    this.store = args.store;
    this.deps = args.deps;
    this.runtime = args.runtime;
    this.budgetStartedAt = args.budgetStartedAt ?? Date.now();
    this.systemPromptFor = args.systemPromptFor ?? (() => '');
    if (args.task.progress_snapshot?.rounds) {
      this.rounds = [...args.task.progress_snapshot.rounds];
      this.roundsTruncated = args.task.progress_snapshot.rounds_truncated === true;
      this.accContent = args.task.progress_snapshot.content;
      this.accCards = [...args.task.progress_snapshot.cards];
      this.accTools = [...args.task.progress_snapshot.tools];
      this.accGrounding = (args.task.progress_snapshot.grounding ?? null) as Json | null;
      this.accBoost = args.task.progress_snapshot.boost ?? null;
      this.seq = args.task.progress_snapshot.seq;
    }
    registerCancelHook(this.task.task_id, () => {
      this.cancelledByUser = true;
      this.taskController.abort();
    });
    // Node 形态硬超时 = 真实计时器；Edge 形态 = 累计判定（唤醒收口复用 registry.isHardTimedOut）
    if (this.runtime === 'node') {
      this.hardTimer = setTimeout(() => {
        this.timedOut = true;
        this.taskController.abort();
      }, hardTimeoutMs());
      (this.hardTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** SSE 连接登记（订阅者推送为 emit 三路之一）；返回退订函数 */
  subscribe(fn: EmitFn): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get taskId(): string {
    return this.task.task_id;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** 用户取消（registry cancel hook 之外的前端 cancel action 直连入口） */
  cancel(): void {
    this.cancelledByUser = true;
    this.taskController.abort();
  }

  /** Edge 预算哨兵（纯判定，注入 now 可测） */
  shouldSuspend(now = Date.now()): boolean {
    if (this.runtime !== 'edge') return false;
    const remaining = this.budgetStartedAt + TASK_EDGE_WALL_BUDGET_MS - now;
    return remaining < TASK_EDGE_SUSPEND_HEADROOM_MS;
  }

  private buildSnapshot(): ProgressSnapshot {
    const snap: ProgressSnapshot = {
      content: this.accContent,
      cards: this.accCards,
      tools: this.accTools,
      grounding: this.accGrounding as unknown as ProgressSnapshot['grounding'],
      boost: this.accBoost,
      rounds: this.rounds,
      seq: this.seq,
    };
    // 体积护栏：超限丢最旧轮并置标记
    let text = JSON.stringify(snap);
    while (text.length > SNAPSHOT_MAX_BYTES && snap.rounds && snap.rounds.length > 0) {
      snap.rounds = snap.rounds.slice(1);
      snap.rounds_truncated = true;
      this.roundsTruncated = true;
      text = JSON.stringify(snap);
    }
    if (this.roundsTruncated) snap.rounds_truncated = true;
    return snap;
  }

  /** emit 三路分发：① 当前连接推送 ② 内存环形缓冲 ③ 里程碑快照落库 */
  private emitFrame(frame: Json): void {
    this.seq += 1;
    const f = frame as Record<string, Json>;
    f.seq = this.seq; // 帧序号（协议可选新增字段；续传衔接与审计用，旧前端透明忽略）
    // end 帧注入可选 task_id（协议只加不改：旧前端判定不受影响）
    if (f.event === 'end') f.task_id = this.task.task_id;
    // 累积态维护（快照/终态数据源）
    if (typeof f.delta === 'string') this.accContent += f.delta;
    else if (f.event === 'cards' && Array.isArray(f.cards)) this.accCards = mergeCardsForSnapshot(this.accCards, f.cards as Json[]);
    else if (f.event === 'tool' && f.status !== 'running') {
      this.accTools.push({ name: String(f.name ?? ''), label: String(f.label ?? ''), ok: f.status === 'done', ms: typeof f.ms === 'number' ? f.ms : 0 });
    } else if (f.event === 'grounding') this.accGrounding = f as unknown as Json;
    else if (f.event === 'polariseq') this.accBoost = { accession: (f.accession as string | null) ?? null };
    else if (typeof f.error === 'string') this.sawErrorText = f.error;
    for (const fn of this.subscribers) {
      try { fn(f as Json); } catch { /* 订阅者异常不影响任务 */ }
    }
    void this.store.appendEvents(this.task.task_id, [{ seq: this.seq, frame: f as Json, at: Date.now() }]);
    // 里程碑快照：节流落库
    this.framesSinceSnapshot += 1;
    const now = Date.now();
    if (this.framesSinceSnapshot >= SNAPSHOT_EVERY_FRAMES || now - this.lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
      this.framesSinceSnapshot = 0;
      this.lastSnapshotAt = now;
      void this.store.saveSnapshot(this.task.task_id, this.buildSnapshot(), now);
    }
  }

  /**
   * 执行任务：首帧 task 帧（先于任何 delta）→ runChatLoop → 终态收口（落库 + task 终态帧）。
   * Edge 挂起：落完整 progress_snapshot + suspended=true，不落终态。
   */
  async run(): Promise<void> {
    const taskId = this.task.task_id;
    try {
      this.emitFrame(taskFrame({ task_id: taskId, status: 'running', session_ref: this.task.session_ref, queue_id: this.task.queue_id ?? undefined, seq: this.seq + 1 }) as unknown as Json);
      const isResume = !!this.task.progress_snapshot;
      const systemPrompt = this.systemPromptFor(this.task.lang);
      const messages: ChatHistoryMessage[] = isResume
        ? this.rebuildMessages(systemPrompt)
        : [{ role: 'system', content: systemPrompt }, ...this.task.question_snapshot.history];
      const outcome = await runChatLoop(
        {
          model: this.task.question_snapshot.model ?? '',
          messages,
          history: this.task.question_snapshot.history,
          lang: this.task.lang,
          requestId: taskId.slice(0, 8),
          startTime: this.task.created_at,
          initialRounds: this.rounds,
        },
        this.deps,
        (f) => this.emitFrame(f),
        this.taskController.signal,
        { beforeRound: () => (this.shouldSuspend() ? 'suspend' : 'continue'), onRound: (d) => this.onRound(d) },
      );
      // Edge 挂起：不落终态，落完整快照 + suspended 标记
      if (outcome.suspended) {
        await this.store.updateStatus(taskId, ['running', 'queued'], 'running', {
          suspended: true,
          progress_snapshot: this.buildSnapshot(),
          heartbeat_at: Date.now(),
        });
        console.info(`[${this.deps.logPrefix}] task suspended ${taskId}（Edge 预算余量不足，待唤醒续跑）`);
        return;
      }
      // 终态分类：取消 > 硬超时 > LLM 错误 > 正常完成
      let status: TaskStatus = 'completed';
      let error: TaskErrorKind | null = null;
      if (this.cancelledByUser || (outcome.aborted && !this.timedOut)) { status = 'cancelled'; error = 'aborted'; }
      else if (this.timedOut) { status = 'failed'; error = 'timeout'; }
      else if (this.sawErrorText && !outcome.allCards.length && !outcome.fullText.trim()) { status = 'failed'; error = 'llm_error'; }
      const finishedAt = Date.now();
      await this.store.saveResult(taskId, {
        status,
        result: {
          content: outcome.fullText,
          cards: outcome.allCards,
          toolLogs: outcome.toolLogs,
          grounding: this.accGrounding as unknown as ProgressSnapshot['grounding'],
          boost: this.accBoost,
          error: this.sawErrorText,
        },
        error,
        finished_at: finishedAt,
        expires_at: computeExpiresAt(finishedAt),
      });
      this.emitFrame(taskFrame({ task_id: taskId, status, error: error ?? undefined, seq: this.seq + 1 }) as unknown as Json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.deps.logPrefix}] task runner failed ${taskId}: ${message}`);
      try {
        const finishedAt = Date.now();
        await this.store.saveResult(taskId, {
          status: 'failed',
          result: { content: this.accContent, cards: this.accCards, toolLogs: this.accTools, grounding: null, boost: this.accBoost, error: message },
          error: 'llm_error',
          finished_at: finishedAt,
          expires_at: computeExpiresAt(finishedAt),
        });
        this.emitFrame(taskFrame({ task_id: taskId, status: 'failed', error: 'llm_error', seq: this.seq + 1 }) as unknown as Json);
      } catch { /* 落库失败不再抛出 */ }
    } finally {
      this.finished = true;
      if (this.hardTimer) clearTimeout(this.hardTimer);
      unregisterCancelHook(taskId);
    }
  }

  private onRound(d: RoundDigest): void {
    this.rounds.push(d);
  }

  /** Edge 唤醒续跑：从 progress_snapshot 重建 messages（system 重新生成 + history 原样 + rounds 摘要回放） */
  private rebuildMessages(systemPrompt: string): ChatHistoryMessage[] {
    const snap = this.task.progress_snapshot;
    const messages: ChatHistoryMessage[] = [
      { role: 'system', content: systemPrompt }, // system 不落快照，按当前版本重新生成
      ...this.task.question_snapshot.history,
    ];
    const rounds = snap?.rounds ?? [];
    rounds.forEach((r, ri) => {
      messages.push({
        role: 'assistant',
        content: r.assistant || null,
        tool_calls: r.toolCalls.map((tc, ti) => ({ id: `resume_${ri}_${ti}`, type: 'function', function: { name: tc.name, arguments: tc.args } })) as unknown as Json,
      });
      r.toolCalls.forEach((tc, ti) => {
        messages.push({ role: 'tool', tool_call_id: `resume_${ri}_${ti}`, name: tc.name, content: tc.resultSummary });
      });
    });
    return messages;
  }
}

export { buildResultPayload };
