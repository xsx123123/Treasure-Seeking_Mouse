// chatClient.ts：对话服务前端封装（流式请求 + SSE 解析）。
// VITE_CHAT_API 指向本地自托管对话服务（server/local.mjs，如 http://localhost:8787）；
// 改设为 /chat-api 可走 vite dev 同源代理（单端口，局域网可用）。
import { getDeviceId } from "@/services/deviceId";
import { readLang, translate } from "@/i18n";

const CHAT_API: string = (import.meta.env.VITE_CHAT_API || "").trim();

export function chatEndpoint(): string {
  return CHAT_API || "http://localhost:8787";
}

export interface ChatMessageDTO {
  role: "user" | "assistant";
  content: string;
}

export interface ResultCard {
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

/** grounding 校验下发的未证实标识（status: upstream_404 = 回源查无此号；unverified = 未核验） */
export interface GroundingItem {
  id: string;
  status: string;
}

export interface GroundingPayload {
  unconfirmed: GroundingItem[];
  confirmed: string[];
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onTool: (evt: { name: string; label: string; status: "running" | "done" | "error"; ms?: number; error?: string }) => void;
  onCards: (cards: ResultCard[]) => void;
  /** 正文↔证据一致性校验（可选事件，旧服务端不下发；向后兼容的可选回调） */
  onGrounding?: (payload: GroundingPayload) => void;
  onEnd: (payload: { cards: ResultCard[]; tools: ToolLog[] }) => void;
  onError: (message: string) => void;
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // 使用统计去重标识：登录用户用账号 token 的 Bearer，访客用设备指纹
    // （服务端只存哈希键，不关联对话内容）
    "X-Stats-Actor": getDeviceId(),
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
  integrations?: Record<string, string>;
}

export async function fetchUsageStats(): Promise<UsageStats | null> {
  try {
    const resp = await fetch(`${chatEndpoint()}/stats`, { headers: authHeaders() });
    if (!resp.ok) return null;
    return (await resp.json()) as UsageStats;
  } catch {
    return null;
  }
}

/** GET 模型目录（失败由调用方兜底，不抛出）：兼容两种上游响应形态 */
export async function fetchModelCatalog(): Promise<{ models: string[]; defaultModel: string | null } | null> {
  try {
    const resp = await fetch(chatEndpoint(), {
      headers: authHeaders(),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    // 网关注入形态：{ models: [...], defaultModel }
    if (Array.isArray(json.models)) return json;
    // 标准 OpenAI 形态：{ object: 'list', data: [{ id, ... }] }
    if (Array.isArray(json.data)) {
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

/** POST 流式对话；返回的 Promise 在流结束/出错时 resolve。
 *  SSE 解析为 else-if 链：未知事件类型透明跳过（「只加不改」协议的前端侧保障——
 *  服务端新增帧类型对旧前端零影响）。 */
export async function requestChat(
  messages: ChatMessageDTO[],
  model: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  lang: "zh" | "en" = "zh",
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(chatEndpoint(), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ messages, model, stream: true, lang }),
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
      if (typeof j?.error === "string") detail = j.error;
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue; // 忽略 ": ping" 心跳
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const obj = JSON.parse(payload);
          if (typeof obj.delta === "string" && obj.delta) handlers.onDelta(obj.delta);
          else if (obj.event === "tool") handlers.onTool(obj);
          else if (obj.event === "cards" && Array.isArray(obj.cards)) handlers.onCards(obj.cards);
          else if (obj.event === "grounding" && Array.isArray(obj.unconfirmed)) {
            handlers.onGrounding?.({
              unconfirmed: obj.unconfirmed,
              confirmed: Array.isArray(obj.confirmed) ? obj.confirmed : [],
            });
          }
          else if (obj.event === "end") handlers.onEnd({ cards: obj.cards ?? [], tools: obj.tools ?? [] });
          else if (typeof obj.error === "string") handlers.onError(obj.error);
          // 未知事件类型：透明跳过（协议「只加不改」）
        } catch {
          /* 忽略非法行 */
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") handlers.onError(translate(readLang(), "err.interrupted"));
  }
}