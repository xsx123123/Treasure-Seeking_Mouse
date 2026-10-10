// 左侧会话栏：品牌头、新对话、搜索与分组历史、账号入口。
import { useState } from "react";
import { LogIn, LogOut, MessageSquare, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useIsTouch } from "@/hooks/use-touch";
import mouseAvatar from "@/assets/pet/mouse-wink.webp";
import { useI18n } from "@/i18n/provider";
import type { SessionRow } from "@/services/chatStore";

export function SessionSidebar({
  sessions,
  activeId,
  userLabel,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onLogin,
  onGuestTry,
  onLogout,
  storageNote,
}: {
  sessions: SessionRow[];
  activeId: string | null;
  userLabel: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onLogin?: () => void;
  /** 「不登录，先试试」：收起侧栏/抽屉，直接以游客身份用（与 onLogin 并列的逃逸口） */
  onGuestTry?: () => void;
  onLogout: () => void;
  storageNote?: string; // 游客存储策略提示（未登录时展示在侧栏底部）
}): React.ReactElement {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const isTouch = useIsTouch();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today);
  week.setDate(week.getDate() - 7);
  const groups = (["today", "yesterday", "week", "earlier"] as const).map((key) => ({
    key,
    rows: sessions.filter((session) => {
      if (!session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return false;
      const time = new Date(session.updated_at).getTime();
      const group = time >= +today ? "today" : time >= +yesterday ? "yesterday" : time >= +week ? "week" : "earlier";
      return group === key;
    }).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
  }));

  function commitRename(id: string): void {
    const t = draft.trim();
    if (t) onRename(id, t);
    setEditingId(null);
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-panel">
      <div className="flex items-center gap-3 px-4 pb-3 pt-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-pet-gold-soft shadow-sm ring-1 ring-pet-amber/30">
          {/* 阿寻的动画形象（眨眼大头贴）：双层结构——内层承载 idle 起伏，
              外层负责裁切与金色底托。scale/keyframe 都写 transform，
              落同一元素会互相覆盖，故拆开。 */}
          <span className="pet-idle flex h-full w-full items-center justify-center">
            <img
              src={mouseAvatar}
              alt={t("pet.alt")}
              draggable={false}
              className="h-full w-full object-contain drop-shadow-sm"
            />
          </span>
        </span>
        <div className="min-w-0">
          <p className="font-display truncate text-[16px] font-semibold tracking-tight">{t("brand.name")}</p>
          <p className="truncate text-[11px] text-muted-foreground">{t("brand.tagline")}</p>
        </div>
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-miner-green-hover"
        >
          <Plus size={15} /> {t("sidebar.newChat")}
        </button>
      </div>

      <label className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-muted-foreground focus-within:border-helix">
        <Search size={14} className="shrink-0" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("sidebar.search")} aria-label={t("sidebar.search")} className="min-w-0 w-full bg-transparent text-xs text-foreground outline-none" />
      </label>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {sessions.length === 0 ? (
          <p className="mt-6 text-center text-xs text-muted-foreground/70">{t("sidebar.empty")}</p>
        ) : (
          <div className="space-y-4">
            {groups.every((group) => group.rows.length === 0) && <p className="py-4 text-center text-xs text-muted-foreground">{t("sidebar.noResults")}</p>}
            {groups.filter((group) => group.rows.length > 0).map((group) => (
            <section key={group.key}>
            <h2 className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">{t(`sidebar.${group.key}`)}</h2>
            <ul className="space-y-1">
            {group.rows.map((s) => (
              <li key={s.id}>
                <div
                  className={`group flex min-h-11 items-center gap-2 rounded-lg px-2.5 py-2.5 text-[13px] transition-colors ${
                    s.id === activeId
                      ? "bg-card text-foreground shadow-sm ring-1 ring-helix/25"
                      : "text-muted-foreground hover:bg-card/70 hover:text-foreground"
                  }`}
                >
                  <MessageSquare size={13} className="shrink-0 opacity-60" />
                  {editingId === s.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(s.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      maxLength={40}
                      className="min-w-0 flex-1 rounded border border-helix/50 bg-background px-1.5 py-0.5 text-[13px] outline-none"
                    />
                  ) : (
                    <button type="button" title={s.title} onClick={() => onSelect(s.id)} className="min-w-0 flex-1 truncate text-left">
                      {s.title}
                    </button>
                  )}
                  <span className={`flex shrink-0 items-center gap-1 ${isTouch ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
                    <button
                      type="button"
                      title={t("sidebar.rename")}
                      onClick={() => {
                        setEditingId(s.id);
                        setDraft(s.title);
                      }}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      title={t("sidebar.delete")}
                      onClick={() => onDelete(s.id)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
              </li>
            ))}
            </ul>
            </section>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3 border-t border-border px-3 py-3">
        {userLabel ? (
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={userLabel}>
              {userLabel}
            </span>
            <button
              type="button"
              onClick={onLogout}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
            >
              <LogOut size={12} /> {t("sidebar.logout")}
            </button>
          </div>
        ) : onLogin ? (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={onLogin}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[12.5px] text-foreground transition-colors hover:border-helix/50 hover:text-helix"
            >
              <LogIn size={13} /> {t("sidebar.loginCta")}
            </button>
            {onGuestTry ? (
              <button
                type="button"
                onClick={onGuestTry}
                className="story-link block w-full py-0.5 text-center text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("sidebar.guestTry")}
              </button>
            ) : null}
          </div>
        ) : null}
        {!userLabel && storageNote ? (
          <p className="border-t border-border/60 pt-2 text-[10.5px] leading-relaxed text-muted-foreground/70">{storageNote}</p>
        ) : null}
      </div>
    </aside>
  );
}

export function MobileDrawerHeader({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <span className="text-sm font-semibold">{t("sidebar.listTitle")}</span>
      <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground">
        <X size={16} />
      </button>
    </div>
  );
}
