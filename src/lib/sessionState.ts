import { emptyHistory, mergeHistory, validSessions, type HistoryMessage, type HistorySnapshot, type HistorySession } from '../../shared/history.ts';
import { requestId } from './requestId.ts';

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function sessionKey(endpoint: string, accountId: string | null, origin: string): string {
  const url = new URL(endpoint, origin); url.search = ''; url.hash = '';
  return `seqout:sessions:v2:${encodeURIComponent(url.href.replace(/\/$/, ''))}:${accountId ? `local:${encodeURIComponent(accountId)}` : 'guest'}`;
}
export interface HistoryTransport<M extends HistoryMessage> {
  pull(token: string, signal: AbortSignal): Promise<HistorySnapshot<M>>;
  push(snapshot: HistorySnapshot<M>, token: string, requestId: string, signal: AbortSignal): Promise<{ revision: number }>;
}
interface View<M extends HistoryMessage> { sessions: HistorySession<M>[]; ready: boolean; error: string | null; pending: HistorySession<M>[] }
const BACKUP = 'seqout:legacy-sessions:v1';

/** Owns one immutable identity/token. Delayed requests cannot switch to another user's credentials. */
export class SessionState<M extends HistoryMessage> {
  private snapshot = emptyHistory<M>();
  private base = emptyHistory<M>();
  private view: View<M>;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private abort = new AbortController();
  private generation = 0;
  private saving = false;
  private started = false;
  private dirty = false;
  private storage: StorageLike;
  readonly key: string;
  private token: string;
  private transport: HistoryTransport<M>;
  private guest: boolean;
  private guestKey?: string;
  constructor(storage: StorageLike, key: string, token: string, transport: HistoryTransport<M>, guest: boolean, guestKey?: string) {
    this.storage = storage; this.key = key; this.token = token; this.transport = transport; this.guest = guest; this.guestKey = guestKey;
    let error: string | null = null;
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const value = JSON.parse(raw);
        if (!validSessions(value.sessions) || !Array.isArray(value.deleted) || !value.deleted.every((id: unknown) => typeof id === 'string') || !Number.isSafeInteger(value.revision)) throw new Error('history_invalid');
        this.snapshot = value;
        if (value.base && validSessions(value.base.sessions)) this.base = value.base;
      }
      if (guest) this.snapshot.sessions = this.snapshot.sessions.filter(s => s.ts >= Date.now() - 7 * 86400000).slice(-50);
    } catch { error = 'history_invalid'; }
    this.view = { sessions: this.snapshot.sessions, ready: !token, error, pending: [] };
  }
  getSnapshot = () => this.view;
  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  private emit(changes: Partial<View<M>> = {}) {
    this.view = { ...this.view, sessions: this.snapshot.sessions, ...changes };
    this.listeners.forEach(cb => cb());
  }
  private persist() {
    this.storage.setItem(this.key, JSON.stringify({ ...this.snapshot, base: this.base }));
  }
  private pending() {
    const raw = this.storage.getItem(BACKUP) || this.storage.getItem('seqout-local-session');
    let candidates: HistorySession<M>[] = [];
    if (raw) {
      if (!this.storage.getItem(BACKUP)) this.storage.setItem(BACKUP, raw);
      const parsed = JSON.parse(raw);
      const normalized = Array.isArray(parsed) ? parsed.map(s => ({ ...s, ts: typeof s?.ts === 'number' ? s.ts : Date.now() })) : null;
      if (validSessions(normalized)) candidates = normalized as HistorySession<M>[];
    }
    if (this.guestKey) {
      const guest = JSON.parse(this.storage.getItem(this.guestKey) || '{"sessions":[]}');
      if (validSessions(guest.sessions)) candidates.push(...guest.sessions.map((s: HistorySession<M>) => ({ ...s, id: `guest-import:${s.id}` })));
    }
    const imported: string[] = JSON.parse(this.storage.getItem(`${this.key}:legacy-imported`) || '[]');
    return candidates.filter(s => !imported.includes(s.id));
  }

  async start() {
    if (this.started) {
      try {
        const raw = this.storage.getItem(this.key);
        if (raw) {
          const other = JSON.parse(raw);
          if (!validSessions(other.sessions) || !Array.isArray(other.deleted)) throw new Error('invalid');
          this.snapshot = mergeHistory(this.snapshot, other, this.base);
        }
      } catch { this.emit({ error: 'history_invalid' }); return; }
    }
    this.started = true;
    const generation = ++this.generation;
    this.abort.abort(); this.abort = new AbortController(); this.saving = false;
    try { this.emit({ pending: this.pending() }); } catch { this.emit({ error: 'history_legacy' }); }
    if (!this.token || this.view.error === 'history_invalid') return;
    this.emit({ ready: false });
    try {
      const remote = await this.transport.pull(this.token, this.abort.signal);
      if (generation !== this.generation) return;
      this.snapshot = mergeHistory(this.snapshot, remote, this.base); this.base = remote;
      this.persist();
      this.dirty = JSON.stringify(this.snapshot.sessions) !== JSON.stringify(remote.sessions) || JSON.stringify(this.snapshot.deleted) !== JSON.stringify(remote.deleted);
      this.emit({ ready: true, error: null }); this.schedule();
    } catch { if (generation === this.generation) this.emit({ ready: false, error: 'history_sync' }); }
  }
  dispose() { this.started = false; this.generation++; this.abort.abort(); clearTimeout(this.timer); }
  save(session: HistorySession<M>) {
    if (this.view.error === 'history_invalid' || this.snapshot.deleted.includes(session.id)) return;
    const previous = this.snapshot.sessions.find(s => s.id === session.id);
    if (previous && previous.title === session.title && JSON.stringify(previous.messages) === JSON.stringify(session.messages)) return;
    const removedMessageIds = [...new Set([...(previous?.removedMessageIds ?? []), ...((previous?.messages ?? []).filter(m => !session.messages.some(n => n.id === m.id)).map(m => m.id))])];
    const sessions = [...this.snapshot.sessions.filter(s => s.id !== session.id), { ...session, removedMessageIds }].sort((a, b) => a.ts - b.ts);
    this.snapshot = { ...this.snapshot, sessions: this.guest ? sessions.slice(-50) : sessions };
    this.changed();
  }
  remove(id: string) {
    this.snapshot = { ...this.snapshot, sessions: this.snapshot.sessions.filter(s => s.id !== id), deleted: [...new Set([...this.snapshot.deleted, id])] };
    this.changed();
  }
  importLegacy(ids: string[]) {
    const selected = this.view.pending.filter(s => ids.includes(s.id));
    if (!selected.length) return;
    const old = this.snapshot;
    this.snapshot = mergeHistory({ ...this.snapshot, sessions: selected }, this.snapshot, this.base);
    if (this.guest) this.snapshot.sessions = this.snapshot.sessions.slice(-50);
    try {
      this.persist();
      const marker = `${this.key}:legacy-imported`;
      const previous: string[] = JSON.parse(this.storage.getItem(marker) || '[]');
      this.storage.setItem(marker, JSON.stringify([...new Set([...previous, ...selected.map(s => s.id)])]));
      this.emit({ pending: this.pending(), error: null }); this.dirty = true; this.schedule();
    } catch { this.snapshot = old; this.emit({ error: 'history_storage' }); }
  }
  private changed() {
    try { this.persist(); this.emit({ error: this.view.ready ? null : this.view.error }); this.dirty = true; this.schedule(); }
    catch { this.emit({ error: 'history_storage' }); }
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.token && this.started && this.view.ready && this.dirty) this.timer = setTimeout(() => void this.flush(), 800);
  }
  async flush() {
    if (!this.started || !this.token || !this.view.ready || !this.dirty || this.saving) return;
    const generation = this.generation;
    this.saving = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const sent = this.snapshot;
        try {
          const result = await this.transport.push(sent, this.token, requestId(), this.abort.signal);
          if (generation !== this.generation) return;
          this.base = { ...sent, revision: result.revision };
          this.dirty = this.snapshot !== sent;
          this.snapshot = { ...this.snapshot, revision: result.revision };
          this.persist(); this.emit({ error: null }); return;
        } catch (err) {
          if (generation !== this.generation) return;
          if ((err as { status?: number }).status !== 409) throw err;
          const remote = await this.transport.pull(this.token, this.abort.signal);
          if (generation !== this.generation) return;
          this.snapshot = mergeHistory(this.snapshot, remote, this.base); this.base = remote;
          this.persist(); this.emit();
        }
      }
      throw new Error('history_conflict');
    } catch { if (generation === this.generation) this.emit({ error: 'history_sync', ready: false }); }
    finally { if (generation === this.generation) { this.saving = false; this.schedule(); } }
  }
}
