// 自托管本地账号：注册 / 登录 / 聊天历史快照同步 / 排行榜上报（走 VITE_CHAT_API 同一服务端）
// 仅在 isOfflineMode（未配 Supabase）时启用；token 存 localStorage，服务端 scrypt 校验口令。
import { chatEndpoint } from "@/services/seqoutChat";
import { getDeviceId } from "@/services/statsStore";

import { getLocalToken, LOCAL_TOKEN_KEY as KEY_TOKEN, LOCAL_USER_KEY as KEY_USER } from "./localIdentity";
import type { HistorySnapshot, HistorySession } from "../../shared/history.ts";
export { getLocalToken } from "./localIdentity";


export interface LocalUser {
  id: string; // = email
  email: string;
  name: string;
}

export function readLocalUser(): LocalUser | null {
  try {
    const raw = localStorage.getItem(KEY_USER);
    if (!raw) return null;
    const u = JSON.parse(raw) as LocalUser;
    return u && u.email ? u : null;
  } catch {
    return null;
  }
}

function persist(user: LocalUser | null, token?: string): void {
  try {
    if (user) localStorage.setItem(KEY_USER, JSON.stringify(user));
    else localStorage.removeItem(KEY_USER);
    if (token !== undefined) {
      if (token) localStorage.setItem(KEY_TOKEN, token);
      else localStorage.removeItem(KEY_TOKEN);
    }
  } catch {
    /* ignore */
  }
}

export class LocalApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

async function req<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; token?: string; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth !== false) {
    const token = opts.token ?? getLocalToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const resp = await fetch(`${chatEndpoint()}${path}`, {
    method: opts.method ?? "GET",
    headers, signal: opts.signal,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new LocalApiError(resp.status, data.error ?? `HTTP ${resp.status}`);
  return data;
}

/** 启动时用本地 token 恢复登录态；服务端不可用时返回 null（保持游客） */
export async function localMe(): Promise<LocalUser | null> {
  const token = getLocalToken();
  if (!token) return null;
  try {
    const me = await req<{ email: string; name: string }>("/auth/me", { token });
    if (getLocalToken() !== token) throw new Error("identity_changed");
    const user: LocalUser = { id: me.email, email: me.email, name: me.name };
    persist(user);
    return user;
  } catch (err) {
    if (err instanceof LocalApiError && err.status === 401 && getLocalToken() === token) { persist(null, ""); return null; }
    throw err;
  }
}

export async function localLogin(email: string, password: string): Promise<LocalUser> {
  const r = await req<{ token: string; email: string; name: string }>("/auth/login", {
    method: "POST",
    body: { email, password },
    auth: false,
  });
  const user: LocalUser = { id: r.email, email: r.email, name: r.name };
  persist(user, r.token);
  return user;
}

export async function localRegister(email: string, password: string, name: string): Promise<LocalUser> {
  const r = await req<{ token: string; email: string; name: string }>("/auth/register", {
    method: "POST",
    body: { email, password, name },
    auth: false,
  });
  const user: LocalUser = { id: r.email, email: r.email, name: r.name };
  persist(user, r.token);
  return user;
}

export function localLogout(): void {
  persist(null, "");
}

// ---------- 聊天历史快照（整包同步：小数据量、幂等、易合并） ----------

export type LocalSessionSnapshot = HistorySession;
export async function pullServerHistory(token: string, signal?: AbortSignal): Promise<HistorySnapshot> {
  const r = await req<HistorySnapshot & { protocol_version?: number }>("/history", { token, signal });
  if (r.protocol_version !== 2) throw new LocalApiError(428, 'history_protocol_upgrade_required');
  return r;
}
export async function pushServerHistory(snapshot: HistorySnapshot, token: string, requestId: string, signal?: AbortSignal): Promise<{ revision: number }> {
  return req("/history", { method: "PUT", token, signal, body: {
    sessions: snapshot.sessions, deleted: snapshot.deleted, base_revision: snapshot.revision, request_id: requestId,
  } });
}

// ---------- 排行榜统计 ----------

export interface LocalStatTotals {
  treasures: number;
  digs: number;
  chats: number;
}

/** 累计上报：带 token 记账号行，否则记本机设备访客行 */
export async function pushServerStats(delta: Partial<LocalStatTotals>): Promise<void> {
  const body: Record<string, unknown> = { ...delta, device: getDeviceId() };
  const token = getLocalToken();
  if (token) body.token = token;
  await req("/stats/bump", { method: "POST", body, auth: false });
}

/** 登录时把游客期本机累计成绩并入账号行（一次性；调用方随后清零本地行防重复合并） */
export async function mergeServerStats(totals: LocalStatTotals): Promise<void> {
  await req("/stats/merge", { method: "POST", body: { totals } });
}

export async function pushServerNickname(name: string): Promise<void> {
  const body: Record<string, unknown> = { name, device: getDeviceId() };
  await req("/stats/nickname", { method: "POST", body });
  const user = readLocalUser();
  if (user) persist({ ...user, name });
}

export interface ServerStatRow extends LocalStatTotals {
  key: string;
  name: string;
  week_treasures: number;
  week_digs: number;
  week_chats: number;
  updated_at: string;
  isGuest: boolean;
}

export async function pullServerLeaderboard(): Promise<{ users: ServerStatRow[]; guests: ServerStatRow[] }> {
  return req("/leaderboard", { auth: false });
}
