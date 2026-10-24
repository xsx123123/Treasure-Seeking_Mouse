// 主页（会话栏 + 对话区 + 登录弹窗）：handleSend 主流程 + 会话切换 + 游客/登录双模式 + 主题切换
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight, Menu, Moon, Sun } from "lucide-react";
import { Bot } from "lucide-react";
import { EmptyState } from "@/components/chat/EmptyState";
import { ChatMessage, type ChatUIMessage } from "@/components/chat/ChatMessage";
import { Composer } from "@/components/chat/Composer";
import { SessionSidebar, MobileDrawerHeader, type SessionRow } from "@/components/chat/SessionSidebar";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { isOfflineMode } from "@/services/cloudAdapter";
import {
  localMe,
  localLogout,
  pullServerHistory,
  pushServerHistory,
  readLocalUser,
  type LocalUser,
} from "@/services/localAuth";
import { useI18n } from "@/i18n/provider";

import { fetchModelCatalog, requestChat, type ResultCard, type ToolLog } from "@/services/chatClient";

const FALLBACK_MODEL = "";
const LOCAL_SESSION_KEY = "{{PROJECT_SLUG}}-local-session";
const RAIL_COLLAPSED_KEY = "{{PROJECT_SLUG}}-sidebar-collapsed"; // '1' = 收起（默认），'0' = 展开
const THEME_KEY = "{{PROJECT_SLUG}}-theme";
// 游客（未登录）本地会话策略：与后端 config.ts 的 AGENT_GUEST_* 对齐（前端常量镜像，改配置时两处同步）
const GUEST_MAX_SESSIONS = 50; // 最多保留的会话条数
const GUEST_KEEP_DAYS = 7;     // 最后活跃后保留天数（读取时过滤）
const HISTORY_SYNC_DEBOUNCE_MS = 800; // 登录历史快照同步防抖

type Theme = "light" | "dark";

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyTheme(theme: Theme): void {
  try {
    document.documentElement.classList.toggle("dark", theme === "dark");
  } catch {
    /* ignore */
  }
}

interface LocalSession {
  id: string;
  title: string;
  messages: ChatUIMessage[];
  ts: number; // 最后活跃时间（ms），用于过期过滤
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readLocalSessions(): LocalSession[] {
  try {
    const raw = localStorage.getItem(LOCAL_SESSION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as (LocalSession & { ts?: number })[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - GUEST_KEEP_DAYS * 24 * 3600 * 1000;
    return parsed
      .map((s) => ({ ...s, ts: typeof s.ts === "number" ? s.ts : Date.now() })) // 旧数据补时间戳
      .filter((s) => s.ts >= cutoff) // 读取时过滤过期会话（写入不清理，避免写路径变重）
      .slice(-GUEST_MAX_SESSIONS);
  } catch {
    return [];
  }
}

function writeLocalSessions(list: LocalSession[]): void {
  try {
    localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(list.slice(-GUEST_MAX_SESSIONS)));
  } catch {
    /* 容量满时静默丢弃 */
  }
}

export function ChatPage(): React.ReactElement {
  const { t, lang, toggleLang } = useI18n();
  const [authOpen, setAuthOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null); // null = 本地临时会话
  const [localId, setLocalId] = useState<string>(uid);
  const [messages, setMessages] = useState<ChatUIMessage[]>([]);
  const [composerDraft, setComposerDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(FALLBACK_MODEL);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch { /* ignore */ }
      applyTheme(next);
      return next;
    });
  }, []);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(RAIL_COLLAPSED_KEY);
      return v === null ? true : v === "1"; // 从未设置过 → 默认收起；否则记住上次选择
    } catch {
      return true;
    }
  });
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false); // 同一帧内的连续点击也只能启动一轮请求
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const catalogOkRef = useRef(false); // 模型目录是否加载成功；失败时发送空模型名，由服务端 LLM_MODEL 兜底

  // 自托管本地账号（离线模式，模板默认形态）：启动用本地缓存立即恢复，再向服务端校验 token
  const [localUser, setLocalUser] = useState<LocalUser | null>(() => (isOfflineMode ? readLocalUser() : null));
  useEffect(() => {
    if (!isOfflineMode) return;
    void localMe().then((u) => {
      if (u) setLocalUser(u);
    });
  }, []);
  const effUser = localUser;

  // 模型目录
  useEffect(() => {
    void fetchModelCatalog().then((c) => {
      if (c && c.models.length > 0) {
        catalogOkRef.current = true;
        setModels(c.models);
        const def = c.defaultModel && c.models.includes(c.defaultModel) ? c.defaultModel : c.models[0];
        setModel(def);
      }
    });
  }, []);

  // 本地会话列表状态（未登录试用）
  const [localSessions, setLocalSessions] = useState<LocalSession[]>(() => readLocalSessions());

  // 本地临时会话持久化（未登录试用）：写 localStorage 并同步侧栏列表
  // 流式期间 messages 每 delta 变一次，直接落盘会全量 JSON 序列化 + 刷新侧栏 → 回答越长越卡；
  // 这里对中间态做 400ms debounce，仅在停止变化（或流结束）后统一落盘
  useEffect(() => {
    if (effUser) return;
    const timer = setTimeout(() => {
      const list = readLocalSessions();
      const idx = list.findIndex((s) => s.id === localId);
      const entry: LocalSession = {
        id: localId,
        title: messages.find((m) => m.role === "user")?.content.slice(0, 24) ?? t("header.newChat"),
        messages,
        ts: Date.now(),
      };
      if (idx >= 0) list[idx] = entry;
      else if (messages.length > 0) list.push(entry);
      writeLocalSessions(list);
      setLocalSessions(list.filter((s) => s.messages.length > 0).reverse()); // 侧栏显示：最近活跃在前
    }, 400);
    return () => clearTimeout(timer);
  }, [effUser, localId, messages, t]);

  // 侧栏数据源：本地会话（登录后服务端为唯一来源的同步见下）
  const displaySessions: SessionRow[] = effUser
    ? localSessions.map((s) => ({ id: s.id, title: s.title, updated_at: new Date(s.ts).toISOString() }))
    : localSessions.map((s) => ({ id: s.id, title: s.title, updated_at: new Date(s.ts).toISOString() }));

  // 本地登录：本地会话仍是消息状态的唯一来源，这里把整份快照防抖同步到服务端账号
  // （localStorage 写入 ⇄ 侧栏刷新都会触发 localSessions 变化，防抖合并多次落盘）
  useEffect(() => {
    if (!isOfflineMode || !localUser) return;
    const timer = setTimeout(() => {
      void pushServerHistory(readLocalSessions().filter((s) => s.messages.length > 0)).catch(() => undefined);
    }, HISTORY_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [localUser, localSessions]);

  // 本地登录成功：合并服务端与本机会话（同 id 取较新）
  async function handleLocalAuthSuccess(u: LocalUser): Promise<void> {
    setLocalUser(u);
    setAuthOpen(false);
    try {
      const remote = await pullServerHistory();
      if (remote.length > 0) {
        const local = readLocalSessions();
        const merged = [...remote] as LocalSession[];
        for (const s of local) {
          const i = merged.findIndex((r) => r.id === s.id);
          if (i >= 0) {
            if ((s.ts ?? 0) > ((merged[i] as LocalSession).ts ?? 0)) merged[i] = s;
          } else {
            merged.push(s);
          }
        }
        writeLocalSessions(merged);
        setLocalSessions(merged.filter((s) => (s.messages?.length ?? 0) > 0).reverse() as LocalSession[]);
      }
    } catch {
      /* 服务端历史不可达时保留本地现状 */
    }
  }

  // 切换会话时加载消息（本地会话；靠 ref 读取避免流式期间整组 effect 重跑）
  const localSessionsRef = useRef<LocalSession[]>(localSessions);
  useEffect(() => {
    localSessionsRef.current = localSessions;
  }, [localSessions]);
  useEffect(() => {
    if (!activeId) return;
    const local = localSessionsRef.current.find((s) => s.id === activeId);
    setMessages(local ? local.messages : []);
  }, [activeId]);

  // 流式期间每分片一次 smooth scrollIntoView 会互相打断产生抖动：
  // 中间态直接把容器 scrollTop 推到底（auto），仅流结束/消息数变化时平滑滚动
  const lastCountRef = useRef(0);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (streaming) {
      el.scrollTop = el.scrollHeight;
      lastCountRef.current = messages.length;
      return;
    }
    if (messages.length !== lastCountRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      lastCountRef.current = messages.length;
    }
  }, [messages, streaming]);

  const startNew = useCallback(() => {
    if (streaming) return;
    setComposerDraft("");
    setMessages([]);
    setActiveId(null); // 首条消息发送时再建会话
    setLocalId(uid());
    setDrawerOpen(false);
  }, [streaming]);

  const selectSession = useCallback(
    (id: string) => {
      if (streaming) return;
      setComposerDraft("");
      setActiveId(id);
      setDrawerOpen(false);
    },
    [streaming],
  );

  async function handleSend(text: string, historyOverride?: ChatUIMessage[]): Promise<void> {
    text = text.trim();
    if (!text || sendingRef.current) return;
    sendingRef.current = true;
    // historyOverride：重新生成时传入截断后的消息，避免闭包里的全量 messages 把已废弃回答带给模型
    const source = historyOverride ?? messages;
    const history: { role: "user" | "assistant"; content: string }[] = source
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));

    const userMsg: ChatUIMessage = { id: uid(), role: "user", content: text };
    const asstMsg: ChatUIMessage = { id: uid(), role: "assistant", content: "", streaming: true, liveTools: [] };
    setMessages((prev) => [...prev, userMsg, asstMsg]);

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    let finalCards: ResultCard[] = [];
    const finalTools: ToolLog[] = [];

    function patch(fn: (m: ChatUIMessage) => ChatUIMessage): void {
      setMessages((prev) => prev.map((m) => (m.id === asstMsg.id ? fn(m) : m)));
    }

    try {
      await requestChat(
      [...history, { role: "user", content: text }],
      catalogOkRef.current ? model : "", // 目录加载失败时留空，由服务端 LLM_MODEL 兜底
      {
        onDelta: (t) => patch((m) => ({ ...m, content: m.content + t })),
        onTool: (evt) => {
          patch((m) => {
            const live = [...(m.liveTools ?? [])];
            if (evt.status === "running") live.push({ name: evt.name, label: evt.label, status: "running" });
            else {
              const i = live.findIndex((l) => l.name === evt.name && l.status === "running");
              if (i >= 0) live[i] = { name: evt.name, label: evt.label, status: evt.status, ms: evt.ms };
              else live.push({ name: evt.name, label: evt.label, status: evt.status, ms: evt.ms });
            }
            return { ...m, liveTools: live };
          });
        },
        onCards: (cards) => {
          finalCards = cards;
          patch((m) => ({ ...m, cards }));
        },
        onGrounding: (g) => {
          patch((m) => ({ ...m, grounding: g }));
        },
        onEnd: (p) => {
          finalCards = p.cards.length > 0 ? p.cards : finalCards;
          finalTools.push(...p.tools);
        },
        onError: (message) => {
          patch((m) => ({ ...m, error: message }));
        },
      },
      controller.signal,
      lang,
      );
    } catch {
      patch((m) => ({ ...m, error: t("err.interrupted") }));
    } finally {
      patch((m) => ({ ...m, streaming: false, liveTools: undefined, toolLogs: finalTools, cards: finalCards }));
      setStreaming(false);
      abortRef.current = null;
      sendingRef.current = false;
    }
  }

  function handleRename(id: string, title: string): void {
    // 本地会话重命名：直接改写 localStorage 条目
    const list = readLocalSessions();
    const idx = list.findIndex((s) => s.id === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], title };
      writeLocalSessions(list);
      setLocalSessions(list.filter((s) => s.messages.length > 0).reverse());
    }
  }

  function handleDelete(id: string): void {
    writeLocalSessions(readLocalSessions().filter((s) => s.id !== id));
    setLocalSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setMessages([]);
      setLocalId(uid());
    }
  }

  function handleLogout(): void {
    if (streaming) return;
    // 自托管账号：服务端无状态会话，清本地 token 即登出；本机聊天记录保留在 localStorage
    localLogout();
    setLocalUser(null);
    setMessages([]);
    setActiveId(null);
    setLocalId(uid());
  }

  /** 重新生成：截断到该助手消息之前，用其前最近一条用户提问 + 截断后的历史重发 */
  function handleRegenerate(id: string): void {
    if (sendingRef.current) return;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    let q: string | null = null;
    let questionIndex = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        q = messages[i].content;
        questionIndex = i;
        break;
      }
    }
    if (!q) return;
    const truncated = messages.slice(0, questionIndex);
    setMessages(truncated);
    void handleSend(q, truncated);
  }

  const sidebar = (
    <SessionSidebar
      sessions={displaySessions}
      activeId={activeId}
      userLabel={localUser?.email ?? null}
      onSelect={selectSession}
      onNew={startNew}
      onRename={handleRename}
      onDelete={handleDelete}
      onLogin={() => setAuthOpen(true)}
      onGuestTry={() => setDrawerOpen(false)}
      onLogout={handleLogout}
      storageNote={
        localUser
          ? undefined
          : t("sidebar.guestNote", {
              n: GUEST_MAX_SESSIONS,
              d: GUEST_KEEP_DAYS,
              loginSuffix: t("sidebar.guestNoteLogin"),
            })
      }
    />
  );

  const composer = (
    <Composer
      models={models.length > 0 ? models : [model || "default"]}
      model={model || "default"}
      onModelChange={setModel}
      streaming={streaming}
      value={composerDraft}
      onValueChange={setComposerDraft}
      welcome={messages.length === 0}
      onSend={(text) => void handleSend(text)}
      onStop={() => abortRef.current?.abort()}
    />
  );

  return (
    <div className="flex overflow-hidden" style={{ height: "100dvh" }}>
      {/* PC 侧栏：默认收起为窄边条，点击展开 */}
      {collapsed ? (
        <div className="hidden w-12 shrink-0 flex-col items-center border-r border-border bg-panel py-3 md:flex">
          <button
            type="button"
            onClick={toggleCollapsed}
            title={t("header.expandSessions")}
            aria-label={t("header.expandSessions")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ChevronsRight size={17} />
          </button>
          <span className="mt-4 flex h-8 w-8 items-center justify-center rounded-lg bg-helix-soft text-helix ring-1 ring-helix/20">
            <Bot size={16} />
          </span>
        </div>
      ) : (
        <div className="relative hidden w-[270px] shrink-0 md:block">
          {sidebar}
          <button
            type="button"
            onClick={toggleCollapsed}
            title={t("header.collapseSessions")}
            aria-label={t("header.collapseSessions")}
            className="absolute -right-3 top-5 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-soft transition-colors hover:border-helix/50 hover:text-helix"
          >
            <ChevronsLeft size={13} />
          </button>
        </div>
      )}

      {/* H5 抽屉 */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="overlay-dim absolute inset-0" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[280px] max-w-[85%] shadow-soft-lg">
            <MobileDrawerHeader onClose={() => setDrawerOpen(false)} />
            <div className="h-[calc(100%-49px)]">{sidebar}</div>
          </div>
        </div>
      ) : null}

      {/* 主区 */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1 border-b border-border bg-panel/70 px-2 py-2.5 sm:gap-2 sm:px-4 md:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden"
            aria-label={t("header.openSessions")}
          >
            <Menu size={18} />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
            {activeId
              ? displaySessions.find((s) => s.id === activeId)?.title ?? t("brand.name")
              : t("brand.name")}
          </h1>
          <button
            type="button"
            onClick={toggleLang}
            title={t("header.langToggle")}
            aria-label={t("header.langToggle")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <span className="text-xs font-semibold">{lang === "zh" ? "EN" : "中"}</span>
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "dark" ? t("header.themeDark") : t("header.themeLight")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </header>

        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState composer={composer} submitting={streaming} onPick={(q) => void handleSend(q)} />
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
              {messages.map((m) => (
                <ChatMessage key={m.id} msg={m} onRegenerate={handleRegenerate} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {messages.length > 0 ? composer : null}
      </main>

      <AuthDialog
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onSuccess={(u) => void handleLocalAuthSuccess(u)}
      />
    </div>
  );
}