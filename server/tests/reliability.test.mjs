import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountApi } from '../account-api.mjs';
import { createChatAccess } from '../chat-access.mjs';
import { verifyCloudUser, chatAccessMode } from '../../functions/seqout-chat/access.ts';
import { SessionState, sessionKey } from '../../src/lib/sessionState.ts';
import { mergeHistory } from '../../shared/history.ts';
import { conversationAccumulator, mergeCards, encodeMetadata, decodeMetadata } from '../../src/lib/conversationState.ts';
import { consumeChatStream } from '../../src/lib/chatStream.ts';
import { requestId } from '../../src/lib/requestId.ts';

const msg = (id, content = id) => ({ id, role: 'user', content });
const session = (id = 's', messages = [msg('m')], ts = Date.now()) => ({ id, title: id, messages, ts });
const snapshot = (sessions = [], revision = 0, deleted = []) => ({ sessions, revision, deleted });
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function api() {
  const dir = mkdtempSync(join(tmpdir(), 'treasure-reliability-'));
  const handle = createAccountApi({ dataDir: dir });
  const call = async (path, method = 'GET', body, token) => {
    const res = { status: 0, writeHead(s) { this.status = s; }, end(text) { this.body = JSON.parse(text); } };
    await handle({ method, headers: token ? { authorization: `Bearer ${token}` } : {} }, res, path, body ? JSON.stringify(body) : '');
    return res;
  };
  const a = (await call('/auth/register', 'POST', { email: 'a@example.test', password: 'testing123', name: 'A' })).body;
  const b = (await call('/auth/register', 'POST', { email: 'b@example.test', password: 'testing123', name: 'B' })).body;
  return { dir, handle, call, a, b };
}

test('history CAS rejects stale/unversioned writes, replays safely and persists before reply', async () => {
  const { call, a, b, dir } = await api();
  assert.equal((await call('/history', 'PUT', { sessions: [] }, a.token)).status, 428);
  const body = { base_revision: 0, request_id: 'r1', sessions: [session()], deleted: [] };
  assert.equal((await call('/history', 'PUT', body, a.token)).body.revision, 1);
  assert.equal((await call('/history', 'PUT', body, a.token)).body.revision, 1);
  assert.equal((await call('/history', 'PUT', { ...body, request_id: 'r2' }, a.token)).status, 409);
  assert.equal((await call('/history', 'PUT', { ...body, sessions: [] }, a.token)).status, 409);
  assert.equal((await call('/history', 'GET', null, b.token)).body.sessions.length, 0);
  const file = join(dir, 'history', 'a%40example.test.json');
  assert.equal(JSON.parse(readFileSync(file)).revision, 1);
  const restored = createAccountApi({ dataDir: dir });
  // Registration is independently debounced; history itself is already durable.
  assert.ok(restored);
  const del = { base_revision: 1, request_id: 'r3', sessions: [], deleted: ['s'] };
  await call('/history', 'PUT', del, a.token);
  await call('/history', 'PUT', { ...body, base_revision: 2, request_id: 'r4' }, a.token);
  assert.deepEqual((await call('/history', 'GET', null, a.token)).body.sessions, []);
  const tooMany = { ...body, base_revision: 3, request_id: 'r5', sessions: Array.from({ length: 1001 }, (_, i) => session(String(i))) };
  assert.equal((await call('/history', 'PUT', tooMany, a.token)).status, 413);
  assert.equal((await call('/history', 'GET', null, a.token)).body.revision, 3);
});

test('legacy server history upgrades without truncation or data loss', async () => {
  const { call, a, dir } = await api();
  writeFileSync(join(dir, 'history', 'a%40example.test.json'), JSON.stringify({ sessions: [session()] }));
  const old = (await call('/history', 'GET', null, a.token)).body;
  assert.equal(old.revision, 0); assert.equal(old.protocol_version, 2);
  assert.equal((await call('/history', 'PUT', { ...old, base_revision: 0, request_id: 'upgrade' }, a.token)).status, 200);
});

test('nickname: valid account / guest / invalid bearer / legacy body token target the right row', async () => {
  const { call, a } = await api();
  assert.equal((await call('/stats/nickname', 'POST', { name: 'changed', device: 'g' }, a.token)).status, 200);
  assert.equal((await call('/auth/me', 'GET', null, a.token)).body.name, 'changed');
  assert.equal((await call('/stats/nickname', 'POST', { name: 'guest', device: 'g' })).status, 200);
  assert.equal((await call('/stats/nickname', 'POST', { name: 'wrong', device: 'g' }, 'expired')).status, 401);
  assert.equal((await call('/stats/nickname', 'POST', { name: 'wrong', device: 'g', token: a.token })).status, 400);
  await call('/stats/bump', 'POST', { device: 'g', chats: 1 });
  assert.equal((await call('/leaderboard')).body.guests[0].name, 'guest');
});

test('authenticated bridge strips spoofed headers and accepts local accounts without exposing service key', async () => {
  const { handle, a } = await api();
  const access = createChatAccess({ env: { CHAT_SHARED_SECRET: 'server-only' }, authenticate: handle.authenticate });
  await assert.rejects(access({ 'x-chat-key': 'server-only' }), /unauthorized/);
  const headers = { authorization: `Bearer ${a.token}`, 'x-chat-key': 'spoof', 'x-stats-actor': 'other', 'x-cygnusx-platform-tools': 'trusted' };
  await access(headers);
  assert.equal(headers['x-chat-key'], 'server-only'); assert.equal(headers['x-stats-actor'], a.email);
  assert.equal(headers['x-cygnusx-platform-tools'], undefined);
  const noSecret = createChatAccess({ env: { CHAT_ACCESS_MODE: 'authenticated' }, authenticate: handle.authenticate });
  await noSecret({ authorization: `Bearer ${a.token}` });
  await assert.rejects(noSecret({ authorization: 'Bearer expired' }), /unauthorized/);
  assert.equal(chatAccessMode('', ''), 'public');
  await createChatAccess({ env: { CHAT_ACCESS_MODE: 'public' }, authenticate: () => null })({});
});

test('cloud authentication verifies against a fixed configured server and distinguishes outages', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => { assert.equal(url, 'https://auth.example/auth/v1/user'); assert.equal(init.headers.Authorization, 'Bearer user'); return Response.json({ id: 'verified' }); };
    assert.deepEqual(await verifyCloudUser('user', 'https://auth.example', 'anon'), { id: 'verified' });
    globalThis.fetch = async () => new Response('', { status: 401 });
    await assert.rejects(verifyCloudUser('bad', 'https://auth.example', 'anon'), /unauthorized/);
    globalThis.fetch = async () => { throw new Error('network'); };
    await assert.rejects(verifyCloudUser('user', 'https://auth.example', 'anon'), /auth_unavailable/);
  } finally { globalThis.fetch = original; }
});

test('identity scopes, legacy explicit import and guest-only retention', async () => {
  const storage = memory();
  const aKey = sessionKey('/chat-api', 'A', 'https://app.example');
  const bKey = sessionKey('/chat-api', 'B', 'https://app.example');
  assert.notEqual(aKey, bKey); assert.notEqual(aKey, sessionKey('/other', 'A', 'https://app.example'));
  storage.setItem('seqout-local-session', JSON.stringify([session('legacy')]));
  const transport = { pull: async () => snapshot(), push: async () => ({ revision: 1 }) };
  const a = new SessionState(storage, aKey, 'token-A', transport, false);
  await a.start();
  assert.equal(a.getSnapshot().sessions.length, 0); assert.equal(a.getSnapshot().pending.length, 1);
  a.importLegacy(['legacy']); assert.equal(a.getSnapshot().sessions.length, 1);
  a.importLegacy(['legacy']); assert.equal(a.getSnapshot().sessions.length, 1);
  assert.ok(storage.getItem('seqout:legacy-sessions:v1'));
  const b = new SessionState(storage, bKey, 'token-B', transport, false); await b.start();
  assert.equal(b.getSnapshot().sessions.length, 0);
  const old = session('old', [], Date.now() - 30 * 86400000);
  storage.setItem('account', JSON.stringify(snapshot([old]))); storage.setItem('guest', JSON.stringify(snapshot([old])));
  assert.equal(new SessionState(storage, 'account', '', transport, false).getSnapshot().sessions.length, 1);
  assert.equal(new SessionState(storage, 'guest', '', transport, true).getSnapshot().sessions.length, 0);
  a.dispose(); b.dispose();
});

test('restoration gates uploads and disposed A cannot publish a late response into B', async () => {
  const delayed = defer(), storage = memory(); let pushes = 0;
  const a = new SessionState(storage, 'A', 'token-A', { pull: () => delayed.promise, push: async () => { pushes++; return { revision: 1 }; } }, false);
  const pending = a.start();
  a.save(session()); await a.flush(); assert.equal(pushes, 0);
  a.dispose();
  const b = new SessionState(storage, 'B', 'token-B', { pull: async () => snapshot([session('B')]), push: async () => ({ revision: 1 }) }, false);
  await b.start(); delayed.resolve(snapshot([session('A')], 2)); await pending;
  assert.deepEqual(b.getSnapshot().sessions.map(s => s.id), ['B']);
  assert.equal(JSON.parse(storage.getItem('A')).sessions[0].id, 's');
  b.dispose();
});

test('conflicting devices merge messages and tombstones, preserving concurrent edits', () => {
  const base = snapshot([session('s', [msg('m')])], 1);
  const a = snapshot([session('s', [msg('m'), msg('a')])], 1);
  const b = snapshot([session('s', [msg('m'), msg('b')])], 2);
  assert.equal(mergeHistory(a, b, base).sessions[0].messages.length, 3);
  const edited = snapshot([session('s', [msg('m', 'changed')])], 1);
  assert.equal(mergeHistory(edited, base, base).sessions[0].messages[0].content, 'changed');
  const conflict = mergeHistory(edited, snapshot([session('s', [msg('m', 'other')])], 2), base);
  assert.equal(conflict.sessions[0].messages.length, 2);
  assert.deepEqual(mergeHistory(a, snapshot([], 2, ['s']), base).sessions, []);
  const removed = snapshot([{ ...session('s', []), removedMessageIds: ['m'] }], 2);
  assert.equal(mergeHistory(a, removed, base).sessions[0].messages.some(m => m.id === 'm'), false);
});

test('failed pull never uploads cached history; conflicts repull before retry', async () => {
  const storage = memory(); let calls = 0, pushes = 0;
  const state = new SessionState(storage, 'x', 'token', {
    pull: async () => { if (++calls === 1) throw new Error('offline'); return snapshot([session('remote')], calls - 2); },
    push: async (value, token) => { assert.equal(token, 'token'); if (++pushes === 1) throw Object.assign(new Error('conflict'), { status: 409 }); assert.equal(value.sessions.length, 2); return { revision: 2 }; },
  }, false);
  await state.start(); state.save(session('local')); await state.flush(); assert.equal(pushes, 0);
  await state.start(); await state.flush(); assert.equal(pushes, 2); assert.equal(state.getSnapshot().error, null);
  state.dispose();
});

const card = (accession, meta = {}) => ({ accession, meta, tool: 'test', title: accession, summary: '' });
test('cards accumulate and enrich; variants keep assembly and allele identities', () => {
  const cards = mergeCards(mergeCards([], [card('GSE1')]), [card('GSE2'), { ...card('GSE1'), summary: 'new' }]);
  assert.deepEqual(cards.map(c => c.accession), ['GSE1', 'GSE2']); assert.equal(cards[0].summary, 'new');
  assert.equal(mergeCards([], [card('rs1', { source: 'variant', assembly: 'hg19', variant_id: 'A' }), card('rs1', { source: 'variant', assembly: 'hg38', variant_id: 'A' }), card('rs1', { source: 'variant', assembly: 'hg38', variant_id: 'B' })]).length, 3);
});

test('SSE fragmented batches, end and metadata yield one final persistence snapshot', async () => {
  const acc = conversationAccumulator('assistant');
  const events = [{ delta: 'hello' }, { event: 'cards', cards: [card('GSE1')] }, { event: 'cards', cards: [card('GSE2')] }, { event: 'grounding', unconfirmed: [{ id: 'GSE9', status: 'unverified' }], confirmed: [] }, { event: 'polariseq', accession: null }, { event: 'future' }, { event: 'end', cards: [card('GSE1'), card('GSE2')], tools: [] }];
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]';
  const body = new ReadableStream({ start(c) { for (let i = 0; i < text.length; i += 7) c.enqueue(new TextEncoder().encode(text.slice(i, i + 7))); c.close(); } });
  await consumeChatStream(body, { onDelta: t => acc.delta(t), onCards: cs => acc.cards(cs), onGrounding: g => acc.grounding(g), onPolariseq: a => acc.boost(a), onTool() {}, onEnd: p => acc.end(p.cards, p.tools), onError: e => assert.fail(e) }, () => 'interrupted');
  const final = acc.snapshot(); assert.equal(final.cards.length, 2); assert.equal(final.completion, 'complete');
  assert.deepEqual(decodeMetadata(JSON.parse(JSON.stringify(encodeMetadata(final)))), { grounding: final.grounding, boost: final.boost, completion: 'complete' });
});

test('SSE EOF keeps received cards; explicit empty end stays empty; metadata rejects malformed versions', async () => {
  const acc = conversationAccumulator('a');
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ event: 'cards', cards: [card('GSE1')] })}`)); c.close(); } });
  await consumeChatStream(body, { onDelta() {}, onCards: c => acc.cards(c), onTool() {}, onEnd() {}, onError() {} }, () => 'interrupted');
  assert.equal(acc.snapshot().cards.length, 1); assert.equal(acc.snapshot().completion, 'interrupted');
  acc.end([], []); assert.equal(acc.snapshot().cards.length, 0);
  assert.deepEqual(decodeMetadata(null), {}); assert.deepEqual(decodeMetadata({ version: 2, boost: { accession: null } }), {});
  assert.deepEqual(decodeMetadata({ version: 1, boost: { accession: 'invalid' } }), {});
  assert.deepEqual(decodeMetadata({ version: 1, boost: { accession: null } }), { boost: { accession: null } });
});

test('corrupt scoped cache is never overwritten; storage failure keeps visible unsaved messages', async () => {
  const storage = memory(); storage.setItem('bad', '{broken');
  const transport = { pull: async () => snapshot(), push: async () => { assert.fail('must not upload corrupt data'); } };
  const bad = new SessionState(storage, 'bad', 'token', transport, false);
  await bad.start(); bad.save(session());
  assert.equal(storage.getItem('bad'), '{broken'); assert.equal(bad.getSnapshot().error, 'history_invalid');
  const full = new SessionState({ getItem: () => null, setItem() { throw new Error('quota'); } }, 'full', '', transport, true);
  full.save(session()); assert.equal(full.getSnapshot().sessions.length, 1); assert.equal(full.getSnapshot().error, 'history_storage');
  bad.dispose(); full.dispose();
});

test('UUID generation supports HTTP LAN browsers without randomUUID', () => {
  const original = crypto.randomUUID;
  try {
    crypto.randomUUID = undefined;
    assert.match(requestId(), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  } finally { crypto.randomUUID = original; }
});
