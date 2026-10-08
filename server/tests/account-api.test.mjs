// account-api 路径穿越回归测试（离线，node --test）
//
// 背景：historyFile(email) 用 encodeURIComponent(email) 拼路径，但 '.' 不是 URL 保留字符，
// 注册正则又允许 "../../../etc/passwd@x.com" 这类值——/history PUT 会把文件写到
// HISTORY_DIR 之外。修复：注册时硬校验（拒绝 / \ .. 首尾. %2e），historyFile 落盘前
// 再做 containment 断言。本测试守住这两条。
//
// 运行：node --test server/tests/*.test.mjs（已并入根目录 npm test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAccountApi } from '../account-api.mjs';

function mockReq(method, token = '') {
  return { method, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function mockRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(text) { this.body = text; },
    json() { return JSON.parse(this.body); },
  };
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'account-api-test-'));
  const handle = createAccountApi({ dataDir });
  return { dataDir, handle, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test('注册：路径穿越邮箱被拒绝（400），不落在 HISTORY_DIR 之外', async () => {
  const { dataDir, handle, cleanup } = setup();
  try {
    for (const email of ['../../../etc/passwd@x.com', '..\\..\\evil@x.com', '%2e%2e/x@x.com', 'a..b@x.com']) {
      const res = mockRes();
      const handled = await handle(mockReq('POST'), res, '/auth/register', JSON.stringify({ email, password: 'secret123' }));
      assert.notEqual(handled, false, `${email} 应由账号路由处理`);
      assert.equal(res.status, 400, `${email} 应被拒绝，实际 ${res.status} ${res.body}`);
    }
    // dataDir 下不应出现 history 之外的逃逸产物
    assert.deepEqual(readdirSync(dataDir).sort(), ['history']);
  } finally {
    cleanup();
  }
});

test('注册/登录/写历史：正常邮箱不受影响，历史文件落在 history/ 内', async () => {
  const { dataDir, handle, cleanup } = setup();
  try {
    const reg = mockRes();
    await handle(mockReq('POST'), reg, '/auth/register', JSON.stringify({ email: 'Mouse.Dev@example.com', password: 'secret123', name: '阿寻' }));
    assert.equal(reg.status, 200, reg.body);
    const { token, email } = reg.json();
    assert.equal(email, 'mouse.dev@example.com', '带点号的正常邮箱必须放行');

    const put = mockRes();
    await handle(mockReq('PUT', token), put, '/history', JSON.stringify({ sessions: [{ id: 's1' }] }));
    assert.equal(put.status, 200, put.body);

    const get = mockRes();
    await handle(mockReq('GET', token), get, '/history', '');
    assert.equal(get.status, 200, get.body);
    assert.deepEqual(get.json().sessions, [{ id: 's1' }]);

    // 等防抖落盘（400ms）后确认文件在 history/ 目录内、无目录外产物
    await new Promise((r) => setTimeout(r, 600));
    const files = readdirSync(join(dataDir, 'history'));
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.json'));
  } finally {
    cleanup();
  }
});
