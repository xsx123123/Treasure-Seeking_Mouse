import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrace } from '../paper_trace.mjs';

const hash = 'a'.repeat(64);
const index = {
  schema_version: 'paper-evidence.v1', source: { sha256: hash },
  mentions: [
    { identifier: 'GSE123', evidence_ids: ['e1'] },
    { identifier: 'SRX123', evidence_ids: ['e2'] },
  ],
};

test('trace keeps existence distinct from paper-use relation and A/B/C', () => {
  const trace = createTrace(index, [{ identifier: 'GSE123', evidenceIds: ['e1'], relationship: 'mention_only', verification: 'exists', matchTier: null }], '2026-10-17T00:00:00.000Z');
  assert.equal(trace.entries[0].verification, 'exists');
  assert.equal(trace.entries[0].relationship, 'mention_only');
  assert.equal(trace.entries[0].matchTier, null);
  assert.equal(trace.entries[1].verification, 'not_checked');
  assert.equal(trace.entries[1].endpoint, null);
  assert.ok(trace.gaps.includes('UPSTREAM_EXISTENCE_DOES_NOT_PROVE_PAPER_USE'));
});

test('trace rejects verification detached from this evidence', () => {
  assert.throws(() => createTrace(index, [{ identifier: 'GSE123', evidenceIds: ['other'], relationship: 'mention_only', verification: 'exists', matchTier: null }], '2026-10-17T00:00:00.000Z'));
  assert.throws(() => createTrace(index, [{ identifier: 'GSE999', evidenceIds: ['e1'], relationship: 'mention_only', verification: 'exists', matchTier: null }], '2026-10-17T00:00:00.000Z'));
  assert.throws(() => createTrace(index, [{ identifier: 'GSE123', evidenceIds: ['e1'], relationship: 'original_data', verification: 'exists', matchTier: 'A' }], '2026-10-17T00:00:00.000Z'));
});

test('trace bounds per-run verification and records the remainder', () => {
  const rows = index.mentions.map(row => ({ identifier: row.identifier, evidenceIds: row.evidence_ids, relationship: 'mention_only', verification: 'unknown', matchTier: null }));
  const trace = createTrace(index, rows.slice(0, 1), '2026-10-17T00:00:00.000Z', 1);
  assert.equal(trace.entries[0].verification, 'unknown');
  assert.equal(trace.entries[1].limitStatus, 'deferred');
  assert.equal(trace.entries[1].verification, 'not_checked');
});
