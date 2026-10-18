#!/usr/bin/env node
/** Produce an append-only sidecar of bounded public identifier existence checks. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { verifyPaperMentions, verifyEndpointFor } from '../functions/seqout-chat/index.ts';
import { paperEvidenceToWorkspace } from '../src/island/paperEvidence.ts';

const MAX_MENTIONS = 20;

export function createTrace(index, verified, checkedAt, max = MAX_MENTIONS) {
  if (!index || index.schema_version !== 'paper-evidence.v1' || !index.source || !/^[0-9a-f]{64}$/.test(index.source.sha256 ?? '')) {
    throw new Error('Unsupported paper evidence index');
  }
  if (!Number.isInteger(max) || max < 0 || max > MAX_MENTIONS || !Array.isArray(index.mentions) || !Array.isArray(verified) || verified.length > max) throw new Error('Invalid verification result');
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid verification timestamp');
  const byId = new Map(verified.map(row => [row.identifier, row]));
  const allowed = new Set(index.mentions.map(row => row.identifier));
  if (byId.size !== verified.length || [...byId.keys()].some(id => !allowed.has(id))) throw new Error('Verification does not belong to this paper index');
  const entries = index.mentions.map((mention, position) => {
    const row = byId.get(mention.identifier);
    const endpoint = verifyEndpointFor(mention.identifier);
    const evidenceIds = [...mention.evidence_ids];
    if (row && (!['exists', 'missing', 'unknown'].includes(row.verification) || row.relationship !== 'mention_only' || row.matchTier !== null || !Array.isArray(row.evidenceIds) || row.evidenceIds.join('\0') !== evidenceIds.join('\0'))) {
      throw new Error('Invalid verification provenance');
    }
    return {
      identifier: mention.identifier, evidenceIds,
      relationship: 'mention_only',
      verification: row?.verification ?? 'not_checked',
      matchTier: null,
      checkedAt: row ? checkedAt : null,
      endpoint: row && endpoint ? { origin: new URL(endpoint.url).origin, pathname: new URL(endpoint.url).pathname } : null,
      limitStatus: !row && position >= max ? 'deferred' : null,
    };
  });
  return {
    schema_version: 'paper-evidence-trace.v1',
    paper_sha256: index.source.sha256,
    checked_at: checkedAt,
    limit: max,
    entries,
    gaps: [
      'UPSTREAM_EXISTENCE_DOES_NOT_PROVE_PAPER_USE',
      'A_B_C_RELATIONSHIP_MATCHING_NOT_IMPLEMENTED',
      'DATABASE_SNAPSHOT_NOT_PERSISTED_BY_PLATFORM',
    ],
  };
}

async function main(args) {
  if (args.length !== 3 || args[1] !== '--output') {
    throw new Error('Usage: node scripts/paper_trace.mjs <paper-evidence.json> --output <new-trace.json>');
  }
  const inputPath = resolve(args[0]);
  const outputPath = resolve(args[2]);
  const index = JSON.parse(await readFile(inputPath, 'utf8'));
  await paperEvidenceToWorkspace(index, inputPath.split(/[\\/]/).at(-1) || 'Paper');
  const verified = await verifyPaperMentions(index.mentions, { limit: MAX_MENTIONS });
  const trace = createTrace(index, verified, new Date().toISOString());
  const { open } = await import('node:fs/promises');
  const file = await open(outputPath, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(trace, null, 2)}\n`, 'utf8'); }
  finally { await file.close(); }
  console.log(JSON.stringify({ output: outputPath, entries: trace.entries.length,
    checked: trace.entries.filter(row => row.verification !== 'not_checked').length,
    confirmed: trace.entries.filter(row => row.verification === 'exists').length,
    missing: trace.entries.filter(row => row.verification === 'missing').length,
    unknown: trace.entries.filter(row => row.verification === 'unknown').length,
    deferred: trace.entries.filter(row => row.limitStatus === 'deferred').length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ status: 'failed', error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
