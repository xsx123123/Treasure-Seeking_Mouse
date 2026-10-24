// Browser and Node share the same lossless merge and deletion semantics.
export interface HistoryMessage { id: string; role: string; content: string }
export interface HistorySession<M extends HistoryMessage = HistoryMessage> {
  id: string; title: string; messages: M[]; ts: number; removedMessageIds?: string[];
}
export interface HistorySnapshot<M extends HistoryMessage = HistoryMessage> {
  sessions: HistorySession<M>[]; deleted: string[]; revision: number;
}
export const emptyHistory = <M extends HistoryMessage>(): HistorySnapshot<M> => ({ sessions: [], deleted: [], revision: 0 });

export function validSessions(value: unknown): value is HistorySession[] {
  return Array.isArray(value) && value.every(s => s && typeof s.id === 'string' && s.id.length > 0 &&
    typeof s.title === 'string' && Number.isFinite(s.ts) && Array.isArray(s.messages) &&
    s.messages.every((m: HistoryMessage) => m && typeof m.id === 'string' && typeof m.role === 'string' && typeof m.content === 'string') &&
    (s.removedMessageIds === undefined || (Array.isArray(s.removedMessageIds) && s.removedMessageIds.every((id: unknown) => typeof id === 'string'))));
}

export function mergeHistory<M extends HistoryMessage>(local: HistorySnapshot<M>, remote: HistorySnapshot<M>, base: HistorySnapshot<M> = emptyHistory<M>()): HistorySnapshot<M> {
  const deleted = [...new Set([...local.deleted, ...remote.deleted])];
  const sessions = new Map(remote.sessions.map(s => [s.id, s]));
  for (const s of local.sessions) {
    const other = sessions.get(s.id);
    if (!other) { sessions.set(s.id, s); continue; }
    const removedMessageIds = [...new Set([...(other.removedMessageIds ?? []), ...(s.removedMessageIds ?? [])])];
    const messages = new Map(other.messages.map(m => [m.id, m]));
    const baseMessages = new Map(base.sessions.find(b => b.id === s.id)?.messages.map(m => [m.id, m]) ?? []);
    for (const m of s.messages) {
      const previous = messages.get(m.id);
      if (!previous || JSON.stringify(previous) === JSON.stringify(m)) { messages.set(m.id, m); continue; }
      const ancestor = baseMessages.get(m.id);
      if (ancestor && JSON.stringify(previous) === JSON.stringify(ancestor)) { messages.set(m.id, m); continue; }
      if (ancestor && JSON.stringify(m) === JSON.stringify(ancestor)) continue;
      // Two edits to one message are kept as explicit conflict copies. No client clock decides data loss.
      const seed = JSON.stringify(m);
      let hash = 2166136261;
      for (const c of seed) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
      const id = `${m.id}:conflict:${(hash >>> 0).toString(16)}`;
      messages.set(id, { ...m, id });
    }
    const newer = s.ts > other.ts ? s : other;
    sessions.set(s.id, { ...newer, removedMessageIds,
      messages: [...messages.values()].filter(m => !removedMessageIds.includes(m.id)) });
  }
  return { sessions: [...sessions.values()].filter(s => !deleted.includes(s.id)).sort((a, b) => a.ts - b.ts), deleted, revision: remote.revision };
}
