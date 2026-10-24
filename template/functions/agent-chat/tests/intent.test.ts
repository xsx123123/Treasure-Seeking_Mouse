// intent.ts 意图框架黄金用例（离线纯函数，零网络）。
// 期望值人工核实后写死，不随实现改动而修改（黄金用例纪律）。
// 运行：node --test functions/agent-chat/tests/intent.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseResearchIntent } from '../intent.ts';
import { INTENT_NEEDS_FLAG } from '../intent-vocab.ts';

test('完整合法输入：枚举槽位别名归一化（中文→规范值），notes 记录改写', () => {
  const r = parseResearchIntent({
    question: '找中国的电子产品目录',
    targets: ['catalog'],
    filters: { category: '电子', region: '中国' },
    [INTENT_NEEDS_FLAG]: false,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.question, '找中国的电子产品目录');
  assert.deepEqual(r.intent.targets, ['catalog']);
  assert.equal(r.intent.filters.category, 'electronics');
  assert.equal(r.intent.filters.region, 'cn');
  assert.equal(r.intent.needs_reference, false);
  assert.ok(r.notes.includes('filters.category: 电子 → electronics'));
  assert.ok(r.notes.includes('filters.region: 中国 → cn'));
});

test('英文别名大小写不敏感：Electronics → electronics / USA → us', () => {
  const r = parseResearchIntent({
    question: 'q',
    targets: ['catalog'],
    filters: { category: 'Electronics', region: 'USA' },
    [INTENT_NEEDS_FLAG]: true,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.filters.category, 'electronics');
  assert.equal(r.intent.filters.region, 'us');
});

test('词表已含规范值时零 note（改写不发生）', () => {
  const r = parseResearchIntent({
    question: 'q',
    targets: ['detail'],
    filters: { category: 'electronics' },
    [INTENT_NEEDS_FLAG]: false,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.filters.category, 'electronics');
  assert.deepEqual(r.notes, []);
});

test('未知目标 ok:false（不猜值）', () => {
  const r = parseResearchIntent({ question: 'q', targets: ['crypto'], [INTENT_NEEDS_FLAG]: false });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /未知目标「crypto」/);
});

test('空 targets 数组 ok:false', () => {
  const r = parseResearchIntent({ question: 'q', targets: [], [INTENT_NEEDS_FLAG]: false });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /targets 必须是非空数组/);
});

test('未知枚举槽位值 ok:false（防模型自造词表值）', () => {
  const r = parseResearchIntent({
    question: 'q',
    targets: ['catalog'],
    filters: { category: '化工' },
    [INTENT_NEEDS_FLAG]: false,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /filters\.category「化工」不在归一化词表内/);
});

test('未知 filter 键 ok:false（防模型自造槽位）', () => {
  const r = parseResearchIntent({
    question: 'q',
    targets: ['catalog'],
    filters: { color: 'red' },
    [INTENT_NEEDS_FLAG]: false,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /filters 含未知槽位「color」/);
});

test('needs 标志非布尔 ok:false（仅真布尔）', () => {
  const r = parseResearchIntent({ question: 'q', targets: ['catalog'], [INTENT_NEEDS_FLAG]: 'yes' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, new RegExp(`${INTENT_NEEDS_FLAG} 必须是布尔值`));
});

test('布尔槽位非布尔 ok:false', () => {
  const r = parseResearchIntent({
    question: 'q',
    targets: ['catalog'],
    filters: { verified_only: 'true' },
    [INTENT_NEEDS_FLAG]: false,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /filters\.verified_only 必须是布尔值/);
});

test('question 缺失/为空 ok:false', () => {
  assert.equal(parseResearchIntent({ targets: ['catalog'], [INTENT_NEEDS_FLAG]: false }).ok, false);
  assert.equal(parseResearchIntent({ question: '   ', targets: ['catalog'], [INTENT_NEEDS_FLAG]: false }).ok, false);
});

test('非对象输入（字符串/数组/null）ok:false', () => {
  assert.equal(parseResearchIntent('hello').ok, false);
  assert.equal(parseResearchIntent([1, 2]).ok, false);
  assert.equal(parseResearchIntent(null).ok, false);
});

test('自由文本槽位截断到 120 字符并去空白；空串视为未提供', () => {
  const long = 'a'.repeat(130);
  const r = parseResearchIntent({
    question: 'q',
    targets: ['catalog'],
    filters: { keyword: long },
    [INTENT_NEEDS_FLAG]: false,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal((r.intent.filters.keyword as string).length, 120);

  const r2 = parseResearchIntent({
    question: 'q',
    targets: ['catalog'],
    filters: { keyword: '   ' },
    [INTENT_NEEDS_FLAG]: false,
  });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.intent.filters.keyword, undefined);
});

test('一致性修正：targets 含 reference 且 needs=false → 强制 true 并记 note', () => {
  const r = parseResearchIntent({ question: 'q', targets: ['reference'], [INTENT_NEEDS_FLAG]: false });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.needs_reference, true);
  assert.ok(r.notes.some((n) => n.includes('false → true')));
});

test('filters 整体缺省 ok:true 且 filters 为空对象', () => {
  const r = parseResearchIntent({ question: 'q', targets: ['detail'], [INTENT_NEEDS_FLAG]: false });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.intent.filters, {});
});

test('重复 targets 去重保序', () => {
  const r = parseResearchIntent({ question: 'q', targets: ['catalog', 'detail', 'catalog'], [INTENT_NEEDS_FLAG]: false });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.intent.targets, ['catalog', 'detail']);
});

test('question 超长截断到 500 字符', () => {
  const r = parseResearchIntent({ question: 'x'.repeat(600), targets: ['catalog'], [INTENT_NEEDS_FLAG]: false });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.question.length, 500);
});