import type { PaperWorkspaceView } from './contract.ts';

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid paper evidence object');
  return value as RecordValue;
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid paper evidence collection');
  return value;
}
function string(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid paper evidence text');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid paper evidence offset');
  return value;
}
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Validate a local index before display. This checks internal consistency, not PDF authenticity.
 * Database classifications, scientific interpretation, plans and tasks cannot be supplied by this format.
 */
export async function paperEvidenceToWorkspace(input: unknown, title: string): Promise<PaperWorkspaceView> {
  const index = object(input);
  if (index.schema_version !== 'paper-evidence.v1' || index.interpretation_status !== 'not_started') throw new Error('Unsupported paper evidence schema');
  const source = object(index.source);
  const hash = string(source.sha256, 64);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid paper source hash');
  const parser = string(source.parser, 200);
  const total = integer(index.total_pages, 0, 200);
  const status = string(index.extraction_status, 20);
  if (!['succeeded', 'partial', 'needs_ocr', 'failed'].includes(status)) throw new Error('Invalid extraction status');
  const pages = new Map<number, string[]>();
  let characters = 0;
  for (const item of array(index.pages, 200)) {
    const page = object(item);
    const number = integer(page.page_number, 1, total);
    const text = Array.from(string(page.text, 4_000_000));
    characters += text.length;
    if (characters > 2_000_000 || pages.has(number)) throw new Error('Invalid paper page collection');
    pages.set(number, text);
  }
  const evidence: PaperWorkspaceView['evidence'] = [];
  const evidenceIds = new Set<string>();
  const quotes = new Map<string, string>();
  for (const item of array(index.evidence, 20_000)) {
    const entry = object(item);
    const page = integer(entry.page, 1, total);
    const text = pages.get(page);
    if (!text) throw new Error('Evidence page is missing');
    const start = integer(entry.start, 0, text.length);
    const end = integer(entry.end, start + 1, text.length);
    const quote = string(entry.quote, 4_000_000);
    const id = string(entry.id, 64);
    if (text.slice(start, end).join('') !== quote || id !== await digest(`paper-evidence.v1:${hash}:${page}:${start}:${end}`) || evidenceIds.has(id)) throw new Error('Paper evidence integrity mismatch');
    if (entry.figure !== null || entry.table !== null || entry.bbox !== null) throw new Error('Unsupported layout evidence');
    evidenceIds.add(id);
    quotes.set(id, quote);
    evidence.push({ id, page, quote, section: string(entry.section, 200), context: string(entry.context, 4_000_000), figure: null, table: null });
  }
  const identifiers = new Set<string>();
  const mentions: PaperWorkspaceView['mentions'] = array(index.mentions, 20_000).map(item => {
    const mention = object(item);
    const identifier = string(mention.identifier, 1000);
    // An offline extraction can only assert a mention, never A/B/C or a verified source.
    if (!identifier || identifiers.has(identifier) || mention.relationship !== 'mention_only' || mention.verification !== 'not_checked' || mention.match_tier !== null) throw new Error('Invalid offline paper classification');
    identifiers.add(identifier);
    const ids = array(mention.evidence_ids, 20_000).map(id => string(id, 64));
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !evidenceIds.has(id))) throw new Error('Unresolved paper evidence reference');
    for (const id of ids) {
      const quote = quotes.get(id)!;
      const normalized = mention.kind === 'accession' ? quote.toUpperCase() : mention.kind === 'doi' ? quote.toLowerCase() : mention.kind === 'pmid' ? quote.toUpperCase().replace(/\s/g, '') : null;
      if (normalized !== identifier) throw new Error('Identifier does not match its evidence');
    }
    return { identifier, relationship: 'mention_only', verification: 'not_checked', matchTier: null, evidenceIds: ids };
  });
  const sections: PaperWorkspaceView['sections'] = array(index.sections, 20_000).map(item => {
    const section = object(item);
    const page = integer(section.page, 1, total);
    const text = pages.get(page);
    if (!text || section.method !== 'heading_heuristic') throw new Error('Invalid paper heading');
    const start = integer(section.start, 0, text.length);
    const end = integer(section.end, start + 1, text.length);
    return { label: string(section.label, 200), page, text: text.slice(start, end).join('') };
  });
  return {
    open: true, title: string(title, 1000), sourceLabel: parser, sourceHash: hash,
    status: status === 'needs_ocr' ? 'partial' : status as PaperWorkspaceView['status'],
    interpretationStatus: 'not_started', sections, evidence, mentions, plan: [], workflow: [],
  };
}
