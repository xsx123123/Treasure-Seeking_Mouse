import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { paperEvidenceToWorkspace } from '../paperEvidence.ts';

function fixture() {
  const hash = 'a'.repeat(64);
  const text = 'Methods\n🧬 GSE123';
  const start = Array.from(text).length - 6;
  const end = start + 6;
  const id = createHash('sha256').update(`paper-evidence.v1:${hash}:1:${start}:${end}`).digest('hex');
  return {
    schema_version: 'paper-evidence.v1', interpretation_status: 'not_started', extraction_status: 'succeeded',
    source: { sha256: hash, parser: 'existing-parser' }, total_pages: 1,
    pages: [{ page_number: 1, text }],
    sections: [{ label: 'methods', page: 1, start: 0, end: 7, method: 'heading_heuristic' }],
    evidence: [{ id, page: 1, start, end, quote: 'GSE123', context: text, section: 'methods', bbox: null, figure: null, table: null }],
    mentions: [{ identifier: 'GSE123', kind: 'accession', evidence_ids: [id], relationship: 'mention_only', verification: 'not_checked', match_tier: null as string | null }],
  };
}

test('preserves exact Unicode evidence and unverified status, without generating plans', async () => {
  const view = await paperEvidenceToWorkspace(fixture(), 'A paper');
  assert.equal(view.evidence[0].quote, 'GSE123');
  assert.equal(view.sections[0].text, 'Methods');
  assert.equal(view.mentions[0].matchTier, null);
  assert.equal(view.interpretationStatus, 'not_started');
  assert.deepEqual(view.plan, []);
  assert.deepEqual(view.workflow, []);
});
test('rejects modified source text, offsets or evidence identity', async () => {
  for (const change of [
    (index: ReturnType<typeof fixture>) => { index.pages[0].text = 'Methods\n🧬 GSE999'; },
    (index: ReturnType<typeof fixture>) => { index.evidence[0].start++; },
    (index: ReturnType<typeof fixture>) => { index.source.sha256 = 'b'.repeat(64); },
  ]) {
    const index = fixture(); change(index);
    await assert.rejects(paperEvidenceToWorkspace(index, 'A paper'));
  }
});
test('rejects verified or A/B/C classifications from an offline index', async () => {
  for (const tier of ['A', 'B', 'C']) {
    const index = fixture(); index.mentions[0].match_tier = tier;
    await assert.rejects(paperEvidenceToWorkspace(index, 'A paper'));
  }
  const index = fixture(); index.mentions[0].verification = 'verified';
  await assert.rejects(paperEvidenceToWorkspace(index, 'A paper'));
});
test('rejects dangling references and mismatched identifier labels', async () => {
  const index = fixture(); index.mentions[0].evidence_ids = ['missing'];
  await assert.rejects(paperEvidenceToWorkspace(index, 'A paper'));
  const mismatch = fixture(); mismatch.mentions[0].identifier = 'GSE999';
  await assert.rejects(paperEvidenceToWorkspace(mismatch, 'A paper'));
});
test('rejects unsupported schema, duplicate pages and claimed interpretation', async () => {
  for (const change of [
    (index: ReturnType<typeof fixture>) => { index.schema_version = 'other'; },
    (index: ReturnType<typeof fixture>) => { index.pages.push(index.pages[0]); },
    (index: ReturnType<typeof fixture>) => { index.interpretation_status = 'completed'; },
  ]) {
    const index = fixture(); change(index);
    await assert.rejects(paperEvidenceToWorkspace(index, 'A paper'));
  }
});
test('retains OCR limitation as a partial extraction', async () => {
  const index = fixture(); index.extraction_status = 'needs_ocr';
  assert.equal((await paperEvidenceToWorkspace(index, 'A paper')).status, 'partial');
});
test('real Python index can cross the browser view boundary', { skip: !process.env.PAPER_TEST_INDEX }, async () => {
  const index = JSON.parse(await readFile(process.env.PAPER_TEST_INDEX!, 'utf8'));
  const view = await paperEvidenceToWorkspace(index, 'Real paper');
  assert.equal(view.evidence.length, index.evidence.length);
  assert.equal(view.mentions.length, index.mentions.length);
  assert.ok(view.mentions.every(item => item.matchTier === null));
});
