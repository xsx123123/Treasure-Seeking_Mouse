// 会话与消息的云端存取（Supabase Client，RLS 仅本人可见）
import { supabase } from "@/supabase/client";
import { readLang, translate } from "@/i18n";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";
import type { MessageMetadata } from "../lib/conversationState";
import type { Json } from "@/supabase/types";
import type { DatasetCard, ToolLog } from "./seqoutChat";

// Additive application schema overlay until the platform regenerates its managed types.
type ManagedMessage = Database['public']['Tables']['chat_messages'];
type MessageDatabase = Omit<Database, 'public'> & {
  public: Omit<Database['public'], 'Tables'> & {
    Tables: Omit<Database['public']['Tables'], 'chat_messages'> & {
      chat_messages: Omit<ManagedMessage, 'Row' | 'Insert' | 'Update'> & {
        Row: ManagedMessage['Row'] & { metadata: Json | null };
        Insert: ManagedMessage['Insert'] & { metadata?: Json | null };
        Update: ManagedMessage['Update'] & { metadata?: Json | null };
      };
    };
  };
};
const messageClient = supabase as unknown as SupabaseClient<MessageDatabase>;

export interface SessionRow {
  id: string;
  title: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  cards: DatasetCard[] | null;
  tool_logs: ToolLog[] | null;
  metadata?: Json | null;
}

export async function listSessions(): Promise<SessionRow[]> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("id,title,updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as SessionRow[];
}

export async function createSession(userId: string, title: string): Promise<SessionRow> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .insert({ user_id: userId, title })
    .select("id,title,updated_at")
    .single();
  if (error) throw new Error(error.message);
  return data as SessionRow;
}

export async function renameSession(id: string, title: string): Promise<void> {
  const { error } = await supabase.from("chat_sessions").update({ title }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function touchSession(id: string): Promise<void> {
  await supabase.from("chat_sessions").update({ updated_at: new Date().toISOString() }).eq("id", id);
}

export async function deleteSession(id: string): Promise<void> {
  const { data, error } = await supabase.from("chat_sessions").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error(translate(readLang(), "err.deleteSession"));
}

export async function listMessages(sessionId: string): Promise<MessageRow[]> {
  const { data, error } = await messageClient
    .from("chat_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as MessageRow[];
}

export async function insertMessage(
  sessionId: string,
  userId: string,
  msg: { id?: string; role: "user" | "assistant"; content: string; cards?: DatasetCard[] | null; tool_logs?: ToolLog[] | null; metadata?: MessageMetadata },
): Promise<string> {
  const { data, error } = await messageClient
    .from("chat_messages")
    .insert({
      ...(msg.id ? { id: msg.id } : {}),
      session_id: sessionId,
      user_id: userId,
      role: msg.role,
      content: msg.content,
      cards: (msg.cards ?? null) as Json,
      tool_logs: (msg.tool_logs ?? null) as Json,
      metadata: (msg.metadata ?? null) as unknown as Json,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === '23505' && msg.id) {
      const existing = await messageClient.from('chat_messages').select('id').eq('id', msg.id).eq('user_id', userId).eq('session_id', sessionId).single();
      if (!existing.error && existing.data) return existing.data.id;
    }
    throw new Error(error.message);
  }
  return (data as { id: string }).id;
}
