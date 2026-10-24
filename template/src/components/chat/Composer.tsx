// 对话输入区：多行输入 + 模型选择 + 发送/停止
import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { useI18n } from "@/i18n/provider";

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
}): React.ReactElement {
  const { t } = useI18n();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [localValue, setLocalValue] = useState(value);

  // 输入法组合期间保持本地受控：组合中间态频繁上抛会打断 IME 提交（中文输入关键约束）
  useEffect(() => {
    if (!composingRef.current && value !== localValue) setLocalValue(value);
  }, [value, localValue]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [localValue]);

  function submit(): void {
    const text = localValue.trim();
    if (!text || streaming || disabled) return;
    setLocalValue("");
    onValueChange("");
    onEngage?.();
    onSend(text);
  }

  return (
    <div className={welcome ? "w-full" : "border-t border-border bg-background px-4 py-3 sm:px-6"}>
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-lg border border-helix/40 bg-card p-3 shadow-soft transition-colors focus-within:border-helix focus-within:ring-2 focus-within:ring-ring">
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
            placeholder={t("composer.placeholder")}
            aria-label={t("composer.placeholder")}
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
              className="flex h-9 shrink-0 items-center gap-1.5 justify-center rounded-lg bg-primary px-3 text-cap font-medium text-primary-foreground shadow-soft transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={15} />
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
              className="rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-muted-foreground shadow-soft outline-none transition-colors hover:border-helix/50 focus:border-helix"
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