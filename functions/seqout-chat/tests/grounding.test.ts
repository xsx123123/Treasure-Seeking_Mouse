// grounding（正文↔证据一致性校验）+ verifyAccession（编号存在性回源核验）回归测试（离线）
//
// 背景：系统对公共源只读、证据卡片与记录同源，但此前缺两个硬保障——
// ① 不检查模型正文里写的编号是否真实存在；② 正文与卡片仅渲染层并列，模型可能"正文写 A、卡片给 B"。
// groundingCheck 在主循环终态扫描正文编号、与证据卡片比对、对卡片外编号回源核验，
// 仍无法证实的经 {event:'grounding'} 下发；verifyAccession 按编号前缀路由到 seqout/NGDC/EPMC/Crossref。
//
// 运行：npm test（已随根目录测试套件执行，全程 mock fetch，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCAN_PATTERNS,
  scanAccessions,
  cardIdentifiers,
  verifyEndpointFor,
  verifyAccession,
  groundingCheck,
} from '../index.ts';

// ---------- scanAccessions：正文编号扫描 ----------

test('scanAccessions: 识别 GSE/GSM/SRR/SRP/PRJNA/PRJCA/PMID/DOI 并归一化', () => {
  const text = '数据集 gse117176（样本 GSM3272966，run SRR7526393）对应 PRJNA481344 / PRJCA000437，文献 PMID: 32015576，doi 10.1038/S41586-020-2649-2。';
  const ids = scanAccessions(text);
  assert.ok(ids.includes('GSE117176'), `小写 gse 应归一为大写：${JSON.stringify(ids)}`);
  assert.ok(ids.includes('GSM3272966'));
  assert.ok(ids.includes('SRR7526393'));
  assert.ok(ids.includes('PRJNA481344'));
  assert.ok(ids.includes('PRJCA000437'));
  assert.ok(ids.includes('PMID:32015576'), 'PMID 应带前缀归一');
  assert.ok(ids.includes('10.1038/s41586-020-2649-2'), 'DOI 应小写化并去掉句末标点');
});

test('scanAccessions: 去重保序，普通文本不误报', () => {
  assert.deepEqual(scanAccessions('GSE123 与 GSE123 再看 GSE456'), ['GSE123', 'GSE456']);
  assert.deepEqual(scanAccessions('这是一段没有任何编号的正文，version 10.2 也不是 DOI'), []);
  assert.equal(SCAN_PATTERNS.length > 0, true);
});

// ---------- cardIdentifiers：证据卡片标识集合 ----------

test('cardIdentifiers: 汇集 accession / meta.pmid / meta.doi（含 accession 本身是 DOI 的文献卡）', () => {
  const ids = cardIdentifiers([
    { tool: 'seqout_search', accession: 'GSE117176', title: 'x', summary: '', meta: {} },
    { tool: 'literature_search', accession: '10.1038/S41586-020-2649-2', title: 'y', summary: '', meta: { source: 'literature', pmid: '32015576', doi: '10.1038/s41586-020-2649-2' } },
  ]);
  assert.ok(ids.has('GSE117176'));
  assert.ok(ids.has('PMID:32015576'));
  assert.ok(ids.has('10.1038/s41586-020-2649-2'), 'meta.doi 与 accession 形态的 DOI 都要入集合');
});

// ---------- verifyEndpointFor / verifyAccession：回源核验路由 ----------

test('verifyEndpointFor: 按编号前缀路由到对应上游', () => {
  assert.match(verifyEndpointFor('GSE999999')?.url ?? '', /seqout.*\/project\/GSE999999/);
  assert.match(verifyEndpointFor('GSM123456')?.url ?? '', /\/sample-detail\/GSM123456/);
  assert.match(verifyEndpointFor('SRR7526393')?.url ?? '', /\/run\/SRR7526393/);
  assert.match(verifyEndpointFor('PRJCA000437')?.url ?? '', /ngdc.*bioProject\/PRJCA000437/i);
  assert.match(verifyEndpointFor('PMID:32015576')?.url ?? '', /europepmc.*EXT_ID%3A32015576/i);
  assert.match(verifyEndpointFor('10.1038/s41586-020-2649-2')?.url ?? '', /api\.crossref\.org\/works\//);
  assert.equal(verifyEndpointFor('SRX123456'), null, '实验级编号无稳定直查端点，应返回 null');
});

/** 替换全局 fetch 的测试辅助：按 URL 决定响应，返回调用记录（调用方用 t.after 恢复） */
function mockFetch(route: (url: string) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return route(url);
  }) as typeof fetch;
  return calls;
}

test('verifyAccession: 上游 200 → exists', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response(JSON.stringify({ accession: 'GSE117176' }), { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  assert.equal(await verifyAccession('GSE117176'), 'exists');
  assert.equal(calls.length, 1);
});

test('verifyAccession: 上游 404 → missing', async (t) => {
  const original = globalThis.fetch;
  mockFetch(() => new Response(JSON.stringify({ detail: 'No project found' }), { status: 404 }));
  t.after(() => { globalThis.fetch = original; });
  assert.equal(await verifyAccession('GSE999999'), 'missing');
});

test('verifyAccession: Europe PMC hitCount=0 → missing，>0 → exists', async (t) => {
  const original = globalThis.fetch;
  let hits = 0;
  mockFetch(() => new Response(JSON.stringify({ hitCount: hits, resultList: { result: [] } }), { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  assert.equal(await verifyAccession('PMID:99999999'), 'missing');
  hits = 1;
  assert.equal(await verifyAccession('PMID:32015576'), 'exists');
});

test('verifyAccession: 无核验通道的编号 → unknown（不发请求）', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('{}', { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  assert.equal(await verifyAccession('SRX123456'), 'unknown');
  assert.equal(calls.length, 0, '无通道编号不得发起网络请求');
});

// ---------- groundingCheck：正文↔证据一致性 ----------

test('groundingCheck: 正文编号全部来自 cards → 零警示且不回源核验', async () => {
  let verifyCalls = 0;
  const report = await groundingCheck('GSE117176 的 5 个 run（SRR7526393 起）见 PMID: 32015576', [
    { tool: 'seqout_search', accession: 'GSE117176', title: 'x', summary: '', meta: {} },
    { tool: 'seqout_get_runs', accession: 'SRR7526393', title: 'r', summary: '', meta: {} },
    { tool: 'literature_search', accession: '32015576', title: 'p', summary: '', meta: { source: 'literature', pmid: '32015576' } },
  ], { verify: () => { verifyCalls++; return Promise.resolve('missing'); } });
  assert.deepEqual(report.unconfirmed, [], '全部命中卡片时不得有未证实编号');
  assert.equal(verifyCalls, 0, '全部命中卡片时不得发起回源核验');
  assert.deepEqual(report.grounded.sort(), ['GSE117176', 'PMID:32015576', 'SRR7526393'].sort());
});

test('groundingCheck: 正文编造 GSE999999 → 回源 404 后列入未证实清单', async () => {
  const verified: string[] = [];
  const report = await groundingCheck('推荐 GSE117176，另见 GSE999999 的补充实验。', [
    { tool: 'seqout_search', accession: 'GSE117176', title: 'x', summary: '', meta: {} },
  ], {
    verify: (id) => { verified.push(id); return Promise.resolve(id === 'GSE999999' ? 'missing' : 'exists'); },
  });
  assert.deepEqual(verified, ['GSE999999'], '只有卡片外的编号才回源核验');
  assert.deepEqual(report.unconfirmed, [{ id: 'GSE999999', status: 'upstream_404' }]);
  assert.deepEqual(report.grounded, ['GSE117176']);
});

test('groundingCheck: 卡片外编号回源证实存在 → 进 confirmed，不警示', async () => {
  const report = await groundingCheck('正文引用了 GSE165500（本轮未出卡片）。', [], {
    verify: () => Promise.resolve('exists'),
  });
  assert.deepEqual(report.unconfirmed, []);
  assert.deepEqual(report.confirmed, ['GSE165500']);
});

test('groundingCheck: 上游整体不可达（全 unknown）→ 整次降级不提示，防基础设施误报', async () => {
  const report = await groundingCheck('提到 GSE999999 与 GSE888888。', [], {
    verify: () => Promise.resolve('unknown'),
  });
  assert.deepEqual(report.unconfirmed, [], '所有核验都无结论时不得误报');
});

test('groundingCheck: 超出核验配额的编号以 unverified 列入注记', async () => {
  const text = ['GSE100001', 'GSE100002', 'GSE100003', 'GSE100004', 'GSE100005', 'GSE100006', 'GSE100007'].join(' ');
  const verified: string[] = [];
  const report = await groundingCheck(text, [], {
    limit: 5,
    verify: (id) => { verified.push(id); return Promise.resolve('missing'); },
  });
  assert.equal(verified.length, 5, '最多回源核验 5 个');
  assert.deepEqual(
    report.unconfirmed,
    [
      { id: 'GSE100001', status: 'upstream_404' },
      { id: 'GSE100002', status: 'upstream_404' },
      { id: 'GSE100003', status: 'upstream_404' },
      { id: 'GSE100004', status: 'upstream_404' },
      { id: 'GSE100005', status: 'upstream_404' },
      { id: 'GSE100006', status: 'unverified' },
      { id: 'GSE100007', status: 'unverified' },
    ],
  );
});
