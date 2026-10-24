// echo 内置工具测试（离线纯函数，零网络）
// 运行：node --test functions/agent-chat/tests/echo.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executeTool, isBusinessEmpty } from '../index.ts';

test('echo：正常回显，信封 {success:true, data:{original, transformed, transform}}', async () => {
  const payload = await executeTool('echo', { text: '你好 Agent' });
  assert.deepEqual(payload, { success: true, data: { original: '你好 Agent', transformed: '你好 Agent', transform: 'none' } });
});

test('echo：upper/lower/reverse 三种变换', async () => {
  const up = await executeTool('echo', { text: 'hello', transform: 'upper' });
  assert.equal((up as { data: { transformed: string } }).data.transformed, 'HELLO');
  const low = await executeTool('echo', { text: 'WORLD', transform: 'lower' });
  assert.equal((low as { data: { transformed: string } }).data.transformed, 'world');
  const rev = await executeTool('echo', { text: 'abc', transform: 'reverse' });
  assert.equal((rev as { data: { transformed: string } }).data.transformed, 'cba');
});

test('echo：text 缺失/空串抛错（回灌错误信封的路径）', async () => {
  await assert.rejects(executeTool('echo', {}), /text 参数不能为空/);
  await assert.rejects(executeTool('echo', { text: '   ' }), /text 参数不能为空/);
});

test('echo：text 超长（>5000）抛错', async () => {
  await assert.rejects(executeTool('echo', { text: 'a'.repeat(5001) }), /text 过长/);
});

test('echo：transform 非法值抛错（含合法取值指引）', async () => {
  await assert.rejects(executeTool('echo', { text: 'x', transform: 'rot13' }), /transform 不支持「rot13」/);
});

test('echo：未知工具名抛错', async () => {
  await assert.rejects(executeTool('nonexistent_tool', {}), /未知工具/);
});

test('echo：结果不是空结果信封（empties 口径不误计）', async () => {
  const payload = await executeTool('echo', { text: 'hi' });
  assert.equal(isBusinessEmpty(payload), false);
});