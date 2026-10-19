import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('real Node HTTP bridge: shared secret + browser Bearer authorizes models and chat, not anonymous callers', async t => {
  let llmCalls = 0;
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    res.setHeader('Content-Type', req.url === '/models' ? 'application/json' : 'text/event-stream');
    if (req.url === '/models') res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    else { llmCalls++; res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Fixture answer.' } }] })}\n\ndata: [DONE]\n\n`); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => upstream.close());
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const dataDir = mkdtempSync(join(tmpdir(), 'treasure-bridge-'));
  const child = spawn(process.execPath, ['server/local.mjs'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, CHAT_API_PORT: String(port), CHAT_API_HOST: '127.0.0.1', CHAT_SHARED_SECRET: 'service-secret', CHAT_ACCESS_MODE: 'authenticated',
      LLM_API_KEY: 'fixture-key', MEOO_PROJECT_API_KEY: '', LLM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '',
      DATA_DIR: dataDir, STATS_FILE: join(dataDir, 'stats.json'), TREASURE_MOUSE_PLATFORM_ONLY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode !== null) return; const stopped = once(child, 'exit'); child.kill(); await stopped; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Node bridge startup timed out')), 10000);
    child.stdout.on('data', bytes => { if (String(bytes).includes('本地服务已启动')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
  });
  const endpoint = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { 'X-Chat-Key': 'service-secret' } })).status, 401);
  const registered = await fetch(endpoint + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bridge@example.test', password: 'testing123' }) });
  const { token } = await registered.json(); assert.ok(token);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const catalog = await fetch(endpoint, { headers }); assert.equal(catalog.status, 200);
  assert.ok(!JSON.stringify(await catalog.json()).includes('service-secret'));
  const stream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'fixture' }] }) });
  const body = await stream.text();
  assert.equal(stream.status, 200); assert.ok(body.includes('Fixture answer.')); assert.ok(body.includes('"event":"end"'));
  assert.equal(llmCalls, 1);
  const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3015' } });
  assert.ok(preflight.headers.get('access-control-allow-headers').includes('Authorization'));
});
