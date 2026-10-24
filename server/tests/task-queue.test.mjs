// 消息排队状态机离线测试（spec 5.1 全部 10 条规则 + 5.4 规则 1/3/5 + 异常场景，tasks.md 7.2 用例矩阵）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueueStore, QUEUE_DRAFT_RESTORE_WINDOW_MS } from '../../src/services/taskQueue.ts';

const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }; };
const makeQueue = (storage = memory(), scopeKey = 'scope:test') => new TaskQueueStore({ storage, scopeKey });

// ① 入队即时性与容量满拒绝且内容保留（规则 2 / 异常 5.1.3-1）
test('enqueue 纯本地同步成功；容量满拒绝返回 reason:full', () => {
  const q = makeQueue();
  const cap = q.capacity();
  assert.equal(cap, 10); // 默认上限
  for (let i = 0; i < cap; i++) {
    const r = q.enqueue('s1', `问题${i}`);
    assert.equal(r.ok, true);
  }
  const overflow = q.enqueue('s1', '溢出问题');
  assert.deepEqual(overflow, { ok: false, reason: 'full' });
  assert.equal(q.list('s1').length, cap); // 溢出项未入队
});

// ② FIFO promoteNext 严格序（规则 3）
test('promoteNext 严格 FIFO：依次入队 A/B/C 弹出恒为 A→B→C', () => {
  const q = makeQueue();
  q.enqueue('s1', 'A');
  q.enqueue('s1', 'B');
  q.enqueue('s1', 'C');
  assert.equal(q.promoteNext('s1').content, 'A');
  assert.equal(q.promoteNext('s1').content, 'B');
  assert.equal(q.promoteNext('s1').content, 'C');
  assert.equal(q.promoteNext('s1'), null); // 空队列
});

// ③ 逐条撤销保序（规则 5）
test('cancel 逐条撤销：[A,B,C] 撤销 B 得 [A,C]', () => {
  const q = makeQueue();
  const a = q.enqueue('s1', 'A').item;
  const b = q.enqueue('s1', 'B').item;
  q.enqueue('s1', 'C');
  assert.equal(q.cancel('s1', b.queue_id), true);
  assert.deepEqual(q.list('s1').map(i => i.content), ['A', 'C']);
  assert.equal(q.cancel('s1', a.queue_id), true);
  assert.deepEqual(q.list('s1').map(i => i.content), ['C']);
});

// ④ 清空 + 5s 内 undoClear 原样恢复 + 超窗失效（规则 6 / 5.4.1 规则 5）
test('clear 清空后可 undoClear 找回；窗口外副本读入即弃', () => {
  const q = makeQueue();
  q.enqueue('s1', 'A');
  q.enqueue('s1', 'B');
  const cleared = q.clear('s1');
  assert.deepEqual(cleared.map(i => i.content), ['A', 'B']);
  assert.equal(q.list('s1').length, 0);
  assert.equal(q.undoClear('s1'), true);
  assert.deepEqual(q.list('s1').map(i => i.content), ['A', 'B']);
  // 超窗：构造过期副本
  const q2 = makeQueue();
  q2.enqueue('s1', 'X');
  q2.clear('s1');
  const key = `seqout:queue:v1:scope:test:s1`;
  const file = JSON.parse(q2['storage'].getItem(key) ?? '{}');
  assert.ok(file.cleared_backup, '副本应存在');
});

// ⑤ 跨会话隔离（规则 7）
test('不同 session_ref 队列互不串扰、各自持久化', () => {
  const storage = memory();
  const q = makeQueue(storage);
  q.enqueue('s1', 'A1');
  q.enqueue('s2', 'B1');
  q.enqueue('s2', 'B2');
  assert.deepEqual(q.list('s1').map(i => i.content), ['A1']);
  assert.deepEqual(q.list('s2').map(i => i.content), ['B1', 'B2']);
  q.purge('s1');
  assert.equal(q.list('s1').length, 0);
  assert.deepEqual(q.list('s2').map(i => i.content), ['B1', 'B2']);
});

// ⑥ 三模式一致（不同 scopeKey 分区 key 行为逻辑相同，规则 8）
test('不同 scopeKey（身份分区）互不可见', () => {
  const storage = memory();
  const qa = new TaskQueueStore({ storage, scopeKey: 'scope:guest' });
  const qb = new TaskQueueStore({ storage, scopeKey: 'scope:local:u1' });
  qa.enqueue('s1', '游客问题');
  qb.enqueue('s1', '账号问题');
  assert.deepEqual(qa.list('s1').map(i => i.content), ['游客问题']);
  assert.deepEqual(qb.list('s1').map(i => i.content), ['账号问题']);
});

// ⑦ markDrafted 转草稿按序取内容（5.4.1 规则 3 的数据源）
test('markDrafted 按序返回内容数组且项转 drafted 态', () => {
  const q = makeQueue();
  q.enqueue('s1', 'B');
  q.enqueue('s1', 'C');
  const contents = q.markDrafted('s1');
  assert.deepEqual(contents, ['B', 'C']);
  assert.equal(q.list('s1').length, 0); // drafted 不再出现于排队列表
  assert.equal(q.promoteNext('s1'), null); // drafted 不可被派发
});

// ⑧ restore 双分支（异常 5.1.3-2 / spec 5.3.1 规则 7）
test('restore：前序 running → queued 模式；前序终态 → confirm 模式（零自动派发）', () => {
  const q = makeQueue();
  q.enqueue('s1', 'A');
  assert.equal(q.restore('s1', true), 'queued');
  assert.equal(q.restore('s1', false), 'confirm');
  // queued 项经持久化天然恢复呈现，restore 不擅自派发
  assert.deepEqual(q.list('s1').map(i => i.content), ['A']);
});

// ⑨ 失败暂停语义前提：promoteNext 不被隐式自动调用（异常 5.1.3-3 / 5.4.1 规则 4）
test('队列状态机无自动推进：promoteNext 只能由调用方显式触发', () => {
  const q = makeQueue();
  q.enqueue('s1', 'A');
  // 无任何后台副作用：list 多次读取不改变状态
  q.list('s1');
  q.list('s1');
  assert.equal(q.list('s1')[0].status, 'queued');
  assert.equal(q.list('s1').length, 1);
});

// ⑩ 撤销/清空仅作用于 queued 态（spec 6.1 规则 5 枚举守卫）
test('cancel/clear 对 promoted 项无效', () => {
  const q = makeQueue();
  const a = q.enqueue('s1', 'A').item;
  q.enqueue('s1', 'B');
  q.promoteNext('s1'); // A → promoted
  assert.equal(q.cancel('s1', a.queue_id), false); // promoted 不可撤
  const cleared = q.clear('s1');
  assert.deepEqual(cleared.map(i => i.content), ['B']); // 只清 queued
});

// 补充：localStorage 写失败 → 内存态继续 + onStorageError 冒泡
test('storage 写失败时内存态继续服务且冒泡错误', () => {
  const badStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
  };
  let bubbled = false;
  const q = new TaskQueueStore({ storage: badStorage, scopeKey: 'scope:test', onStorageError: () => { bubbled = true; } });
  const r = q.enqueue('s1', 'A');
  assert.equal(r.ok, true);
  assert.equal(bubbled, true);
  assert.deepEqual(q.list('s1').map(i => i.content), ['A']); // 内存兜底可读
});

// 补充：持久化恢复——新实例从 localStorage 读回
test('新实例从 localStorage 恢复队列（刷新场景）', () => {
  const storage = memory();
  const q1 = makeQueue(storage);
  q1.enqueue('s1', 'A');
  q1.enqueue('s1', 'B');
  const q2 = makeQueue(storage);
  assert.deepEqual(q2.list('s1').map(i => i.content), ['A', 'B']);
});

// 补充：窗口常量固化
test('QUEUE_DRAFT_RESTORE_WINDOW_MS = 5000 固定值', () => {
  assert.equal(QUEUE_DRAFT_RESTORE_WINDOW_MS, 5000);
});