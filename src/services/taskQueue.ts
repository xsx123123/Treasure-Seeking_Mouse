// taskQueue.ts：消息排队状态机（纯逻辑，零 React 依赖，离线可测）。
// 契约：design §2.2.2-E 九方法 + purge；localStorage 持久化 key=seqout:queue:v1:<scopeKey>:<session_ref>
// （scopeKey 复用 sessionKey() 端点+账号分区，身份切换天然隔离）。
// 语义要点：enqueue 纯本地同步无网络往返；FIFO 严格序；撤销/清空仅作用 queued 态；
// 清空保留副本 5s 内可 undoClear；localStorage 写失败 → 内存态继续 + onStorageError 冒泡。

export type QueueItemStatus = 'queued' | 'cancelled' | 'promoted' | 'drafted';

export interface QueuedMessage {
  queue_id: string;
  session_ref: string;
  content: string;
  enqueued_at: number;
  status: QueueItemStatus;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

interface QueueFile {
  version: 1;
  items: QueuedMessage[];
  cleared_backup?: { items: QueuedMessage[]; at: number };
}

/** 清空撤销找回窗口（固定值，前端行为细节不暴露部署配置） */
export const QUEUE_DRAFT_RESTORE_WINDOW_MS = 5_000;

/** 单会话排队上限（VITE_QUEUE_MAX_PER_SESSION 覆盖，1–50 钳制，默认 10） */
function queueCapacity(): number {
  const raw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_QUEUE_MAX_PER_SESSION;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

export class TaskQueueStore {
  private storage: StorageLike | null;
  private scopeKey: string;
  private onStorageError?: () => void;
  /** FIFO 同毫秒时的到达顺序计数器 */
  private arrival = 0;
  /** 内存兜底（localStorage 写失败后继续服务，spec 异常通道） */
  private memoryFallback = new Map<string, QueueFile>();

  constructor(args: { storage: StorageLike | null; scopeKey: string; onStorageError?: () => void }) {
    this.storage = args.storage;
    this.scopeKey = args.scopeKey;
    this.onStorageError = args.onStorageError;
  }

  private key(sessionRef: string): string {
    return `seqout:queue:v1:${this.scopeKey}:${sessionRef}`;
  }

  private read(sessionRef: string): QueueFile {
    const key = this.key(sessionRef);
    try {
      const raw = this.storage?.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as QueueFile;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) return parsed;
      }
    } catch { /* 损坏按空队列 */ }
    return this.memoryFallback.get(key) ?? { version: 1, items: [] };
  }

  private write(sessionRef: string, file: QueueFile): void {
    const key = this.key(sessionRef);
    this.memoryFallback.set(key, file);
    try {
      this.storage?.setItem(key, JSON.stringify(file));
    } catch {
      // 配额满等写失败：内存态继续，冒泡 storage 错误给 reliability 提示条通道
      this.onStorageError?.();
    }
  }

  /** 仅 queued 态项，按 enqueued_at 升序（FIFO） */
  list(sessionRef: string): QueuedMessage[] {
    return this.read(sessionRef).items
      .filter((i) => i.status === 'queued')
      .sort((a, b) => a.enqueued_at - b.enqueued_at);
  }

  enqueue(sessionRef: string, content: string): { ok: true; item: QueuedMessage } | { ok: false; reason: 'full' } {
    const file = this.read(sessionRef);
    const queued = file.items.filter((i) => i.status === 'queued');
    if (queued.length >= this.capacity()) return { ok: false, reason: 'full' };
    this.arrival += 1;
    const item: QueuedMessage = {
      queue_id: crypto.randomUUID(),
      session_ref: sessionRef,
      content,
      // 同毫秒到达时以 arrival 计数器微偏移保证严格 FIFO 序
      enqueued_at: Date.now() + this.arrival / 100000,
      status: 'queued',
    };
    file.items.push(item);
    file.cleared_backup = undefined;
    this.write(sessionRef, file);
    return { ok: true, item };
  }

  /** 逐条撤销：仅作用于 queued（spec 6.1 规则 5 枚举守卫） */
  cancel(sessionRef: string, queueId: string): boolean {
    const file = this.read(sessionRef);
    const item = file.items.find((i) => i.queue_id === queueId && i.status === 'queued');
    if (!item) return false;
    item.status = 'cancelled';
    this.write(sessionRef, file);
    return true;
  }

  /** 清空：仅清 queued 项，保留副本供 5s 撤销找回；返回被清项 */
  clear(sessionRef: string): QueuedMessage[] {
    const file = this.read(sessionRef);
    const cleared = file.items.filter((i) => i.status === 'queued');
    if (!cleared.length) return [];
    file.cleared_backup = { items: cleared.map((i) => ({ ...i })), at: Date.now() };
    for (const i of file.items) if (i.status === 'queued') i.status = 'cancelled';
    this.write(sessionRef, file);
    return cleared;
  }

  /** 窗口内原样恢复被清项；超窗副本读入即弃 */
  undoClear(sessionRef: string): boolean {
    const file = this.read(sessionRef);
    const backup = file.cleared_backup;
    if (!backup || Date.now() - backup.at > QUEUE_DRAFT_RESTORE_WINDOW_MS) {
      file.cleared_backup = undefined;
      this.write(sessionRef, file);
      return false;
    }
    const revived = backup.items.map((i) => ({ ...i, status: 'queued' as const }));
    file.items.push(...revived);
    file.cleared_backup = undefined;
    this.write(sessionRef, file);
    return true;
  }

  /** FIFO 弹出队首（status→promoted）；空队列返回 null */
  promoteNext(sessionRef: string): QueuedMessage | null {
    const file = this.read(sessionRef);
    const head = this.list(sessionRef)[0];
    if (!head) return null;
    const item = file.items.find((i) => i.queue_id === head.queue_id);
    if (!item) return null;
    item.status = 'promoted';
    this.write(sessionRef, file);
    return { ...item };
  }

  /** 停止转草稿：queued 项按序取内容、status→drafted，返回拼接前内容数组（拼接/截断由调用方执行） */
  markDrafted(sessionRef: string): string[] {
    const file = this.read(sessionRef);
    const queued = this.list(sessionRef);
    if (!queued.length) return [];
    const ids = new Set(queued.map((i) => i.queue_id));
    for (const i of file.items) if (ids.has(i.queue_id)) i.status = 'drafted';
    this.write(sessionRef, file);
    return queued.map((i) => i.content);
  }

  /**
   * 刷新恢复（异常 5.1.3-2 / spec 5.3.1 规则 7）：queued 项经持久化天然恢复呈现；
   * 返回值给呈现层模式暗示——前序 running → 'queued'（正常排队等待）；
   * 前序终态 → 'confirm'（待用户确认重发或撤销，不擅自派发）。
   */
  restore(sessionRef: string, frontStillRunning: boolean): 'queued' | 'confirm' {
    return frontStillRunning ? 'queued' : 'confirm';
  }

  capacity(): number {
    return queueCapacity();
  }

  /** 会话删除/淘汰时同步清除队列 key（配额红线） */
  purge(sessionRef: string): void {
    const key = this.key(sessionRef);
    this.memoryFallback.delete(key);
    try {
      this.storage?.removeItem?.(key);
    } catch { /* 忽略 */ }
  }
}