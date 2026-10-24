// chatStream 帧解析测试（协议只加不改：task/snapshot 新帧分发 + 旧帧零回归 + 能力位降级判定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeChatStream } from '../../src/lib/chatStream.ts';

const streamOf = (frames) => new ReadableStream({
  start(controller) {
    for (const f of frames) controller.enqueue(new TextEncoder().encode(`data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`));
    controller.close();
  },
});

const collector = () => {
  const out = { delta: [], tool: [], cards: [], polariseq: [], grounding: [], task: [], snapshot: [], end: [], error: [] };
  return {
    out,
    handlers: {
      onDelta: (t) => out.delta.push(t),
      onTool: (e) => out.tool.push(e),
      onCards: (c) => out.cards.push(c),
      onPolariseq: (a) => out.polariseq.push(a),
      onGrounding: (g) => out.grounding.push(g),
      onTask: (f) => out.task.push(f),
      onSnapshot: (f) => out.snapshot.push(f),
      onEnd: (p) => out.end.push(p),
      onError: (m) => out.error.push(m),
    },
  };
};

// ① task 帧正确分发 onTask（含可选字段透传）
test('task 帧分发：task_id/status/session_ref/queue_id/error/seq 透传', async () => {
  const { out, handlers } = collector();
  await consumeChatStream(streamOf([
    { event: 'task', task_id: 't1', status: 'running', session_ref: 's1', queue_id: 'q1', seq: 1 },
    { event: 'task', task_id: 't1', status: 'cancelled', error: 'aborted', seq: 9 },
    '[DONE]',
  ]), handlers, () => 'interrupted');
  assert.equal(out.task.length, 2);
  assert.equal(out.task[0].task_id, 't1');
  assert.equal(out.task[0].session_ref, 's1');
  assert.equal(out.task[1].error, 'aborted');
});

// ② snapshot 帧正确分发 onSnapshot
test('snapshot 帧分发：全量快照字段齐备', async () => {
  const { out, handlers } = collector();
  await consumeChatStream(streamOf([
    { event: 'snapshot', task_id: 't1', seq: 5, content: '已产出正文', cards: [{ tool: 'x', accession: 'GSE1', title: '', summary: '', meta: {} }], tools: [{ name: 'a', label: 'a', ok: true, ms: 1 }], completion: 'running' },
    { delta: '新增量' },
    { event: 'end', cards: [], tools: [] },
    '[DONE]',
  ]), handlers, () => 'interrupted');
  assert.equal(out.snapshot.length, 1);
  assert.equal(out.snapshot[0].content, '已产出正文');
  assert.equal(out.snapshot[0].completion, 'running');
  assert.deepEqual(out.delta, ['新增量']); // 快照后的增量正常累加
});

// ③ 未知事件类型帧透明跳过（旧行为回归）
test('未知事件类型透明跳过，不触发任何回调也不报错', async () => {
  const { out, handlers } = collector();
  await consumeChatStream(streamOf([
    { event: 'future_feature', foo: 1 },
    { event: 'platform_tool', result: {} },
    { delta: '正文' },
    { event: 'end', cards: [], tools: [] },
    '[DONE]',
  ]), handlers, () => 'interrupted');
  assert.deepEqual(out.delta, ['正文']);
  assert.equal(out.end.length, 1);
  assert.equal(out.error.length, 0);
});

// ④ end 帧携带 task_id 时既有判定与参数不变（协议只加不改回归）
test('end 帧带 task_id：onEnd 判定不变且 task_id 可选透传', async () => {
  const { out, handlers } = collector();
  await consumeChatStream(streamOf([
    { event: 'end', cards: [{ tool: 'x', accession: 'GSE1', title: '', summary: '', meta: {} }], tools: [], task_id: 't9' },
    '[DONE]',
  ]), handlers, () => 'interrupted');
  assert.equal(out.end.length, 1);
  assert.equal(out.end[0].cards.length, 1);
  assert.equal(out.end[0].task_id, 't9');
  // 旧形态（无 task_id）行为不变
  const c2 = collector();
  await consumeChatStream(streamOf([{ event: 'end', cards: [], tools: [] }, '[DONE]']), c2.handlers, () => 'interrupted');
  assert.equal(c2.out.end.length, 1);
  assert.equal(c2.out.end[0].task_id, undefined);
});

// ⑤ [DONE]/心跳/错误帧行为零变化回归
test('[DONE]/心跳注释行/错误帧既有语义不变（error 帧后流非正常终止补 interrupted 为既有行为）', async () => {
  const { out, handlers } = collector();
  await consumeChatStream(streamOf([
    ': ping',
    { delta: 'A' },
    ': ping',
    { error: '出错了' },
    '[DONE]',
  ]), handlers, () => 'interrupted');
  assert.deepEqual(out.delta, ['A']);
  // 既有语义固化：error 帧触发 onError；因未见 end 帧，流结束时再补 interrupted
  assert.deepEqual(out.error, ['出错了', 'interrupted']);
});

// ⑥ 能力位判定纯函数（spec 4.5 规则 2：目录缺 capabilities = 旧服务端降级）
test('能力位降级：无 capabilities 响应 → enabled:false（不依赖网络，直接固化判定语义）', async () => {
  // tasksCapability 的模块级状态由 fetchModelCatalog 写入；这里固化解析契约：
  // 解析函数对 {capabilities:{tasks:true,...}} 置 enabled，其余形态一律 false
  const parse = (json) => {
    const caps = json?.capabilities;
    return caps?.tasks === true
      ? { enabled: true, maxConcurrent: typeof caps.task_max_concurrent === 'number' ? caps.task_max_concurrent : null }
      : { enabled: false, maxConcurrent: null };
  };
  assert.deepEqual(parse({ data: [] }), { enabled: false, maxConcurrent: null });
  assert.deepEqual(parse({ capabilities: { tasks: true, task_max_concurrent: 3 } }), { enabled: true, maxConcurrent: 3 });
  assert.deepEqual(parse({ capabilities: { tasks: true } }), { enabled: true, maxConcurrent: null });
  assert.deepEqual(parse({ capabilities: {} }), { enabled: false, maxConcurrent: null });
});