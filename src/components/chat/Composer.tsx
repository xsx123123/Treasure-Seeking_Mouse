// 对话输入区（下铲指挥台）：多行输入 + 模型选择 + 下铲/停止
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileUp, Shovel, Square } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { emitPetTyping } from "@/lib/petBus";

export function Composer({
  models,
  model,
  onModelChange,
  streaming,
  disabled,
  onSend,
  onStop,
  value,
  onValueChange,
  onEngage,
  welcome = false,
  onTyping = emitPetTyping,
  paperMode = false,
  onPaperInput,
  onQueue,
  queueSlot,
}: {
  models: string[];
  model: string;
  onModelChange: (m: string) => void;
  streaming: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  value: string;
  onValueChange: (value: string) => void;
  onEngage?: () => void;
  welcome?: boolean;
  onTyping?: (active: boolean) => void;
  paperMode?: boolean;
  onPaperInput?: (file: File) => void;
  /** 能力位开启时由编排层提供：streaming 中提交走入队（缺省=旧服务端维持拒绝） */
  onQueue?: (text: string) => "ok" | "full";
  /** QueuePanel 挂载位（输入区附近，由编排层接线） */
  queueSlot?: ReactNode;
}): React.ReactElement {
  const { t } = useI18n();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [localValue, setLocalValue] = useState(value);

  // Keep the textarea locally controlled while an IME is composing. Updating
  // the Vue shell for every provisional pinyin string can remount/reconcile
  // the React island and cancel the composition before Chinese text commits.
  useEffect(() => {
    if (!composingRef.current && value !== localValue) setLocalValue(value);
  }, [value, localValue]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [localValue]);

  // 输入联动：有字符时阿寻竖起耳朵随时准备出发（桌宠经 petBus 感知）
  useEffect(() => {
    onTyping(localValue.trim().length > 0);
    return () => onTyping(false);
  }, [localValue, onTyping]);

  function submit(): void {
    const text = localValue.trim();
    if (!text || disabled) return;
    if (streaming) {
      // 能力位开启且有进行中任务 → 入队；能力位缺省（旧服务端）→ 维持拒绝（降级形态与现状一致）
      if (onQueue) {
        const r = onQueue(text);
        if (r === "ok") {
          setLocalValue("");
          onValueChange("");
        }
        // 'full' 时输入框内容保留（异常 5.1.3-1），提示由 QueuePanel 呈现
      }
      return;
    }
    setLocalValue("");
    onValueChange("");
    onEngage?.();
    onSend(text);
  }

  return (
    <div className={welcome ? "w-full" : "safe-b border-t border-border bg-background px-4 py-3 sm:px-6"}>
      <div className="mx-auto max-w-3xl">
        {queueSlot}
        <div className="flex items-end gap-2 rounded-lg border border-helix/40 bg-card p-3 shadow-soft transition-[border-color,box-shadow] duration-150 focus-within:border-helix focus-within:ring-2 focus-within:ring-ring">
          {paperMode && onPaperInput ? <>
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onEngage?.();
                onPaperInput(file);
              }
              event.currentTarget.value = "";
            }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={disabled || streaming} title={t("paper.attach")} aria-label={t("paper.attach")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-helix/50 hover:text-helix disabled:opacity-40"><FileUp size={15} /></button>
          </> : null}
          <textarea
            ref={taRef}
            rows={welcome ? 2 : 1}
            value={localValue}
            onFocus={onEngage}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              const next = e.currentTarget.value;
              setLocalValue(next);
              onValueChange(next);
            }}
            onChange={(e) => {
              const next = e.target.value;
              setLocalValue(next);
              if (!composingRef.current) onValueChange(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !composingRef.current) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t(paperMode ? "paper.composerPlaceholder" : "composer.placeholder")}
            aria-label={t(paperMode ? "paper.composerPlaceholder" : "composer.placeholder")}
            className="max-h-40 min-h-[40px] min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
            disabled={disabled}
          />
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              title={t("composer.stop")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-destructive/40 bg-destructive/5 text-destructive transition-colors hover:bg-destructive/10"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!localValue.trim() || disabled}
              title={t("composer.sendAria")}
              className="flex h-9 shrink-0 items-center gap-1.5 justify-center rounded-lg bg-miner-green px-3 text-cap font-medium text-primary-foreground shadow-soft transition-all hover:bg-miner-green-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Shovel size={15} />
              <span className="hidden sm:inline">{t("composer.send")}</span>
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <span className="font-mono">model</span>
            <select
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              className="rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-muted-foreground shadow-soft outline-none transition-colors hover:border-miner-green/50 focus:border-miner-green"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <span>{t("composer.disclaimer")}</span>
        </div>
      </div>
    </div>
  );
}
