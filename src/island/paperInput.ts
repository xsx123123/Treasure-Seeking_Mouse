export type PaperInput =
  | { kind: 'pdf'; file: File }
  | { kind: 'doi'; value: string }
  | { kind: 'pmid'; value: string }
  | { kind: 'url'; value: string }
  | { kind: 'question'; value: string };

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const DOI_RE = /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i;
const PMID_RE = /^(?:PMID\s*:\s*)?(\d{6,9})$/i;

/** Classify user input without fetching or treating paper text as instructions. */
export function classifyPaperInput(value: string | File): PaperInput | { kind: 'invalid'; reason: string } {
  if (typeof value !== 'string') {
    const name = value.name.trim().toLowerCase();
    if (value.size <= 0 || value.size > MAX_PDF_BYTES) return { kind: 'invalid', reason: 'pdf_size' };
    if (value.type !== 'application/pdf' && !name.endsWith('.pdf')) return { kind: 'invalid', reason: 'pdf_type' };
    return { kind: 'pdf', file: value };
  }
  const text = value.trim();
  if (!text) return { kind: 'invalid', reason: 'empty' };
  const doiUrl = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(text);
  const doi = (doiUrl?.[1] ?? text).replace(/[.,;]+$/, '').trim();
  if (DOI_RE.test(doi)) return { kind: 'doi', value: doi.toLowerCase() };
  const pmid = PMID_RE.exec(text);
  if (pmid) return { kind: 'pmid', value: pmid[1] };
  if (/^PMID\s*:/i.test(text)) return { kind: 'invalid', reason: 'pmid_format' };
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return { kind: 'invalid', reason: 'url_scheme' };
    return { kind: 'url', value: url.toString() };
  } catch {
    return { kind: 'question', value: text.slice(0, 4000) };
  }
}
