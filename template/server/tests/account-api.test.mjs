// account-api 路径穿越回归 + 通用列名测试（离线，node --test）
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
    await handle(mockReq('POST'), reg, '/auth/register', JSON.stringify({ email: 'Agent.Dev@example.com', password: 'secret123', name: '小测' }));
    assert.equal(reg.status, 200, reg.body);
    const { token, email } = reg.json();
    assert.equal(email, 'agent.dev@example.com', '带点号的正常邮箱必须放行');

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

test('口令错误登录被拒（401）', async () => {
  const { handle, cleanup } = setup();
  try {
    await handle(mockReq('POST'), mockRes(), '/auth/register', JSON.stringify({ email: 'a@b.co', password: 'secret123' }));
    const res = mockRes();
    await handle(mockReq('POST'), res, '/auth/login', JSON.stringify({ email: 'a@b.co', password: 'wrong-password' }));
    assert.equal(res.status, 401);
    assert.match(res.json().error, /邮箱或密码不正确/);
  } finally {
    cleanup();
  }
});

test('stats/bump：通用列名（messages/tools/cards）累加进账号行', async () => {
  const { handle, cleanup } = setup();
  try {
    const reg = mockRes();
    await handle(mockReq('POST'), reg, '/auth/register', JSON.stringify({ email: 'a@b.co', password: 'secret123' }));
    const { token } = reg.json();
    const bump = mockRes();
    await handle(mockReq('POST'), bump, '/stats/bump', JSON.stringify({ token, messages: 2, tools: 5, cards: 9 }));
    assert.equal(bump.status, 200, bump.body);
    const board = mockRes();
    await handle(mockReq('GET'), board, '/leaderboard', '');
    assert.equal(board.status, 200);
    const row = board.json().users[0];
    assert.equal(row.messages, 2);
    assert.equal(row.tools, 5);
    assert.equal(row.cards, 9);
    assert.equal(row.week_cards, 9, '周列同步累计');
  } finally {
    cleanup();
  }
});

test('登出语义：旧 token 换发后失效（重新登录换新 token）', async () => {
  const { handle, cleanup } = setup();
  try {
    const reg = mockRes();
    await handle(mockReq('POST'), reg, '/auth/register', JSON.stringify({ email: 'a@b.co', password: 'secret123' }));
    const oldToken = reg.json().token;
    const relogin = mockRes();
    await handle(mockReq('POST'), relogin, '/auth/login', JSON.stringify({ email: 'a@b.co', password: 'secret123' }));
    assert.notEqual(relogin.json().token, oldToken, '登录应换发新 token');
    const stale = mockRes();
    await handle(mockReq('GET', oldToken), stale, '/history', '');
    assert.equal(stale.status, 401, '旧 token 应失效');
  } finally {
    cleanup();
  }
});