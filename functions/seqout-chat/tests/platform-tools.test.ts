import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformToolAdapter } from '../platform-tools.ts';

const catalog = [
  { tool_name: 'bioops_analysis_list_workflows', capability_id: 'analysis.list_workflows',
    side_effect: 'none', input_schema: { type: 'object', additionalProperties: false } },
  { tool_name: 'bioops_downloads_submit', capability_id: 'downloads.submit', side_effect: 'task' },
];
const body = { platform_tools: { catalog, delegation: 'isolated-delegation' } };

test('untrusted direct runtime never receives platform tools', () => {
  assert.equal(platformToolAdapter(new Request('http://local'), body, 'http://fixed/callback').tools.length, 0);
});

test('only read/prepare schemas projected, token is never a model tool definition', () => {
  const request = new Request('http://local', { headers: { 'x-cygnusx-platform-tools': 'trusted' } });
  const adapter = platformToolAdapter(request, body, 'http://fixed/callback');
  assert.equal(adapter.tools.length, 1);
  assert.ok(!JSON.stringify(adapter.tools).includes('isolated-delegation'));
  assert.equal(adapter.has('bioops_downloads_submit'), false);
});

test('callback has fixed URL, scoped ID, bearer and nonce; never retries errors', async () => {
  const request = new Request('http://local', { headers: { 'x-cygnusx-platform-tools': 'trusted' } });
  const adapter = platformToolAdapter(request, body, 'http://fixed/callback');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'http://fixed/callback');
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer isolated-delegation');
    const payload = JSON.parse(String(options?.body));
    assert.equal(payload.capability_id, 'analysis.list_workflows');
    assert.match(payload.call_id, /^[a-f0-9-]{36}$/);
    assert.ok(!('user_id' in payload));
    return new Response('{}', { status: 503 });
  };
  try {
    await assert.rejects(adapter.call('bioops_analysis_list_workflows', {}), /do not replay/);
    assert.equal(calls, 1);
    await assert.rejects(adapter.call('bioops_downloads_submit', {}), /unavailable/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
