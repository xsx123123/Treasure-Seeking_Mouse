// ENA 直连适配器（ena_search 工具）回归测试（离线，mock fetch）
//
// 背景：ena_search 直连 ENA Portal API（/ena/portal/api/search，read_study 结果级），
// 是 seqout 镜像之外的独立欧洲数据源。ENA Portal 的 query 参数不接受裸自由文本
// （实测返回 "Query is in wrong format"），自由文本须包装为标题/描述匹配；
// 字段查询语法（tax_eq(9606)、study_title="..."）原样透传。
//
// 运行：npm test（已随根目录测试套件执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEnaQuery, enaStudyToDataset, searchEna, executeTool } from '../index.ts';

// ---------- buildEnaQuery：自由文本包装 vs 字段语法透传 ----------

test('buildEnaQuery: 自由文本逐词 AND（标题 OR 描述），带空格通配短语实测零命中', () => {
  assert.equal(
    buildEnaQuery('lung adenocarcinoma'),
    '(study_title="*lung*" OR description="*lung*") AND (study_title="*adenocarcinoma*" OR description="*adenocarcinoma*")',
  );
  assert.equal(buildEnaQuery('macrophage'), 'study_title="*macrophage*" OR description="*macrophage*"');
  assert.equal(buildEnaQuery('含有"引号"的词'), '(study_title="*含有*" OR description="*含有*") AND (study_title="*引号*" OR description="*引号*") AND (study_title="*的词*" OR description="*的词*")', '内层双引号必须剥掉，否则破坏 ENA 语法');
});

test('buildEnaQuery: 字段查询语法原样透传', () => {
  assert.equal(buildEnaQuery('tax_eq(9606)'), 'tax_eq(9606)');
  assert.equal(buildEnaQuery('study_title="lung" AND tax_eq(9606)'), 'study_title="lung" AND tax_eq(9606)');
});

// ---------- enaStudyToDataset：归一化到数据集卡片结构 ----------

test('enaStudyToDataset: read_study 行归一化为 accession/title/organism/source=ena', () => {
  const item = enaStudyToDataset({
    study_accession: 'prjeb55536', // 大小写归一
    study_title: 'Porcine nasal and lung macrophage subsets',
    scientific_name: 'Sus scrofa',
    description: 'Cells isolated by FACS and LCM.',
    center_name: 'EMBL-EBI',
    first_public: '2022-09-01',
  });
  assert.ok(item);
  assert.equal(item.accession, 'PRJEB55536');
  assert.equal(item.title, 'Porcine nasal and lung macrophage subsets');
  assert.equal(item.organism, 'Sus scrofa');
  assert.equal(item.summary, 'Cells isolated by FACS and LCM.');
  assert.equal(item.source, 'ena');
});

test('enaStudyToDataset: 缺 study_accession 的记录丢弃', () => {
  assert.equal(enaStudyToDataset({ study_title: 'no accession' }), null);
  assert.equal(enaStudyToDataset({}), null);
});

// ---------- searchEna / executeTool：mock fetch 离线用例 ----------

/** 替换全局 fetch：记录 URL 并按路由返回响应（调用方负责恢复） */
function mockFetch(route: (url: string) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return route(url);
  }) as typeof fetch;
  return calls;
}

test('searchEna: 直连 ENA Portal 并归一化结果，重复编号去重', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() =>
    new Response(JSON.stringify([
      { study_accession: 'PRJEB55536', study_title: 'Study A', scientific_name: 'Sus scrofa' },
      { study_accession: 'PRJEB55536', study_title: 'Study A', scientific_name: 'Sus scrofa' }, // 重复行
      { study_accession: 'PRJEB60000', study_title: 'Study B' },
    ]), { status: 200 }),
  );
  t.after(() => { globalThis.fetch = original; });
  const payload = (await searchEna({ query: 'porcine macrophage', limit: 10 })) as { source: string; total: number; results: { accession: string }[] };
  assert.equal(payload.source, 'ena');
  assert.equal(payload.total, 2, '重复 study_accession 应去重');
  assert.deepEqual(payload.results.map((r) => r.accession), ['PRJEB55536', 'PRJEB60000']);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.match(url.pathname, /\/ena\/portal\/api\/search/);
  assert.equal(url.searchParams.get('result'), 'read_study');
  assert.match(url.searchParams.get('query') ?? '', /study_title="\*porcine\*"/, '自由文本应逐词包装后下发');
});

test('executeTool: ena_search 走 validateSearchQuery 校验体系（空词直接抛，不发请求）', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('[]', { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(() => executeTool('ena_search', { query: '   ' }), /检索词为空/);
  await assert.rejects(() => executeTool('ena_search', { query: '!!!???' }), /不含任何字母或数字/);
  assert.equal(calls.length, 0, '非法检索词不得发起网络请求');
});

test('executeTool: ena_search 正常返回 wrap 结构（success + data.source=ena）', async (t) => {
  const original = globalThis.fetch;
  mockFetch(() => new Response(JSON.stringify([{ study_accession: 'PRJEB55536', study_title: 'Study A' }]), { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  const payload = (await executeTool('ena_search', { query: 'tax_eq(10090)' })) as { success: boolean; data: { source: string; results: unknown[] } };
  assert.equal(payload.success, true);
  assert.equal(payload.data.source, 'ena');
  assert.equal(payload.data.results.length, 1);
});
