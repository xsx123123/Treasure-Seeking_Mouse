// demo_cards 内置工具测试（离线，零网络）：信封形状、limit 钳制、空结果口径、卡片投影
// 运行：node --test functions/agent-chat/tests/demo-cards.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executeTool, extractCards, isBusinessEmpty } from '../index.ts';

test('demo_cards：合法主题返回 {success:true, data:{topic, total, results}} 信封', async () => {
  const payload = await executeTool('demo_cards', { topic: 'fruits' });
  const data = (payload as { data: { topic: string; total: number; results: unknown[] } }).data;
  assert.equal(data.topic, 'fruits');
  assert.equal(data.total, 5);
  assert.equal(data.results.length, 3); // 默认 limit=3
  const first = data.results[0] as { accession: string; title: string; summary: string; meta: Record<string, string> };
  assert.equal(first.accession, 'FRUIT-001');
  assert.equal(typeof first.title, 'string');
  assert.equal(typeof first.summary, 'string');
  assert.equal(typeof first.meta.category, 'string'); // meta 值全字符串
});

test('demo_cards：limit 钳制（上限 10，非法回默认 3）', async () => {
  const big = await executeTool('demo_cards', { topic: 'fruits', limit: 100 });
  assert.equal(((big as { data: { results: unknown[] } }).data.results.length), 5); // 库存只有 5 条
  const bad = await executeTool('demo_cards', { topic: 'cities', limit: 'abc' });
  assert.equal(((bad as { data: { results: unknown[] } }).data.results.length), 3);
});

test('demo_cards：未知主题返回空结果信封（空结果 ≠ 失败）', async () => {
  const payload = await executeTool('demo_cards', { topic: 'books' });
  assert.equal(isBusinessEmpty(payload), true, '未知主题应走 empty 信封');
  const data = (payload as { data: { note: string } }).data;
  assert.match(data.note, /未知主题「books」/);
  assert.match(data.note, /fruits \/ cities \/ elements/);
});

test('extractCards：demo_cards 结果投影卡片字段齐全、accession 去重、上限 20', async () => {
  const payload = await executeTool('demo_cards', { topic: 'cities', limit: 5 });
  const cards = extractCards('demo_cards', payload) as { tool: string; accession: string; title: string; summary: string; meta: Record<string, string> }[];
  assert.equal(cards.length, 5);
  for (const card of cards) {
    assert.equal(card.tool, 'demo_cards');
    assert.ok(card.accession.startsWith('CITY-'));
    assert.equal(typeof card.title, 'string');
    assert.equal(typeof card.summary, 'string');
    for (const v of Object.values(card.meta)) assert.equal(typeof v, 'string', 'meta 值必须全字符串');
  }
  // 构造重复 accession 的输入验证去重
  const dupPayload = { success: true, data: { results: [
    { accession: 'X-1', title: 'a', summary: '', meta: {} },
    { accession: 'X-1', title: 'a2', summary: '', meta: {} },
    { accession: 'X-2', title: 'b', summary: '', meta: {} },
  ] } } as never;
  const deduped = extractCards('demo_cards', dupPayload);
  assert.equal(deduped.length, 2, 'accession 重复的卡片应去重');

  // 构造 30 条验证上限 20
  const many = { success: true, data: { results: Array.from({ length: 30 }, (_, i) => ({ accession: `Y-${i}`, title: `t${i}`, summary: '', meta: {} })) } } as never;
  assert.equal(extractCards('demo_cards', many).length, 20, '单次卡片上限 20 张');
});

test('extractCards：空结果信封不出卡片', async () => {
  const payload = await executeTool('demo_cards', { topic: 'unknown' });
  assert.equal(extractCards('demo_cards', payload).length, 0);
});