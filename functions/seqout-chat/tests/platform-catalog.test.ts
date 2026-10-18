import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { platformToolAdapter } from '../platform-tools.ts';

// Exported by the Python authority for this isolated cross-language check.
// Never maintain another business schema in Node.
test('S5-B shared catalog dispatch uses fixed callback and preserves business result', {
  skip: !process.env.CYGNUSX_TEST_CATALOG_PATH,
}, async () => {
  const catalog = JSON.parse(readFileSync(process.env.CYGNUSX_TEST_CATALOG_PATH!, 'utf8'));
  const adapter = platformToolAdapter(new Request('http://isolated', {
    headers: { 'x-cygnusx-platform-tools': 'trusted' },
  }), { platform_tools: { catalog, delegation: 'test-delegation' } }, 'http://fixed.test/callback');
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://fixed.test/callback');
    assert.equal(options?.redirect, 'error');
    const body = JSON.parse(String(options?.body));
    assert.match(body.call_id, /^[a-f0-9-]{36}$/);
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-delegation');
    seen.push(body.capability_id);
    return Response.json({ schema_version: '1.0', invocation_id: 'isolated', result: {
      runtime_status: 'BLOCKED', write_enabled: false, source_evidence: [],
    } });
  };
  try {
    for (const capability of catalog.filter((c: { capability_id: string }) =>
      ['downloads.describe_capabilities', 'dataset.discover', 'dataset.list_project_assets',
        'dataset.inspect', 'dataset.list_files', 'tasks.get_status', 'downloads.prepare',
        'dataset.prepare_import'].includes(c.capability_id))) {
      const tool = adapter.tools.find(t => t.function.name === capability.tool_name);
      assert.deepEqual(tool?.function.parameters, capability.input_schema);
      const result = await adapter.call(capability.tool_name, {}) as { result: { write_enabled: boolean } };
      assert.equal(result.result.write_enabled, false);
    }
    assert.equal(seen.length, 8);
    assert.equal(adapter.has('bioops_downloads_submit'), false);
    assert.equal(adapter.has('bioops_dataset_execute_import'), false);
    assert.ok(!JSON.stringify(adapter.tools).includes('test-delegation'));
  } finally { globalThis.fetch = original; }
});
