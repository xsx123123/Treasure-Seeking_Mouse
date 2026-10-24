// QueuePanel：排队消息列表（队列区是排队消息的唯一呈现位——消息流无队列项气泡，spec 5.1.1 规则 10）。
// 纯呈现组件：队列状态由编排层（index.tsx + taskQueue）持有，本组件只负责渲染与回调。
import { ListOrdered, Play, RotateCcw, Trash2, X } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { QueuedMessage } from "@/services/taskQueue";

export function QueuePanel({
  items,
  capacity,
  paused,
  confirmMode,
  fullNotice,
  undoAvailable,
  onCancel,
  onClear,
  onUndoClear,
  onResumeNext,
  onConfirmResend,
  onConfirmDiscard,
}: {
  items: QueuedMessage[];
  capacity: number;
  /** 失败暂停态（异常 5.1.3-3：用户明示选择前不自动启动） */
  paused: boolean;
  /** 刷新恢复的待确认态（spec 5.3.1 规则 7：不擅自派发） */
  confirmMode: boolean;
  /** 队列满提示呈现位（入队被拒时提问文字保留在输入框） */
  fullNotice: boolean;
  /** 清空后 5s 撤销找回窗口内 */
  undoAvailable: boolean;
  onCancel: (queueId: string) => void;
  onClear: () => void;
  onUndoClear: () => void;
  onResumeNext: () => void;
  onConfirmResend: () => void;
  onConfirmDiscard: () => void;
}): React.ReactElement | null {
  const { t } = useI18n();
  if (!items.length && !fullNotice && !undoAvailable && !confirmMode) return null;

  return (
    <div className="card-in mb-2 rounded-xl border border-border bg-card shadow-soft">
      {/* 头部：标题 + 计数 + 清空 */}
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
        <ListOrdered size={13} className="shrink-0 text-helix" />
        <span className="text-xs font-medium text-foreground">{t("queue.title")}</span>
        <span className="rounded-full bg-helix-soft px-1.5 py-0.5 font-mono text-xs text-helix">
          {t("queue.badge", { n: items.length })}
        </span>
        {items.length > 0 && !confirmMode ? (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:scale-95"
          >
            <Trash2 size={11} />
            {t("queue.clear")}
          </button>
        ) : null}
      </div>

      {/* 队列满提示（输入框内容保留，由输入区旁提示承接） */}
      {fullNotice ? (
        <p className="border-b border-border/70 bg-pet-gold-soft/60 px-3 py-1.5 text-xs text-pet-amber-deep">
          {t("queue.full", { n: capacity })}
        </p>
      ) : null}

      {/* 清空找回条（5s 窗口） */}
      {undoAvailable ? (
        <button
          type="button"
          onClick={onUndoClear}
          className="flex w-full items-center gap-1.5 border-b border-border/70 px-3 py-2 text-left text-xs text-helix transition-colors hover:bg-helix-soft/40"
        >
          <RotateCcw size={11} className="shrink-0" />
          {t("queue.undoClear")}
        </button>
      ) : null}

      {/* 刷新恢复待确认态 */}
      {confirmMode ? (
        <div className="border-b border-border/70 px-3 py-2">
          <p className="text-xs font-medium text-foreground">{t("queue.confirmTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("queue.confirmHint")}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={onConfirmResend}
              className="flex items-center gap-1 rounded-lg bg-helix-soft px-2.5 py-1 text-xs font-medium text-helix transition-all hover:bg-helix/10 active:scale-[0.98]"
            >
              <Play size={11} />
              {t("queue.resumeNext")}
            </button>
            <button
              type="button"
              onClick={onConfirmDiscard}
              className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-all hover:bg-secondary hover:text-foreground active:scale-[0.98]"
            >
              {t("queue.clearAll")}
            </button>
          </div>
        </div>
      ) : null}

      {/* 失败暂停态 */}
      {paused && items.length > 0 && !confirmMode ? (
        <div className="border-b border-border/70 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t("queue.paused")}</p>
          <button
            type="button"
            onClick={onResumeNext}
            className="mt-1.5 flex items-center gap-1 rounded-lg bg-helix-soft px-2.5 py-1 text-xs font-medium text-helix transition-all hover:bg-helix/10 active:scale-[0.98]"
          >
            <Play size={11} />
            {t("queue.resumeNext")}
          </button>
        </div>
      ) : null}

      {/* 排队项列表 */}
      {items.length > 0 ? (
        <ul className="max-h-36 overflow-y-auto px-2 py-1.5">
          {items.map((item, idx) => (
            <li key={item.queue_id} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5">
              <span className="w-4 shrink-0 text-center font-mono text-xs text-muted-foreground/70">{idx + 1}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={item.content}>
                {item.content}
              </span>
              <button
                type="button"
                onClick={() => onCancel(item.queue_id)}
                title={t("queue.cancel")}
                aria-label={t("queue.cancel")}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:scale-95"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}