import type { StreamHandlers } from '../services/seqoutChat.ts';

export async function consumeChatStream(body: ReadableStream<Uint8Array>, handlers: StreamHandlers, interrupted: () => string, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', ended = false, done = false;
  function line(raw: string) {
    const t = raw.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') { done = true; return; }
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    if (typeof obj.delta === 'string') handlers.onDelta(obj.delta);
    else if (obj.event === 'tool') handlers.onTool(obj);
    else if (obj.event === 'cards' && Array.isArray(obj.cards)) handlers.onCards(obj.cards);
    else if (obj.event === 'polariseq') handlers.onPolariseq?.(typeof obj.accession === 'string' ? obj.accession : null);
    else if (obj.event === 'grounding' && Array.isArray(obj.unconfirmed)) handlers.onGrounding?.({ unconfirmed: obj.unconfirmed, confirmed: Array.isArray(obj.confirmed) ? obj.confirmed : [] });
    // 协议只加不改：task/snapshot 为新增帧，旧前端无回调注册时自然跳过
    else if (obj.event === 'task' && typeof obj.task_id === 'string') handlers.onTask?.(obj);
    else if (obj.event === 'snapshot' && typeof obj.task_id === 'string') handlers.onSnapshot?.(obj);
    else if (obj.event === 'end' && Array.isArray(obj.cards) && Array.isArray(obj.tools)) { ended = true; handlers.onEnd({ cards: obj.cards, tools: obj.tools, ...(typeof obj.task_id === 'string' ? { task_id: obj.task_id } : {}) }); }
    else if (typeof obj.error === 'string') handlers.onError(obj.error);
  }
  try {
    while (!done && !signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let pos: number;
      while (!done && (pos = buffer.indexOf('\n')) >= 0) { const value = buffer.slice(0, pos); buffer = buffer.slice(pos + 1); line(value); }
    }
    if (!done && buffer.trim()) line(buffer + decoder.decode());
    if (!ended && !signal?.aborted) handlers.onError(interrupted());
  } catch (err) {
    if (!signal?.aborted && (err as Error).name !== 'AbortError') handlers.onError(interrupted());
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
