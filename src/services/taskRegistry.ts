// taskRegistry.ts：前端任务注册表（module 级）。事件归集进每任务独立的 accumulator，
// 不直接触发渲染——呈现层订阅后按「当前活跃会话」过滤消费（spec 5.2.1 规则 2/7）。
// 纯 module 级实现，无 React 依赖（离线可测）。
import { conversationAccumulator } from "../lib/conversationState.ts";
import type { DatasetCard, ToolLog, GroundingPayload, SnapshotFrame, TaskEventFrame } from "./seqoutChat.ts";

export type TaskPhase = "running" | "completed" | "failed" | "cancelled";

export interface TaskRuntime {
  task_id: string;
  session_ref: string;
  owner_scope: string;
  phase: TaskPhase;
  accumulator: ReturnType<typeof conversationAccumulator>;
  /** 终态未查看标记（会话栏「新结果」徽标数据源） */
  unseen: boolean;
  started_at: number;
  /** SSE 连接句柄（停止/切换管理） */
  close?: () => void;
}

/** 归集到消息流的快照形态（与 ChatUIMessage 的呈现字段同构） */
export interface TaskSnapshotMessage {
  id: string;
  role: "assistant";
  content: string;
  cards?: DatasetCard[];
  toolLogs?: ToolLog[];
  grounding?: GroundingPayload;
  boost?: { accession: string | null };
  error?: string;
  streaming: boolean;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

class TaskRegistryImpl {
  private tasks = new Map<string, TaskRuntime>();
  private bySessionIdx = new Map<string, string>(); // session_ref → task_id（会话内串行：至多一个活跃任务）
  private listeners = new Set<() => void>();

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** 会话栏标识订阅源（模式参照 petBus） */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  register(taskId: string, sessionRef: string, scope: string): TaskRuntime {
    const existing = this.tasks.get(taskId);
    if (existing) return existing;
    const rt: TaskRuntime = {
      task_id: taskId,
      session_ref: sessionRef,
      owner_scope: scope,
      phase: "running",
      accumulator: conversationAccumulator(taskId),
      unseen: false,
      started_at: Date.now(),
    };
    this.tasks.set(taskId, rt);
    this.bySessionIdx.set(sessionRef, taskId);
    this.notify();
    return rt;
  }

  /** 事件归集入口：写进该任务自己的 accumulator（不经 scopeRef 守卫——守卫在呈现层） */
  dispatch(taskId: string, apply: (acc: ReturnType<typeof conversationAccumulator>) => void): void {
    const rt = this.tasks.get(taskId);
    if (!rt) return;
    apply(rt.accumulator);
  }

  /** task 帧归集：状态迁移 + 终态 unseen 标记 */
  applyTaskFrame(frame: TaskEventFrame): void {
    const rt = this.tasks.get(frame.task_id);
    if (!rt) return;
    if (frame.status === "running" || frame.status === "queued") {
      rt.phase = "running";
    } else if (frame.status === "completed" || frame.status === "failed" || frame.status === "cancelled") {
      rt.phase = frame.status;
      rt.unseen = true;
      if (this.bySessionIdx.get(rt.session_ref) === rt.task_id) this.bySessionIdx.delete(rt.session_ref);
    }
    this.notify();
  }

  /** snapshot 帧归集：全量重置（不是增量拼接） */
  applySnapshot(frame: SnapshotFrame): void {
    const rt = this.tasks.get(frame.task_id);
    if (!rt) return;
    // 以「全量替换」语义重建累加器，逐字段覆盖
    rt.accumulator = conversationAccumulator(rt.task_id);
    if (frame.content) rt.accumulator.delta(frame.content);
    if (frame.cards?.length) rt.accumulator.cards(frame.cards);
    for (const log of frame.tools ?? []) rt.accumulator.tool(log);
    if (frame.grounding) rt.accumulator.grounding(frame.grounding);
    if (frame.boost) rt.accumulator.boost(frame.boost.accession);
  }

  /** SSE 连接登记（停止/切换管理） */
  attachStream(taskId: string, close: () => void): void {
    const rt = this.tasks.get(taskId);
    if (rt) rt.close = close;
  }

  bySession(sessionRef: string): TaskRuntime | undefined {
    const id = this.bySessionIdx.get(sessionRef);
    return id ? this.tasks.get(id) : undefined;
  }

  get(taskId: string): TaskRuntime | undefined {
    return this.tasks.get(taskId);
  }

  /** 指定 scope 的活跃任务计数（前端并发双重校验的一重） */
  activeCount(scope: string): number {
    let n = 0;
    for (const rt of this.tasks.values()) {
      if (rt.owner_scope === scope && rt.phase === "running") n++;
    }
    return n;
  }

  /** hydration：目标会话已产出部分的即时呈现快照 */
  snapshotFor(sessionRef: string): TaskSnapshotMessage | null {
    const rt = this.bySession(sessionRef);
    if (!rt) return null;
    const s = rt.accumulator.snapshot();
    return {
      id: rt.task_id,
      role: "assistant",
      content: s.content,
      cards: s.cards,
      toolLogs: s.toolLogs,
      grounding: s.grounding,
      boost: s.boost,
      error: s.error,
      streaming: rt.phase === "running",
    };
  }

  /** 会话激活且消息流含该任务消息时清除 unseen（「新结果」徽标消失） */
  markSeen(sessionRef: string): void {
    for (const rt of this.tasks.values()) {
      if (rt.session_ref === sessionRef && rt.unseen) {
        rt.unseen = false;
        this.notify();
      }
    }
  }

  /** 登出/身份切换：按旧 scope 清空登记（服务端任务按其归属继续至终态） */
  clearScope(scope: string): void {
    for (const [id, rt] of this.tasks) {
      if (rt.owner_scope === scope) {
        rt.close?.();
        this.tasks.delete(id);
        if (this.bySessionIdx.get(rt.session_ref) === id) this.bySessionIdx.delete(rt.session_ref);
      }
    }
    this.notify();
  }

  /** 全部活跃任务（启动恢复扫描的本地比对源） */
  all(): TaskRuntime[] {
    return [...this.tasks.values()];
  }
}

/** 全局单例（页面生命周期） */
export const taskRegistry = new TaskRegistryImpl();
export { TERMINAL as TERMINAL_TASK_PHASES };