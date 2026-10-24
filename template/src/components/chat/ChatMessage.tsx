// 单条聊天消息：用户右对齐气泡 / 助手左对齐 + Markdown + 工具轨迹 + 结果卡片 + 复制/重试
import { useState } from "react";
import { Bot, Check, Copy, RotateCcw, User } from "lucide-react";
import { Markdown } from "./Markdown";
import { ToolTrace, type LiveToolEvent } from "./ToolTrace";
import { ResultCardGrid } from "./ResultCard";
import { GroundingNotice } from "./GroundingNotice";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/i18n/provider";
import type { ResultCard, GroundingPayload, ToolLog } from "@/services/chatClient";

/**
 * 操作按钮组的显隐类：桌面端悬停/聚焦浮现，触摸端常显
 * （触屏无 hover，若沿用悬停显隐会导致复制/重发按钮永久不可见）
 */
const REVEAL_ON_HOVER = "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100";
const ALWAYS_SHOWN = "opacity-100 transition-opacity duration-150";

export interface ChatUIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  cards?: ResultCard[] | null;
  toolLogs?: ToolLog[] | null;
  /** grounding 校验结果：正文引用但未在证据卡片/回源核验中证实的标识（服务端 event: grounding） */
  grounding?: GroundingPayload | null;
  streaming?: boolean;
  liveTools?: LiveToolEvent[];
  error?: string | null;
}

function ActionButton({ label, onClick, children }: { label: string; onClick?: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** 悬停浮现的操作按钮组（复制成功 2s 内保持勾选态） */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  function copy(text: string): void {
    void copyText(text).then((ok) => {
      if (!ok) return; // 两种通道都失败就不显示"已复制"，避免假成功
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return [copied, copy];
}

/** 触屏检测（hover 媒体查询）：触屏常显操作按钮 */
function useIsTouch(): boolean {
  const [isTouch, setIsTouch] = useState(false);
  useState(() => {
    try {
      setIsTouch(window.matchMedia("(hover: none)").matches);
    } catch {
      /* ignore */
    }
  });
  return isTouch;
}

export function ChatMessage({
  msg,
  onRegenerate,
}: {
  msg: ChatUIMessage;
  onRegenerate?: (id: string) => void;
}): React.ReactElement {
  const { t } = useI18n();
  const [copied, copy] = useCopy();
  const isTouch = useIsTouch();
  // grounding 核验与意图规划条目写进 tool_logs 仅供审计，UI 轨迹里过滤掉：
  // 它们不是一次"检索"，留在轨迹里会虚增调用计数、未证实时还会被渲染成红色错误胶囊
  const visibleToolLogs = (msg.toolLogs ?? []).filter((l) => l.name !== "grounding_check" && l.name !== "intent_plan");

  if (msg.role === "user") {
    return (
      <div className="group flex items-center justify-end gap-1.5">
        <div className={`flex items-center gap-0.5 ${isTouch ? ALWAYS_SHOWN : REVEAL_ON_HOVER}`}>
          <ActionButton label={copied ? t("msg.copied") : t("msg.copyQuestion")} onClick={() => copy(msg.content)}>
            {copied ? <Check size={13} className="text-helix" /> : <Copy size={13} />}
          </ActionButton>
        </div>
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-soft whitespace-pre-wrap break-words">
          {msg.content}
        </div>
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
          <User size={14} />
        </span>
      </div>
    );
  }

  const hasBody = msg.content.length > 0 || msg.streaming;
  const showActions = !msg.streaming && (msg.content.length > 0 || !!msg.error);
  return (
    <div className="group flex gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-helix-soft text-helix ring-1 ring-helix/20">
        <Bot size={15} />
      </span>
      <div className="min-w-0 max-w-[92%] flex-1">
        <p className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground/80">
          <span className="font-semibold tracking-wide text-foreground/70">{t("brand.agentName")}</span>
          {visibleToolLogs.length > 0 && !msg.streaming ? (
            <span className="font-mono opacity-70">
              {t("msg.searches", { n: visibleToolLogs.length, ms: visibleToolLogs.reduce((a, l) => a + (l.ms ?? 0), 0) })}
            </span>
          ) : null}
        </p>
        {visibleToolLogs.length > 0 || (msg.liveTools?.length ?? 0) > 0 ? (
          <ToolTrace logs={visibleToolLogs} live={msg.liveTools} />
        ) : null}
        {hasBody ? (
          <div className="rounded-xl rounded-tl-sm border border-border bg-card px-4 py-3 shadow-soft">
            {msg.content ? <Markdown text={msg.content} /> : null}
            {!msg.content && msg.streaming ? (
              <span className="text-cap text-muted-foreground">{t("msg.thinking")}</span>
            ) : null}
            {msg.streaming && msg.content ? (
              <span className="typing-caret inline-block" aria-hidden />
            ) : null}
          </div>
        ) : null}
        {!msg.streaming && msg.cards && msg.cards.length > 0 ? (
          <ResultCardGrid cards={msg.cards} />
        ) : null}
        {!msg.streaming && msg.grounding && msg.grounding.unconfirmed.length > 0 ? (
          <GroundingNotice unconfirmed={msg.grounding.unconfirmed} />
        ) : null}
        {msg.error ? (
          <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-cap text-destructive">
            {msg.error}
          </p>
        ) : null}
        {showActions ? (
          <div className={`mt-1.5 flex items-center gap-0.5 ${isTouch ? ALWAYS_SHOWN : REVEAL_ON_HOVER}`}>
            {msg.content ? (
              <ActionButton label={copied ? t("msg.copied") : t("msg.copyAnswer")} onClick={() => copy(msg.content)}>
                {copied ? <Check size={13} className="text-helix" /> : <Copy size={13} />}
              </ActionButton>
            ) : null}
            {onRegenerate ? (
              <ActionButton label={t("msg.regenerate")} onClick={() => onRegenerate(msg.id)}>
                <RotateCcw size={13} />
              </ActionButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}