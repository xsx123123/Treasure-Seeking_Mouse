import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { SessionState, sessionKey } from '../lib/sessionState.ts';
import { chatEndpoint } from '../services/seqoutChat';
import { getLocalToken, pullServerHistory, pushServerHistory } from '../services/localAuth';
import type { ChatUIMessage } from '../components/chat/ChatMessage';
import type { HistorySnapshot } from '../../shared/history.ts';

export function useLocalHistory(accountId: string | null, verified: boolean) {
  const token = accountId ? getLocalToken() : '';
  const key = sessionKey(chatEndpoint(), accountId, window.location.origin);
  const store = useMemo(() => new SessionState<ChatUIMessage>(localStorage, key, token, {
    pull: async (t, s) => await pullServerHistory(t, s) as HistorySnapshot<ChatUIMessage>,
    push: pushServerHistory,
  }, !accountId, accountId ? sessionKey(chatEndpoint(), null, window.location.origin) : undefined), [key, token]);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { if (verified) void store.start(); return () => store.dispose(); }, [store, verified]);
  useEffect(() => {
    const listener = (e: StorageEvent) => { if (e.key === key) void store.start(); };
    window.addEventListener('storage', listener); return () => window.removeEventListener('storage', listener);
  }, [store, key]);
  return { ...view, store, scope: key, ready: verified && view.ready };
}
