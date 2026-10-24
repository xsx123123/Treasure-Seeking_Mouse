// GEO寻宝鼠：主页（会话栏 + 对话区 + 登录弹窗 + 桌宠）
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronsLeft, ChevronsRight, Info, Menu, Moon, Sun, BarChart3, PawPrint, Trophy } from "lucide-react";
import { supabase, isOfflineMode } from "@/supabase/client";
import type { Session } from "@supabase/supabase-js";
import { EmptyState } from "@/components/chat/EmptyState";
import { ChatMessage, type ChatUIMessage } from "@/components/chat/ChatMessage";
import { Composer } from "@/components/chat/Composer";
import { SessionSidebar, MobileDrawerHeader } from "@/components/chat/SessionSidebar";
import { BrandMark } from "@/components/BrandMark";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { TreasureMouse, makePetEvent, type PetEvent } from "@/components/pet/TreasureMouse";
import { PetSettingsPanel } from "@/components/pet/PetSettingsPanel";
import { onHintShown, onHintDismissed } from "@/lib/hintBus";
import { useIsTouch } from "@/hooks/use-touch";
import { useVisualViewport } from "@/hooks/use-visual-viewport";
import { readTheme, writeTheme, applyTheme, type Theme } from "@/services/petStore";
import { bumpStats, mergeLocalStatsToAccount } from "@/services/statsStore";
import {
  localMe,
  localLogout,
  readLocalUser,
  type LocalUser,
} from "@/services/localAuth";
import { requestId } from "@/lib/requestId";
import { useLocalHistory } from "@/hooks/use-local-history";
import { conversationAccumulator, decodeMetadata, encodeMetadata } from "@/lib/conversationState";
import { addTreasure } from "@/services/petStore";
import { Leaderboard } from "@/components/chat/Leaderboard";
import { UsageStatsDialog } from "@/components/chat/UsageStatsDialog";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useI18n } from "@/i18n/provider";

import { fetchModelCatalog, requestSeqoutChat, type DatasetCard, type ToolLog } from "@/services/seqoutChat";
import {
  createSession,
  deleteSession,
  insertMessage,
  listMessages,
  listSessions,
  renameSession,
  touchSession,
  type SessionRow,
} from "@/services/chatStore";

export const Route = createFileRoute("/")({
  component: ChatPage,
});

const FALLBACK_MODEL = "qwen3.8-flash";
const TEMP_SESSION_ID_KEY = "seqout-temp-session-id";
const RAIL_COLLAPSED_KEY = "seqout-sidebar-collapsed"; // '1' = 收起（默认），'0' = 展开
const GUEST_MAX_SESSIONS = 50; // 游客（未登录）最多保留的会话条数
const GUEST_KEEP_DAYS = 7; // 游客会话最后活跃后保留天数

interface LocalSession {
  id: string;
  title: string;
  messages: ChatUIMessage[];
  ts: number; // 最后活跃时间（ms），用于 7 天过期清理
}

const uid = requestId;

function initialTempSessionId(): string {
  try {
    const existing = sessionStorage.getItem(TEMP_SESSION_ID_KEY);
    if (existing) return existing;
    const id = uid();
    sessionStorage.setItem(TEMP_SESSION_ID_KEY, id);
    return id;
  } catch {
    return uid();
  }
}

function ChatPage(): React.ReactElement {
  // 软键盘适配：写入 --vvh，根容器据此收缩（见 use-visual-viewport.ts）
  useVisualViewport();
  const { t, lang } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null); // null = 本地临时会话
  const [localId, setLocalId] = useState<string>(initialTempSessionId);
  const [messageSessionId, setMessageSessionId] = useState(localId);
  const [welcomeSuppressed, setWelcomeSuppressed] = useState(false);
  const [messages, setMessages] = useState<ChatUIMessage[]>([]);
  const [composerDraft, setComposerDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<string[]>([FALLBACK_MODEL]);
  const [model, setModel] = useState(FALLBACK_MODEL);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      writeTheme(next);
      applyTheme(next);
      return next;
    });
  }, []);
  const [petEvent, setPetEvent] = useState<PetEvent | null>(null); // 桌宠事件流（仅 UI 反馈，不影响消息逻辑）
  const [petPanelOpen, setPetPanelOpen] = useState(false); // 顶栏「阿寻设置」弹层：找回阿寻 / 大小 / 常驻
  // 设置面板 portal 到 body 定位：面板留在 header 内会被后绘制的主内容区/抽屉（z-50）盖住
  // （2026-10-06 实测踩坑：空态 Hero 卡压设置面板），故以触发按钮 rect 计算 fixed 坐标挂 body
  const petBtnRef = useRef<HTMLButtonElement | null>(null);
  const [petPanelPos, setPetPanelPos] = useState({ top: 0, right: 0 });
  const togglePetPanel = (): void => {
    if (!petPanelOpen) {
      const r = petBtnRef.current?.getBoundingClientRect();
      if (r) setPetPanelPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    }
    setPetPanelOpen((o) => !o);
  };
  // 编号发现提示 ⇆ 桌宠联动：抽签点亮某个编号时让阿寻喊话「那里有宝藏」；
  // 用户悬停/点开该编号（提示消失）时立即收起台词，形成一来一回的对话感
  useEffect(() => {
    const offShown = onHintShown(() => setPetEvent(makePetEvent({ type: "hint" })));
    const offDismiss = onHintDismissed(() => setPetEvent(makePetEvent({ type: "hint_end" })));
    return () => {
      offShown();
      offDismiss();
    };
  }, []);
  const petCardsRef = useRef(0);
  const [boardOpen, setBoardOpen] = useState(false); // 排行榜抽屉
  const [statsOpen, setStatsOpen] = useState(false); // 使用统计弹窗
  const isTouch = useIsTouch();
  const statRef = useRef({ digs: 0, cards: 0 }); // 本轮挖宝统计（下铲次数 / 出土卡片数）
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
  const catalogOkRef = useRef(false); // 模型目录是否加载成功；失败时发送空模型名，由服务端 LLM_MODEL 兜底，避免前端兜底模型在网关上不存在
  const user = session?.user ?? null;

  // 自托管本地账号（离线模式）：启动用本地缓存立即恢复，再向服务端校验 token
  const [localUser, setLocalUser] = useState<LocalUser | null>(() => (isOfflineMode ? readLocalUser() : null));
  const [identityVerified, setIdentityVerified] = useState(!isOfflineMode);
  const [identityError, setIdentityError] = useState(false);
  const identityGeneration = useRef(0);
  const verifyIdentity = useCallback(async () => {
    const generation = ++identityGeneration.current;
    setIdentityVerified(false); setIdentityError(false);
    try {
      const u = await localMe();
      if (generation === identityGeneration.current) { setLocalUser(u); setIdentityVerified(true); }
    } catch { if (generation === identityGeneration.current) setIdentityError(true); }
  }, []);
  useEffect(() => {
    if (!isOfflineMode) return;
    void verifyIdentity();
    const listener = (e: StorageEvent) => { if (e.key === 'seqout-local-token') void verifyIdentity(); };
    window.addEventListener('storage', listener);
    return () => { identityGeneration.current++; window.removeEventListener('storage', listener); };
  }, [verifyIdentity]);
  const localHistory = useLocalHistory(isOfflineMode ? localUser?.id ?? null : null, identityVerified);
  const scope = user ? `supabase:${user.id}` : localHistory.scope;
  const scopeEpoch = useRef({ scope, generation: 0 });
  if (scopeEpoch.current.scope !== scope) scopeEpoch.current = { scope, generation: scopeEpoch.current.generation + 1 };
  const scopeRef = useRef('');
  scopeRef.current = `${scope}:${scopeEpoch.current.generation}`;
  const [messageScope, setMessageScope] = useState(scope);
  useEffect(() => {
    abortRef.current?.abort();
    const id = uid();
    setMessages([]); setComposerDraft(''); setActiveId(null); setLocalId(id); setMessageSessionId(id); setMessageScope(scope);
    setStreaming(false); sendingRef.current = false;
    cloudSaveRef.current = null; setPersistenceError(null);
  }, [scope]);
  /** 有效用户：云端登录优先，其次自托管本地账号；未登录为 null */
  const effUser = user ?? localUser;

  // Catalog requests are scoped too: a slow guest response cannot overwrite a logged-in catalog.
  useEffect(() => {
    let cancelled = false;
    catalogOkRef.current = false;
    void fetchModelCatalog().then(c => {
      if (!cancelled && c && c.models.length) {
        catalogOkRef.current = true; setModels(c.models);
        setModel(c.defaultModel && c.models.includes(c.defaultModel) ? c.defaultModel : c.models[0]);
      }
    });
    return () => { cancelled = true; };
  }, [effUser?.id]);

  // 认证状态
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // 登录后拉云端会话；未登录时侧栏显示 localStorage 本地会话（一直在保存，此前未展示）
  useEffect(() => {
    if (!user) {
      setSessions([]);
      setActiveId(null);
      return;
    }
    let cancelled = false;
    void listSessions().then(rows => { if (!cancelled) setSessions(rows); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [user]);

  const localSessions = [...localHistory.sessions].sort((a, b) => b.ts - a.ts);
  useEffect(() => {
    if (user || messageScope !== scope || messageSessionId !== localId || !identityVerified || messages.length === 0) return;
    const timer = setTimeout(() => localHistory.store.save({
      id: localId, title: messages.find(m => m.role === 'user')?.content.slice(0, 24) ?? t('sidebar.newChat'),
      messages: messages.map(({ streaming, liveTools, ...m }) => m), ts: Date.now(),
    }), streaming ? 400 : 0);
    return () => clearTimeout(timer);
  }, [user, localId, messages, messageScope, scope, messageSessionId, identityVerified, streaming, localHistory.store, t]);
  const displaySessions: SessionRow[] = user ? sessions : localSessions.map(s => ({ id: s.id, title: s.title, updated_at: new Date(s.ts).toISOString() }));
  async function handleLocalAuthSuccess(u: LocalUser): Promise<void> {
    identityGeneration.current++;
    setLocalUser(u); setIdentityVerified(true); setIdentityError(false); setAuthOpen(false);
    void mergeLocalStatsToAccount();
  }
  const cloudSaveRef = useRef<(() => Promise<void>) | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [importIds, setImportIds] = useState<string[]>([]);
  // 切换会话时加载消息（登录走云端；未登录走本地会话）
  // 不依赖 localSessions：它被持久化 effect 高频刷新，靠 ref 读取避免流式期间整组 effect 重跑
  const localSessionsRef = useRef<LocalSession[]>(localSessions);
  useEffect(() => {
    localSessionsRef.current = localSessions;
  }, [localSessions]);
  useEffect(() => {
    if (!activeId) return;
    if (!user) {
      const local = localSessionsRef.current.find((s) => s.id === activeId);
      setMessages(local ? local.messages : []); setMessageSessionId(activeId);
      return;
    }
    let cancelled = false;
    void listMessages(activeId)
      .then((rows) => {
        if (cancelled) return;
        setMessageSessionId(activeId);
        setMessages(
          rows.map((r) => ({
            id: r.id,
            role: r.role,
            content: r.content,
            cards: r.cards,
            toolLogs: r.tool_logs,
            ...decodeMetadata(r.metadata),
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user, activeId]);

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
    const id = uid();
    setLocalId(id); setMessageSessionId(id);
    try {
      sessionStorage.setItem(TEMP_SESSION_ID_KEY, id);
    } catch {
      /* session identity remains valid for this render */
    }
    setWelcomeSuppressed(false);
    setDrawerOpen(false);
  }, [streaming]);

  const selectSession = useCallback(
    (id: string) => {
      if (streaming) return;
      setComposerDraft("");
      setActiveId(id);
      if (!user) setLocalId(id);
      setWelcomeSuppressed(true);
      setDrawerOpen(false);
    },
    [streaming, user],
  );

  async function handleSend(text: string, historyOverride?: ChatUIMessage[], restoreOnError = false): Promise<void> {
    text = text.trim();
    if (!text || sendingRef.current || messageSessionId !== (activeId ?? localId) || messageScope !== scope || (isOfflineMode && !identityVerified)) return;
    const requestScope = scopeRef.current;
    const requestStore = localHistory.store;
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

    const accumulator = conversationAccumulator(asstMsg.id);
    let finalMessage: ChatUIMessage = asstMsg;
    statRef.current = { digs: 0, cards: 0 };
    petCardsRef.current = 0; // 每轮重置：否则开箱动画只在当页第一个回答触发一次

    function patch(fn: (m: ChatUIMessage) => ChatUIMessage): void {
      if (scopeRef.current !== requestScope) return;
      setMessages((prev) => prev.map((m) => (m.id === asstMsg.id ? fn(m) : m)));
    }

    try {
      await requestSeqoutChat(
      [...history, { role: "user", content: text }],
      catalogOkRef.current ? model : "", // 目录加载失败时留空，由服务端 LLM_MODEL 兜底
      {
        onDelta: (text) => { accumulator.delta(text); patch(m => ({ ...m, content: m.content + text })); },
        onTool: (evt) => {
          if (scopeRef.current !== requestScope) return;
          if (evt.status !== "running") accumulator.tool({ name: evt.name, label: evt.label, ok: evt.status === "done", ms: evt.ms ?? 0 });
          if (evt.status === "running") {
            statRef.current.digs += 1;
            // 文献检索走专属「读书」剧场，其余工具仍是挖宝
            setPetEvent(makePetEvent(evt.name === "literature_search" ? { type: "lit_start" } : { type: "tool_start" }));
          }
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
          accumulator.cards(cards);
          if (scopeRef.current !== requestScope) return;
          const cumulative = accumulator.snapshot().cards;
          if (petCardsRef.current === 0 && cards.length) setPetEvent(makePetEvent({
            type: cards[0]?.meta?.source === 'literature' ? 'lit_cards' : 'cards', count: cumulative.length,
          }));
          petCardsRef.current = cumulative.length;
          patch(m => ({ ...m, cards: cumulative }));
        },
        onPolariseq: (accession) => { accumulator.boost(accession); patch(m => ({ ...m, boost: { accession } })); },
        onGrounding: (g) => { accumulator.grounding(g); patch(m => ({ ...m, grounding: g })); },
        onEnd: (p) => { accumulator.end(p.cards, p.tools); },
        onError: (message) => {
          accumulator.error(message);
          if (scopeRef.current !== requestScope) return;
          setPetEvent(makePetEvent({ type: "error" }));
          patch((m) => ({ ...m, error: message }));
          if (restoreOnError) setComposerDraft((draft) => draft || text);
        },
      },
      controller.signal,
      lang,
      );
    } catch {
      accumulator.error(t("err.interrupted"));
      if (scopeRef.current === requestScope) setPetEvent(makePetEvent({ type: "error" }));
      patch((m) => ({ ...m, error: t("err.interrupted") }));
      if (restoreOnError) setComposerDraft((draft) => draft || text);
    } finally {
      finalMessage = accumulator.snapshot();
      patch(m => ({ ...m, ...finalMessage, liveTools: undefined }));
      if (scopeRef.current === requestScope) {
        setStreaming(false); abortRef.current = null; sendingRef.current = false;
        statRef.current.cards = finalMessage.cards?.length ?? 0;
        if (statRef.current.cards) addTreasure(statRef.current.cards);
        setPetEvent(makePetEvent({ type: 'done', cards: statRef.current.cards }));
      }
      if (!user) requestStore.save({ id: localId, title: text.slice(0, 24),
        messages: [...source, userMsg, finalMessage].map(({ streaming, liveTools, ...m }) => m), ts: Date.now() });
    }
    if (scopeRef.current !== requestScope) return;

    // 排行榜统计上报（fire-and-forget，失败静默）
    if (accumulator.ended || finalMessage.content || finalMessage.cards?.length) void bumpStats(
      { treasures: statRef.current.cards, digs: statRef.current.digs, chats: 1 },
      { isGuest: !effUser, userId: effUser?.id, username: effUser?.email ?? "" },
    );

    // Keep stable message IDs and a retry closure so a missing schema/network failure is recoverable.
    if (user && (finalMessage.content || finalMessage.cards?.length)) {
      let sid = activeId;
      const persistCloud = async () => {
        if (scopeRef.current !== requestScope) return;
        try {
          if (!sid) {
            const row = await createSession(user.id, text.slice(0, 30)); sid = row.id;
            if (scopeRef.current !== requestScope) return;
            setSessions(prev => [row, ...prev]);
          } else { void touchSession(sid); }
          await insertMessage(sid, user.id, { id: userMsg.id, role: 'user', content: text });
          if (scopeRef.current !== requestScope) return;
          await insertMessage(sid, user.id, { id: finalMessage.id, role: 'assistant', content: finalMessage.content,
            cards: finalMessage.cards ?? null, tool_logs: finalMessage.toolLogs ?? null, metadata: encodeMetadata(finalMessage) });
          if (scopeRef.current !== requestScope) return;
          setActiveId(sid); setPersistenceError(null); cloudSaveRef.current = null;
        } catch { if (scopeRef.current === requestScope) setPersistenceError(t('reliability.cloudSave')); }
      };
      cloudSaveRef.current = persistCloud;
      await persistCloud();
    }
  }

  async function handleRename(id: string, title: string): Promise<void> {
    if (!user) {
      const item = localSessions.find(s => s.id === id);
      if (item) localHistory.store.save({ ...item, title, ts: Date.now() });
      return;
    }
    try {
      await renameSession(id, title);
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    } catch {
      /* ignore */
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!user) {
      // 未登录：删除 localStorage 本地会话
      localHistory.store.remove(id);
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
        const id = uid(); setLocalId(id); setMessageSessionId(id);
      }
      return;
    }
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch {
      /* ignore */
    }
  }

  async function handleLogout(): Promise<void> {
    if (streaming) return;
    if (isOfflineMode) {
      // 自托管账号：服务端无状态会话，清本地 token 即登出；本机聊天记录保留在 localStorage
      identityGeneration.current++;
      localLogout();
      setLocalUser(null); setIdentityVerified(true);
      setMessages([]);
      setActiveId(null);
      const id = uid(); setLocalId(id); setMessageSessionId(id);
      return;
    }
    await supabase.auth.signOut();
    setMessages([]);
    setActiveId(null);
    const id = uid(); setLocalId(id); setMessageSessionId(id);
  }

  /** 重新挖一次：截断到该助手消息之前，用其前最近一条用户提问 + 截断后的历史重发 */
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
      userLabel={user ? (user.email ?? user.id.slice(0, 8)) : (localUser?.email ?? null)}
      onSelect={selectSession}
      onNew={startNew}
      onRename={handleRename}
      onDelete={handleDelete}
      onLogin={() => setAuthOpen(true)}
      onGuestTry={() => {
        setDrawerOpen(false);
        setCollapsed(true);
      }}
      onLogout={handleLogout}
      storageNote={
        effUser
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
      models={models}
      model={model}
      onModelChange={setModel}
      streaming={streaming}
      value={composerDraft}
      onValueChange={setComposerDraft}
      welcome={messages.length === 0}
      onEngage={() => setWelcomeSuppressed(true)}
      onSend={(text) => void handleSend(text)}
      disabled={(isOfflineMode && !identityVerified) || messageSessionId !== (activeId ?? localId)}
      onStop={() => abortRef.current?.abort()}
    />
  );

  return (
    <div
      className="bg-grid touch-clean flex overflow-hidden"
      style={{ height: "var(--vvh, 100dvh)" }}
    >
      {/* PC 侧栏：默认收起为窄边条，点击展开 */}
      {collapsed ? (
        <div className="hidden w-12 shrink-0 flex-col items-center border-r border-border bg-panel py-3 md:flex">
          <button
            type="button"
            onClick={toggleCollapsed}
            title={t("header.expandSessions")}
            aria-label={t("header.expandSessions")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-rail-icon transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ChevronsRight size={17} />
          </button>
          <span className="mt-4 flex h-8 w-8 items-center justify-center rounded-lg bg-helix-soft text-helix ring-1 ring-helix/20">
            <BrandMark size={16} />
          </span>
          {/* 窄边条背景是浅米面板，muted-foreground 太淡近乎看不见；
              用 rail-icon 纯色（见 styles.css：alpha 修饰符的 oklab 描边在 Chromium 有渲染 bug） */}
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
          <div className="absolute inset-0 overlay-dim" onClick={() => setDrawerOpen(false)} />
          <div className="safe-t absolute inset-y-0 left-0 w-[280px] max-w-[85%] shadow-soft-lg">
            <MobileDrawerHeader onClose={() => setDrawerOpen(false)} />
            <div className="h-[calc(100%-49px)]">{sidebar}</div>
          </div>
        </div>
      ) : null}

      {/* 主区 */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="safe-t flex items-center gap-1 border-b border-border bg-panel/70 px-2 py-2.5 sm:gap-2 sm:px-4 md:px-6">
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
              ? sessions.find((s) => s.id === activeId)?.title ?? t("brand.name")
              : user
                ? t("header.newChat")
                : t("brand.name")}
          </h1>
          <button
            type="button"
            onClick={() => setBoardOpen(true)}
            title={t("header.leaderboard")}
            aria-label={t("header.leaderboardAria")}
            className={`${user ? "" : "ml-auto "}rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-pet-amber-deep`}
          >
            <Trophy size={17} />
          </button>
          <button
            type="button"
            onClick={() => setStatsOpen(true)}
            title={t("header.stats")}
            aria-label={t("header.statsAria")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-helix"
          >
            <BarChart3 size={17} />
          </button>
          <Link
            to="/about"
            onClick={() => {
              setWelcomeSuppressed(true);
              try {
                sessionStorage.setItem(`seqout-welcome-complete:${activeId ?? localId}`, "1");
              } catch {
                /* Ignore unavailable session storage. */
              }
            }}
            title={t("header.about")}
            aria-label={t("header.aboutAria")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-pet-amber-deep"
          >
            <Info size={17} />
          </Link>
          <LanguageToggle />
          <span className="relative">
            <button
              ref={petBtnRef}
              type="button"
              onClick={togglePetPanel}
              title={t("pet.settings.gear")}
              aria-label={t("pet.settings.gear")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-pet-amber-deep"
            >
              <PawPrint size={17} />
            </button>
            {petPanelOpen
              ? createPortal(
                  <>
                    <div className="fixed inset-0 z-[60]" onClick={() => setPetPanelOpen(false)} />
                    <div
                      className="fixed z-[60]"
                      style={{ top: petPanelPos.top, right: petPanelPos.right }}
                    >
                      <PetSettingsPanel onClose={() => setPetPanelOpen(false)} />
                    </div>
                  </>,
                  document.body,
                )
              : null}
          </span>
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "dark" ? t("header.themeDark") : t("header.themeLight")}
            aria-label={t("header.themeAria")}
            className={`rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-pet-amber-deep`}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </header>

        {(identityError || localHistory.error || persistenceError) ? <div role="status" className="border-b border-border bg-card px-4 py-2 text-sm text-destructive">
          {persistenceError || t(identityError ? 'reliability.identity' : localHistory.error === 'history_storage' ? 'reliability.storage' : localHistory.error === 'history_invalid' ? 'reliability.invalidHistory' : 'reliability.sync')}
          <button className="ml-3 underline" onClick={() => { if (persistenceError && cloudSaveRef.current) { void cloudSaveRef.current(); return; } setPersistenceError(null); if (isOfflineMode) { if (identityError) void verifyIdentity(); else void localHistory.store.start(); } }}>{t('reliability.retry')}</button>
        </div> : null}
        {!user && localHistory.pending.length > 0 ? <details className="border-b border-border bg-card px-4 py-2 text-sm">
          <summary>{t('reliability.legacy')}</summary>
          <p className="my-2 text-muted-foreground">{t('reliability.legacyHint')}</p>
          {localHistory.pending.map(s => <label key={s.id} className="my-1 flex gap-2"><input type="checkbox" checked={importIds.includes(s.id)} onChange={e => setImportIds(ids => e.target.checked ? [...ids, s.id] : ids.filter(id => id !== s.id))} />{s.title}</label>)}
          <button className="mt-2 underline disabled:opacity-40" disabled={!importIds.length || !identityVerified} onClick={() => { localHistory.store.importLegacy(importIds); setImportIds([]); }}>{t('reliability.import')}</button>
        </details> : null}

        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState composer={composer} submitting={streaming} onPick={(q) => void handleSend(q, undefined, true)} />
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
              {messages.map((m, idx) => (
                <ChatMessage
                  key={m.id}
                  msg={m}
                  onRegenerate={handleRegenerate}
                  onPickSuggestion={(q) => void handleSend(q)}
                  linkHint={m.role === "assistant" && idx === messages.length - 1}
                />
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
        onSuccess={(u) => {
          if (u) {
            // 自托管本地登录：保留当前画面，合并服务端历史 + 排行榜成绩
            void handleLocalAuthSuccess(u);
            return;
          }
          setAuthOpen(false);
          setMessages([]);
          setActiveId(null);
        }}
      />

      {/* 寻宝鼠桌宠 */}
      <TreasureMouse
        event={petEvent}
        welcome={activeId === null && messages.length === 0 && !welcomeSuppressed}
        welcomeSessionKey={activeId ?? localId}
      />

      {/* 挖宝排行榜：离线本地账号的 id 即邮箱，行键 u:<email> 可直接高亮"我" */}
      <Leaderboard open={boardOpen} onClose={() => setBoardOpen(false)} ownUserId={effUser?.id ?? null} />
      <UsageStatsDialog open={statsOpen} onClose={() => setStatsOpen(false)} />
    </div>
  );
}
