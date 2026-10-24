// grounding 框架测试（离线：注入 verify 函数，零网络）
// 运行：node --test functions/agent-chat/tests/grounding.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardIdentifiers, groundingCheck, scanAccessions } from '../index.ts';

const verify = (table: Record<string, 'exists' | 'missing' | 'unknown'>) =>
  async (id: string): Promise<'exists' | 'missing' | 'unknown'> => table[id] ?? 'unknown';

test('scanAccessions：DOI 与 URL 模式命中并归一化（DOI 小写去尾标点、URL 去尾标点）', () => {
  const text = '详见 10.1234/ABC.def，或访问 https://example.com/paper/1。 另一 DOI: 10.5555/xYZ-999.';
  const ids = scanAccessions(text);
  assert.ok(ids.includes('10.1234/abc.def'), 'DOI 应小写化');
  assert.ok(ids.includes('https://example.com/paper/1'), 'URL 应保留且去尾标点');
  assert.ok(ids.includes('10.5555/xyz-999'), '句尾 DOI 去尾点');
  assert.equal(ids.length, 3, '去重后恰 3 个');
});

test('scanAccessions：无标识文本返回空数组', () => {
  assert.deepEqual(scanAccessions('普通文本，没有任何引用。'), []);
});

test('cardIdentifiers：DOI accession 小写、URL accession 原样、普通编号大写、meta.doi/meta.url 收集', () => {
  const cards = [
    { accession: '10.1234/ABC.def', title: 't', summary: '', meta: {} },
    { accession: 'https://example.com/a', title: 't', summary: '', meta: {} },
    { accession: 'card-01', title: 't', summary: '', meta: { doi: '10.9999/zzz', url: 'https://example.com/b' } },
  ] as never[];
  const ids = cardIdentifiers(cards);
  assert.ok(ids.has('10.1234/abc.def'));
  assert.ok(ids.has('https://example.com/a'));
  assert.ok(ids.has('CARD-01'));
  assert.ok(ids.has('10.9999/zzz'));
  assert.ok(ids.has('https://example.com/b'));
});

test('groundingCheck：正文标识全部在卡片中 → 零警示（grounded）', async () => {
  const cards = [{ accession: '10.1234/abc.def', title: 't', summary: '', meta: {} }] as never[];
  const report = await groundingCheck('结果见 10.1234/ABC.def。', cards, { verify: verify({}), limit: 5 });
  assert.deepEqual(report.scanned, ['10.1234/abc.def']);
  assert.deepEqual(report.grounded, ['10.1234/abc.def']);
  assert.deepEqual(report.unconfirmed, []);
});

test('groundingCheck：卡片外标识回源 exists → confirmed，不警示', async () => {
  const report = await groundingCheck('引用 10.5555/exists-1。', [], { verify: verify({ '10.5555/exists-1': 'exists' }), limit: 5 });
  assert.deepEqual(report.confirmed, ['10.5555/exists-1']);
  assert.deepEqual(report.unconfirmed, []);
});

test('groundingCheck：卡片外标识回源 404 → unconfirmed（upstream_404）', async () => {
  const report = await groundingCheck('引用 10.5555/gone-1。', [], { verify: verify({ '10.5555/gone-1': 'missing' }), limit: 5 });
  assert.deepEqual(report.unconfirmed, [{ id: '10.5555/gone-1', status: 'upstream_404' }]);
});

test('groundingCheck：超出 limit 的标识 → unverified；limit 内的拿到结论', async () => {
  const text = ['a', 'b', 'c', 'd'].map((x) => `10.1234/${x}`).join(' ');
  const report = await groundingCheck(text, [], {
    verify: verify({ '10.1234/a': 'exists', '10.1234/b': 'missing' }),
    limit: 2,
  });
  assert.deepEqual(report.confirmed, ['10.1234/a']);
  assert.equal(report.unconfirmed.length, 3, 'b(upstream_404) + c,d(unverified)');
  assert.ok(report.unconfirmed.some((u) => u.id === '10.1234/b' && u.status === 'upstream_404'));
  assert.ok(report.unconfirmed.some((u) => u.id === '10.1234/c' && u.status === 'unverified'));
  assert.ok(report.unconfirmed.some((u) => u.id === '10.1234/d' && u.status === 'unverified'));
});

test('groundingCheck：上游全灭（全部 unknown）→ 整次降级零警示（不误报）', async () => {
  const report = await groundingCheck('引用 10.1234/x 与 10.1234/y。', [], { verify: verify({}), limit: 5 });
  assert.deepEqual(report.unconfirmed, [], '拿不到任何结论时不产生警示');
  assert.deepEqual(report.confirmed, []);
});

test('groundingCheck：limit=0 时全部直接 unverified（不回源）', async () => {
  let called = 0;
  const counting = async (id: string) => { called += 1; return 'exists' as const; };
  const report = await groundingCheck('引用 10.1234/z。', [], { verify: counting, limit: 0 });
  assert.equal(called, 0, 'limit=0 不应回源');
  assert.deepEqual(report.unconfirmed, [{ id: '10.1234/z', status: 'unverified' }]);
});

test('groundingCheck：卡片 meta.doi 也算 grounded（正文引用与卡片 meta 同源）', async () => {
  const cards = [{ accession: 'PAPER-1', title: 't', summary: '', meta: { doi: '10.2345/from-meta' } }] as never[];
  const report = await groundingCheck('见 10.2345/from-meta。', cards, { verify: verify({}), limit: 5 });
  assert.deepEqual(report.grounded, ['10.2345/from-meta']);
  assert.deepEqual(report.unconfirmed, []);
});