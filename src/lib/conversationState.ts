import type { DatasetCard, GroundingPayload, ToolLog } from '../services/seqoutChat.ts';

export type Completion = 'complete' | 'interrupted' | 'failed';
export interface MessageMetadata { version: 1; grounding?: GroundingPayload; boost?: { accession: string | null }; completion?: Completion }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function decodeMetadata(value: unknown): Omit<MessageMetadata, 'version'> {
  if (!obj(value) || value.version !== 1) return {};
  const out: Omit<MessageMetadata, 'version'> = {};
  if (['complete', 'interrupted', 'failed'].includes(String(value.completion))) out.completion = value.completion as Completion;
  if (obj(value.boost) && (value.boost.accession === null || (typeof value.boost.accession === 'string' && /^PRJ(?:NA|EB|DB)\d+$/i.test(value.boost.accession))))
    out.boost = { accession: value.boost.accession as string | null };
  if (obj(value.grounding) && Array.isArray(value.grounding.unconfirmed) && Array.isArray(value.grounding.confirmed)) {
    out.grounding = {
      unconfirmed: value.grounding.unconfirmed.slice(0, 100).filter((v): v is { id: string; status: string } => obj(v) && typeof v.id === 'string' && typeof v.status === 'string')
        .map(v => ({ id: v.id.slice(0, 500), status: v.status.slice(0, 100) })),
      confirmed: value.grounding.confirmed.filter((v): v is string => typeof v === 'string').slice(0, 100).map(v => v.slice(0, 500)),
    };
  }
  return out;
}
export function encodeMetadata(value: { grounding?: GroundingPayload | null; boost?: { accession: string | null } | null; completion?: Completion }): MessageMetadata {
  return { version: 1, ...decodeMetadata({ version: 1, ...value }) };
}
export function cardIdentity(c: DatasetCard): string {
  const m = c.meta ?? {};
  const source = m.source ?? 'omics';
  if (source === 'variant') return `variant:${m.assembly}:${m.variant_id || [c.accession, m.chr, m.pos, m.ref, m.alt].join(':')}`;
  if (source === 'gene') return `gene:${m.taxid || m.species}:${m.entrez_gene_id || m.ensembl_gene_id || c.accession}`;
  if (source === 'literature') return `literature:${m.doi?.toLowerCase() || m.pmid || `${m.literature_source}:${c.accession}`}`;
  return `${source}:${c.accession ? c.accession.toUpperCase() : JSON.stringify([c.tool, c.title, c.summary, m])}`;
}
export function mergeCards(previous: DatasetCard[], incoming: DatasetCard[]): DatasetCard[] {
  const map = new Map(previous.map(c => [cardIdentity(c), c]));
  for (const card of incoming) {
    const key = cardIdentity(card), old = map.get(key);
    map.set(key, old ? { ...old, ...card, title: card.title || old.title, summary: card.summary || old.summary,
      meta: { ...old.meta, ...Object.fromEntries(Object.entries(card.meta ?? {}).filter(([, v]) => v !== '')) } } : card);
  }
  return [...map.values()];
}

/** Mutable only inside one request; a snapshot is also used for UI, persistence and accounting. */
export function conversationAccumulator(id: string) {
  let message = { id, role: 'assistant' as const, content: '', cards: [] as DatasetCard[], toolLogs: [] as ToolLog[],
    grounding: undefined as GroundingPayload | undefined, boost: undefined as { accession: string | null } | undefined,
    error: undefined as string | undefined, completion: 'interrupted' as Completion };
  let ended = false;
  return {
    delta(text: string) { message.content += text; },
    cards(cards: DatasetCard[]) { message.cards = mergeCards(message.cards, cards); },
    tool(log: ToolLog) { message.toolLogs.push(log); },
    grounding(value: GroundingPayload) { message.grounding = value; },
    boost(accession: string | null) { message.boost = { accession }; },
    error(error: string) { message.error = error; message.completion = 'failed'; },
    end(cards: DatasetCard[], tools: ToolLog[]) { message.cards = mergeCards([], cards); message.toolLogs = tools; ended = true; message.completion = 'complete'; },
    snapshot() { return { ...message, cards: [...message.cards], toolLogs: [...message.toolLogs], streaming: false }; },
    get ended() { return ended; },
  };
}
