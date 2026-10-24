// seqout-chat Edge Function 前端封装：流式请求 + SSE 解析
import { projectUrlId, supabase, supabaseUrl, isOfflineMode } from "@/supabase/client";
import { getLocalToken } from "./localIdentity";
import { consumeChatStream } from "../lib/chatStream.ts";
import { getDeviceId } from "@/services/statsStore";
import { readLang, translate } from "@/i18n";

// 自托管模式：VITE_CHAT_API 指向任意 OpenAI 兼容对话服务（如本地 server/local.mjs 的 http://localhost:8787）
// 未设置时走 Meoo 平台 Edge Function（须带 OneDay-App-Id 头）
const CHAT_API: string = (import.meta.env.VITE_CHAT_API || "").trim();

export function chatEndpoint(): string {
  return CHAT_API || `${supabaseUrl}/functions/v1/seqout-chat`;
}

export interface ChatMessageDTO {
  role: "user" | "assistant";
  content: string;
}

export interface DatasetCard {
  tool: string;
  accession: string;
  title: string;
  summary: string;
  meta: Record<string, string>;
}

export interface ToolLog {
  name: string;
  label: string;
  ok: boolean;
  ms: number;
}

/** grounding 校验下发的未证实编号（status: upstream_404 = 回源查无此号；unverified = 未核验） */
export interface GroundingItem {
  id: string;
  status: string;
}

export interface GroundingPayload {
  unconfirmed: GroundingItem[];
  confirmed: string[];
}

/** 任务状态通知帧（协议新增，旧服务端不下发） */
export interface TaskEventFrame {
  event: "task";
  task_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";
  session_ref?: string;
  queue_id?: string;
  error?: string;
  seq?: number;
}

/** 续传流首帧：断点前全量快照（completion 恒为 'running' 语义锚） */
export interface SnapshotFrame {
  event: "snapshot";
  task_id: string;
  seq: number;
  content: string;
  cards: DatasetCard[];
  tools: ToolLog[];
  grounding?: GroundingPayload;
  boost?: { accession: string | null };
  completion: "running";
}

/** 任务摘要（list 响应项） */
export interface TaskSummary {
  task_id: string;
  session_ref: string;
  status: string;
  queue_id: string | null;
  created_at: string;
  finished_at: string | null;
  error: string | null;
}

/** 结果拉取载荷（终态一次性响应） */
export interface TaskResultPayload {
  task_id: string;
  status: string;
  message?: {
    content: string;
    cards: DatasetCard[];
    toolLogs: ToolLog[];
    grounding?: GroundingPayload;
    boost?: { accession: string | null };
    error?: string;
  };
  session_ref?: string;
  finished_at?: string;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onTool: (evt: { name: string; label: string; status: "running" | "done" | "error"; ms?: number; error?: string }) => void;
  onCards: (cards: DatasetCard[]) => void;
  onPolariseq?: (accession: string | null) => void;
  /** 正文↔证据一致性校验：正文引用但未在证据卡片/回源核验中证实的编号清单（可选事件，旧服务端不下发） */
  onGrounding?: (payload: GroundingPayload) => void;
  /** 任务状态通知（可选事件，协议新增；旧服务端不下发） */
  onTask?: (frame: TaskEventFrame) => void;
  /** 续传快照（resume 流首帧；全量重置语义，非增量拼接） */
  onSnapshot?: (frame: SnapshotFrame) => void;
  /** end 帧：cards/tools 为最终累积；task_id 为协议新增可选字段（任务化路径标识） */
  onEnd: (payload: { cards: DatasetCard[]; tools: ToolLog[]; task_id?: string }) => void;
  onError: (message: string) => void;
}

async function authHeaders(): Promise<Record<string, string>> {
  const session = (await supabase.auth.getSession()).data.session;
  return {
    "Content-Type": "application/json",
    ...(projectUrlId ? { "OneDay-App-Id": projectUrlId } : {}),
    ...((isOfflineMode ? getLocalToken() : session?.access_token) ? { Authorization: `Bearer ${isOfflineMode ? getLocalToken() : session!.access_token}` } : {}),
    // 使用统计去重标识：登录用户用 user id，访客用设备指纹（服务端只存哈希键，不关联对话内容）
    "X-Stats-Actor": session?.user?.id ?? getDeviceId(),
  };
}

/** 服务端使用统计（GET <endpoint>/stats）：对话次数 / token / 去重人数 / 每个工具调用次数 */
export interface UsageStats {
  chats: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
  actors: number;
  tools: { name: string; label: string; count: number; errors: number; empties: number }[];
  since: string;
  updatedAt: string;
}

export async function fetchUsageStats(): Promise<UsageStats | null> {
  try {
    const resp = await fetch(`${chatEndpoint()}/stats`, { headers: await authHeaders() });
    if (!resp.ok) return null;
    return (await resp.json()) as UsageStats;
  } catch {
    return null;
  }
}

/** GET 模型目录（失败由调用方兜底，不抛出）；成功时解析能力位 capabilities.tasks 存模块级（页面生命周期内求值一次） */
let catalogCapabilities: { enabled: boolean; maxConcurrent: number | null } = { enabled: false, maxConcurrent: null };

/** 能力位读取（降级判定唯一事实源：目录响应缺 capabilities.tasks = 旧服务端 → enabled:false） */
export function tasksCapability(): { enabled: boolean; maxConcurrent: number | null } {
  return catalogCapabilities;
}

export async function fetchModelCatalog(): Promise<{ models: string[]; defaultModel: string | null } | null> {
  const parseCaps = (json: Record<string, unknown>) => {
    const caps = json?.capabilities as Record<string, unknown> | undefined;
    catalogCapabilities = caps?.tasks === true
      ? { enabled: true, maxConcurrent: typeof caps.task_max_concurrent === 'number' ? caps.task_max_concurrent : null }
      : { enabled: false, maxConcurrent: null };
  };
  try {
    const resp = await fetch(chatEndpoint(), {
      headers: await authHeaders(),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    // Meoo 网关形态：{ models: [...], defaultModel }
    if (Array.isArray(json.models)) { parseCaps(json); return json; }
    // 标准 OpenAI 形态：{ object: 'list', data: [{ id, ... }] }
    if (Array.isArray(json.data)) {
      parseCaps(json);
      const ids: string[] = [];
      for (const m of json.data as unknown[]) {
        if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
          ids.push((m as { id: string }).id);
        }
      }
      return {
        models: ids,
        defaultModel: typeof json.defaultModel === "string" ? json.defaultModel : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** POST 流式对话；返回的 Promise 在流结束/出错时 resolve。可选 queueId/sessionRef 进入任务化路径（缺省=旧行为） */
export async function requestSeqoutChat(
  messages: ChatMessageDTO[],
  model: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  lang: "zh" | "en" = "zh",
  taskOpts?: { queueId?: string; sessionRef?: string },
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(chatEndpoint(), {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        messages, model, stream: true, lang,
        ...(taskOpts?.queueId ? { queue_id: taskOpts.queueId } : {}),
        ...(taskOpts?.sessionRef ? { session_ref: taskOpts.sessionRef } : {}),
      }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    handlers.onError(translate(readLang(), "err.connect"));
    return;
  }
  if (!response.ok) {
    let detail = translate(readLang(), "err.requestFailed", { status: response.status });
    try {
      const j = await response.json();
      if (typeof j?.error === "string") detail = j.error === "unauthorized" ? translate(readLang(), "reliability.loginRequired") : j.error;
    } catch {
      /* ignore */
    }
    handlers.onError(detail);
    return;
  }
  if (!response.body) {
    handlers.onError(translate(readLang(), "err.noStream"));
    return;
  }

  await consumeChatStream(response.body, handlers, () => translate(readLang(), "err.interrupted"), signal);
}

/* ---------- 任务 action API（复用 authHeaders 三身份头，禁新造鉴权路径） ---------- */

async function postTaskAction(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(chatEndpoint(), {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
    signal,
  });
}

/** 404 统一映射：任务不存在或无权访问（归属不符与不存在无区分） */
const NOT_FOUND_MESSAGE = () => translate(readLang(), "task.notFound");

/**
 * 续传：任务进行中 → SSE 流（snapshot 帧 → 缓冲重放 → 实时增量）；
 * 已终态 → 按 ResultPayload 解析返回（竞态收口）。
 */
export async function resumeTask(
  taskId: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<{ kind: "stream" } | { kind: "result"; payload: TaskResultPayload } | { kind: "error"; message: string }> {
  let response: Response;
  try {
    response = await postTaskAction({ action: "resume", task_id: taskId }, signal);
  } catch (err) {
    if ((err as Error).name === "AbortError") return { kind: "error", message: "" };
    return { kind: "error", message: translate(readLang(), "err.connect") };
  }
  if (response.status === 404) return { kind: "error", message: NOT_FOUND_MESSAGE() };
  if (!response.ok) return { kind: "error", message: translate(readLang(), "err.requestFailed", { status: response.status }) };
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    await consumeChatStream(response.body, handlers, () => translate(readLang(), "err.interrupted"), signal);
    return { kind: "stream" };
  }
  try {
    return { kind: "result", payload: (await response.json()) as TaskResultPayload };
  } catch {
    return { kind: "error", message: translate(readLang(), "err.requestFailed", { status: response.status }) };
  }
}

/** 结果拉取（非流式一次性响应） */
export async function fetchTaskResult(taskId: string, signal?: AbortSignal): Promise<TaskResultPayload | null> {
  try {
    const resp = await postTaskAction({ action: "result", task_id: taskId }, signal);
    if (!resp.ok) return null;
    return (await resp.json()) as TaskResultPayload;
  } catch {
    return null;
  }
}

/** 取消（幂等语义由服务端保证：已终态返回当前终态） */
export async function cancelTask(taskId: string): Promise<{ task_id: string; status: string } | null> {
  try {
    const resp = await postTaskAction({ action: "cancel", task_id: taskId });
    if (!resp.ok) return null;
    return (await resp.json()) as { task_id: string; status: string };
  } catch {
    return null;
  }
}

/** 页面打开时恢复扫描：本身份活跃/可恢复任务清单 */
export async function listMyTasks(signal?: AbortSignal): Promise<TaskSummary[] | null> {
  try {
    const resp = await postTaskAction({ action: "list" }, signal);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { tasks?: TaskSummary[] };
    return Array.isArray(json.tasks) ? json.tasks : null;
  } catch {
    return null;
  }
}
