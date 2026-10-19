// Runtime-neutral authentication for an Edge Function or the Node bridge.
const trusted = new WeakSet<Request>();
export function markTrustedRequest(req: Request): void { trusted.add(req); }
export function isTrustedRequest(req: Request): boolean { return trusted.has(req); }
export async function verifyCloudUser(token: string, url: string, anonKey: string, signal?: AbortSignal): Promise<{ id: string }> {
  if (!url || !anonKey) throw new Error('auth_unavailable');
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
  } catch { throw new Error('auth_unavailable'); }
  if (response.status === 401 || response.status === 403) throw new Error('unauthorized');
  if (!response.ok) throw new Error('auth_unavailable');
  const user = await response.json();
  if (!user || typeof user.id !== 'string') throw new Error('unauthorized');
  return { id: user.id };
}

export function chatAccessMode(configured: string, secret: string): 'public' | 'authenticated' {
  if (configured && configured !== 'public' && configured !== 'authenticated') throw new Error('invalid_chat_access_mode');
  return configured === 'public' || (!configured && !secret) ? 'public' : 'authenticated';
}
