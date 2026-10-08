// seqout 单点降级兜底（NCBI E-utilities）回归测试（离线，mock fetch）
//
// 背景：seqout 是定期同步 NCBI 的镜像库，很新的项目未同步时项目/检索类查询直接 404。
// 兜底策略：仅当 seqout 返回 404/5xx 时直连 NCBI E-utilities（gds 库查 GEO、
// sra 库查 SRA/BioProject），结果标注 source='ncbi-direct'。
// 硬红线：GEO-only 项目的业务性空结果（emptyStudyResult，如 metadata/download 的
// "No experiments found" 404）不触发兜底——"项目存在但无数据"与"镜像未同步"是两回事。
//
// 运行：npm test（已随根目录测试套件执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executeTool, isSeqoutServerError, gdsSummaryToDataset, sraExpxmlToDataset, NCBI_DIRECT_NOTE } from '../index.ts';

// ---------- isSeqoutServerError：触发条件 ----------

test('isSeqoutServerError: 仅 404/5xx 触发，格式错误与其它错误不触发', () => {
  assert.equal(isSeqoutServerError(new Error('seqout 未收录该项目（HTTP 404：xx）')), true);
  assert.equal(isSeqoutServerError(new Error('seqout HTTP 502: bad gateway')), true);
  assert.equal(isSeqoutServerError(new Error('检索词为空或只含控制字符')), false);
  assert.equal(isSeqoutServerError(new Error('HTTP 422: unprocessable')), false);
  assert.equal(isSeqoutServerError('not an error'), false);
});

// ---------- 归一化纯函数 ----------

test('gdsSummaryToDataset: 只收 GSE 系列，GSM/GDS 条目丢弃', () => {
  const gse = gdsSummaryToDataset({ accession: 'GSE151530', title: 'liver cancer scRNA', summary: 's', taxon: 'Homo sapiens', gdstype: 'Expression profiling by high throughput sequencing', n_samples: 46 });
  assert.ok(gse);
  assert.equal(gse.accession, 'GSE151530');
  assert.equal(gse.organism, 'Homo sapiens');
  assert.equal(gse.source, 'ncbi-direct');
  assert.equal(gdsSummaryToDataset({ accession: 'GSM4581240', title: 'sample' }), null);
  assert.equal(gdsSummaryToDataset({ accession: 'GDS6244' }), null);
});

test('sraExpxmlToDataset: 从 expxml 提取 Study 编号/标题/物种/策略，XML 实体解码', () => {
  const item = sraExpxmlToDataset({
    expxml: '<Summary><Title>x</Title></Summary><Study acc="SRP153927" name="Single cell RNA sequencing of murine macrophages"/><Organism taxid="10090" ScientificName="Mus musculus"/><Library_descriptor><LIBRARY_STRATEGY>RNA-Seq</LIBRARY_STRATEGY></Library_descriptor>',
  });
  assert.ok(item);
  assert.equal(item.accession, 'SRP153927');
  assert.equal(item.title, 'Single cell RNA sequencing of murine macrophages');
  assert.equal(item.organism, 'Mus musculus');
  assert.equal(item.library_strategy, 'RNA-Seq');
  assert.equal(sraExpxmlToDataset({ expxml: '<Summary>no study here</Summary>' }), null);
});

// ---------- 兜底链路（mock fetch） ----------

/** 替换全局 fetch：按 URL 路由（调用方负责恢复），返回调用记录 */
function mockFetch(route: (url: string) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return route(url);
  }) as typeof fetch;
  return calls;
}

const GDS_ESUMMARY = {
  result: {
    uids: ['200999999'],
    '200999999': { uid: '200999999', accession: 'GSE999999', title: 'A very new study', summary: 'Just published.', taxon: 'Homo sapiens', entrytype: 'GSE' },
  },
};

function routeSeqoutDown(url: string): Response {
  if (url.includes('seqout.org')) return new Response(JSON.stringify({ detail: 'No project found for PRJ accession GSE999999' }), { status: 404 });
  if (url.includes('esearch')) return new Response(JSON.stringify({ esearchresult: { idlist: ['200999999'] } }), { status: 200 });
  if (url.includes('esummary')) return new Response(JSON.stringify(GDS_ESUMMARY), { status: 200 });
  throw new Error(`unexpected url ${url}`);
}

test('兜底：seqout 404（新项目未同步）→ NCBI gds 命中，结果标注 ncbi-direct', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(routeSeqoutDown);
  t.after(() => { globalThis.fetch = original; });
  const payload = (await executeTool('seqout_get_project_detail', { accession: 'GSE999999' })) as {
    success: boolean; data: { source: string; note: string; results: { accession: string; title: string }[] };
  };
  assert.equal(payload.success, true);
  assert.equal(payload.data.source, 'ncbi-direct');
  assert.equal(payload.data.note, NCBI_DIRECT_NOTE);
  assert.equal(payload.data.results[0].accession, 'GSE999999');
  assert.ok(calls.some((u) => u.includes('eutils.ncbi.nlm.nih.gov')), '应调用 NCBI E-utilities');
});

test('兜底：seqout_search_geo 404 → NCBI gds 关键词检索', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(routeSeqoutDown);
  t.after(() => { globalThis.fetch = original; });
  const payload = (await executeTool('seqout_search_geo', { query: 'brand new topic' })) as { success: boolean; data: { source: string; results: unknown[] } };
  assert.equal(payload.success, true);
  assert.equal(payload.data.source, 'ncbi-direct');
  assert.equal(payload.data.results.length, 1);
  assert.ok(calls.some((u) => u.includes('esearch') && u.includes('db=gds')));
});

test('兜底：seqout 正常 200 时绝不触碰 NCBI', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response(JSON.stringify({ accession: 'GSE117176', title: 'ok' }), { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  const payload = (await executeTool('seqout_get_project_detail', { accession: 'GSE117176' })) as { success: boolean; data: { accession: string } };
  assert.equal(payload.success, true);
  assert.equal(payload.data.accession, 'GSE117176');
  assert.ok(calls.every((u) => !u.includes('eutils')), 'seqout 正常时不得调用 NCBI');
});

test('兜底：NCBI 也无命中 → 抛原始 seqout 错误（信息更有用）', async (t) => {
  const original = globalThis.fetch;
  mockFetch((url) => {
    if (url.includes('seqout.org')) return new Response(JSON.stringify({ detail: 'No project found' }), { status: 404 });
    if (url.includes('esearch')) return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 });
    throw new Error(`unexpected url ${url}`);
  });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(() => executeTool('seqout_get_project_detail', { accession: 'GSE999999' }), /seqout/, '兜底无果时应抛原始 seqout 错误');
});

test('硬红线：GEO-only 业务空矿（No experiments found 404）走 emptyStudyResult，不触发 NCBI 兜底', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch((url) => {
    if (url.includes('seqout.org')) return new Response('No experiments found for this study', { status: 404 });
    throw new Error(`unexpected url ${url}`);
  });
  t.after(() => { globalThis.fetch = original; });
  const payload = (await executeTool('seqout_get_metadata_csv', { study_accession: 'PRJNA636285' })) as {
    success: boolean; data: { empty?: boolean; note?: string };
  };
  assert.equal(payload.success, true);
  assert.equal(payload.data.empty, true, '业务空矿仍是 success+empty 形态');
  assert.ok(calls.every((u) => !u.includes('eutils')), '业务空矿不得触发 NCBI 兜底');
});
