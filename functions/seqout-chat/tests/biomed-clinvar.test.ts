// clinvar_search / clinvar_get（NCBI E-utilities 适配器）回归测试（离线，mock fetch + fixtures）
//
// 黄金用例（2026-10-18 实测固化，勿随意改期望值）：
// - VCV000065533（LYST c.1540C>T）：版本 .11、germline Pathogenic、
//   review "criteria provided, multiple submitters, no conflicts"、RCV000055723×1、SCV×4；
// - VCV000013961（BRAF）：版本 .143、三类分列（germline 冲突总分 / somatic Tier I - Strong /
//   oncogenicity Oncogenic）、submitter_conflict=true、SCV×45、RCV×38。
// 覆盖 design 2.6 八类用例：VCV 黄金 / RCV clinvarset 分流 / SCV 拒绝 / 三类分列 / 冲突并列 /
// XXE 防护 / 配额耗尽 / esearch 零命中。
//
// ⚠️ ClinVar 链路共享进程级 ncbiBucket（容量 2.5、无 key 回填 2.5 token/s）：
// 网络用例按声明顺序串行执行，每个耗桶用例前 topUp() 预热配额，配额耗尽用例放最后。
//
// 运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { searchClinvar, getClinvar, extractVcvEntry, extractRcvEntry } from '../biomed/clinvar.ts';
import { executeBiomedTool, extractBiomedCards } from '../biomed/index.ts';
import { acquireNcbi, sleep } from '../shared.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'biomed');

function fixture(name: string, ext = 'json'): string {
  return gunzipSync(readFileSync(join(FIXTURES, `${name}.${ext}.gz`))).toString('utf8');
}

interface FetchCall { url: string; method: string }

function mockFetch(route: (url: string) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push({ url, method: 'GET' });
    return route(url);
  }) as typeof fetch;
  return calls;
}

/** 网络用例前预热 ncbiBucket：按无 key 速率 2.5 token/s 回填所需 token（留 150ms 余量） */
async function topUp(tokens: number): Promise<void> {
  await sleep((tokens / 2.5) * 1000 + 150);
}

// ---------- ① VCV 黄金用例（纯提取器，离线零网络） ----------

test('extractVcvEntry: VCV000065533 黄金用例——版本 .11、分类、审评状态提取正确', () => {
  const e = extractVcvEntry(fixture('clinvar-vcv065533', 'xml'));
  assert.ok(e, 'fixture 应解析出 VariationArchive 条目');
  if (!e) return;
  assert.equal(e.vcv_accession, 'VCV000065533');
  assert.equal(e.version, '.11');
  assert.equal(e.gene, 'LYST');
  assert.equal(e.title, 'NM_000081.4(LYST):c.1540C>T (p.Arg514Ter)');
  assert.equal(e.germline_classification, 'Pathogenic');
  assert.equal(e.review_status, 'criteria provided, multiple submitters, no conflicts');
  assert.equal(e.last_evaluated, '2025-10-18');
  assert.deepEqual(e.rcv_list, [
    { rcv_accession: 'RCV000055723', condition: 'Chédiak-Higashi syndrome', classification: 'Pathogenic' },
  ]);
  assert.equal(e.scv_assertions.length, 4);
  assert.deepEqual(
    { submitter: e.scv_assertions[0].submitter, type: e.scv_assertions[0].assertion_type, cls: e.scv_assertions[0].classification },
    { submitter: 'GeneReviews', type: 'germline', cls: 'not provided' },
  );
  assert.equal(e.submitter_conflict, false, '四方断言一致（not provided 不参与冲突判定）');
  assert.match(e.disclaimer, /专业人士审阅/);
});

// ---------- ④⑤ 三类分列 + 提交者冲突（VCV000013961 BRAF fixture） ----------

test('extractVcvEntry: VCV000013961——germline/somatic/oncogenic 三类分列', () => {
  const e = extractVcvEntry(fixture('clinvar-vcv13961', 'xml'));
  assert.ok(e);
  if (!e) return;
  assert.equal(e.version, '.143');
  assert.equal(e.gene, 'BRAF');
  assert.equal(e.germline_classification, 'Conflicting classifications of pathogenicity');
  assert.equal(e.somatic_impact, 'Tier I - Strong');
  assert.equal(e.oncogenicity, 'Oncogenic');
  assert.equal(e.review_status, 'criteria provided, conflicting classifications');
});

test('extractVcvEntry: SCV 断言分类不一致 → submitter_conflict=true 且各方断言并列保留', () => {
  const e = extractVcvEntry(fixture('clinvar-vcv13961', 'xml'));
  assert.ok(e);
  if (!e) return;
  assert.equal(e.submitter_conflict, true);
  assert.equal(e.scv_assertions.length, 45);
  assert.equal(e.rcv_list.length, 38);
  // 冲突证据：germline 断言存在 >1 种非空分类，全部并列保留在明细中
  const germlineClasses = new Set(e.scv_assertions.filter((a) => a.assertion_type === 'germline').map((a) => a.classification));
  assert.ok(germlineClasses.size > 1, `germline 断言应含多种分类（实际 ${[...germlineClasses]}）`);
  for (const c of ['Pathogenic', 'Likely pathogenic', 'Uncertain significance']) {
    assert.ok(germlineClasses.has(c), `冲突各方断言（${c}）应并列保留`);
  }
  const somaticClasses = new Set(e.scv_assertions.filter((a) => a.assertion_type === 'somatic').map((a) => a.classification));
  assert.ok(somaticClasses.size > 1, 'somatic 断言也存在分级冲突（Tier I / Tier II）');
});

// ---------- RCV 形态（clinvarset，纯提取器） ----------

test('extractRcvEntry: RCV000055723 clinvarset 形态——父级 VCV 取自 MeasureSet@Acc', () => {
  const e = extractRcvEntry(fixture('clinvar-rcv055723', 'xml'));
  assert.ok(e);
  if (!e) return;
  assert.equal(e.vcv_accession, 'VCV000065533', 'RCV 记录应归并到父级 VCV');
  assert.equal(e.version, '.11');
  assert.equal(e.gene, 'LYST');
  assert.equal(e.germline_classification, 'Pathogenic');
  assert.equal(e.scv_assertions.length, 4);
  assert.equal(e.submitter_conflict, false);
  assert.equal(e.rcv_list.length, 1);
  assert.equal(e.rcv_list[0].rcv_accession, 'RCV000055723');
  assert.match(e.title ?? '', /AND Chédiak-Higashi syndrome/, 'clinvarset 标题为「变体 AND 疾病」形态');
});

// ---------- ⑥ XXE 防护（安全用例，不可省略） ----------

test('extractVcvEntry: XXE 注入 fixture——不发起网络请求、实体文本原样不展开', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('should not be called', { status: 200 }));
  t.after(() => { globalThis.fetch = original; });

  const e = extractVcvEntry(fixture('xxe-inject', 'xml'));
  assert.ok(e, '构造性 fixture（VariationArchive 形态）应可解析');
  if (!e) return;
  assert.equal(calls.length, 0, '提取器为纯函数，不得发起任何网络请求');
  assert.equal(e.germline_classification, '&xxe;', '外部实体引用原样保留，绝不展开为文件内容');
  assert.equal(e.scv_assertions[0]?.classification, '&xxe-remote;');
  assert.equal(e.title, 'NM_000381.4(AIRE):c.1249A>G (p.Ser417Gly)', '预定义实体（&gt;）正常解码——只解码 5 个预定义实体');
  assert.equal(e.gene, 'AIRE');
  const dumped = JSON.stringify(e);
  assert.ok(!dumped.includes('file:///'), 'DOCTYPE 中的 SYSTEM file URI 不得泄漏进结果');
  assert.ok(!dumped.includes('attacker.example'), 'DOCTYPE 中的远程实体 URI 不得泄漏进结果');
});

// ---------- 卡片投影（三类分列 + 冲突标记 + disclaimer） ----------

test('extractBiomedCards: clinvar_get 信封 → 三类分列卡片 + 冲突标记 + disclaimer', () => {
  const entry = extractVcvEntry(fixture('clinvar-vcv13961', 'xml'));
  assert.ok(entry);
  const cards = extractBiomedCards('clinvar_get', { success: true, data: { results: [entry] } }) as {
    tool: string; accession: string; meta: Record<string, string>; summary: string;
  }[];
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.tool, 'clinvar_get');
  assert.equal(c.accession, 'VCV000013961.143', 'accession 为 VCV 大写 + 版本号（与二期 grounding pattern 对齐）');
  assert.equal(c.meta.source, 'clinvar');
  assert.equal(c.meta.germline_classification, 'Conflicting classifications of pathogenicity');
  assert.equal(c.meta.somatic_impact, 'Tier I - Strong');
  assert.equal(c.meta.oncogenicity, 'Oncogenic');
  assert.equal(c.meta.submitter_conflict, 'true', '冲突标记必须显式传给前端');
  assert.equal(c.meta.scv_count, '45');
  assert.match(c.meta.disclaimer, /专业人士审阅/, 'disclaimer 必带（spec 5.4.1）');
  assert.ok(c.meta.url?.includes('clinvar/variation/13961'), '详情条目从 VCV 编号构造去前导零 URL');
  assert.match(c.summary, /germline：Conflicting/, 'summary 三类分列呈现');
});

// ---------- ② VCV 入参走 efetch rettype=vcv（端到端信封） ----------

test('executeBiomedTool clinvar_get: VCV 入参走 efetch rettype=vcv，端到端信封', async (t) => {
  await topUp(1);
  const original = globalThis.fetch;
  const calls = mockFetch((url) =>
    url.includes('efetch.fcgi')
      ? new Response(fixture('clinvar-vcv065533', 'xml'), { status: 200, headers: { 'Content-Type': 'text/xml' } })
      : new Response('{}', { status: 200 }),
  );
  t.after(() => { globalThis.fetch = original; });

  const payload = (await executeBiomedTool('clinvar_get', { accession: 'VCV000065533' })) as {
    success: boolean; data: { results: { vcv_accession: string; version: string; germline_classification?: string }[]; total: number; source: string };
  };
  assert.equal(payload.success, true);
  assert.equal(payload.data.source, 'clinvar');
  assert.equal(payload.data.total, 1);
  assert.equal(payload.data.results[0].vcv_accession, 'VCV000065533');
  assert.equal(payload.data.results[0].version, '.11');
  assert.equal(payload.data.results[0].germline_classification, 'Pathogenic');

  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('db'), 'clinvar');
  assert.equal(params.get('id'), 'VCV000065533');
  assert.equal(params.get('rettype'), 'vcv');
  assert.equal(params.get('retmode'), 'xml');
});

// ---------- ② RCV 入参走 clinvarset 分支（断言请求 rettype） ----------

test('getClinvar: RCV 入参走 efetch rettype=clinvarset 分支', async (t) => {
  await topUp(1);
  const original = globalThis.fetch;
  const calls = mockFetch((url) =>
    url.includes('efetch.fcgi')
      ? new Response(fixture('clinvar-rcv055723', 'xml'), { status: 200, headers: { 'Content-Type': 'text/xml' } })
      : new Response('{}', { status: 200 }),
  );
  t.after(() => { globalThis.fetch = original; });

  const payload = (await getClinvar({ accession: 'RCV000055723' })) as {
    data: { results: { vcv_accession: string; version: string; rcv_list: { rcv_accession: string }[] }[] };
  };
  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('rettype'), 'clinvarset', 'RCV 编号必须走 clinvarset 分支');
  assert.equal(params.get('id'), 'RCV000055723');
  const e = payload.data.results[0];
  assert.equal(e.vcv_accession, 'VCV000065533');
  assert.equal(e.version, '.11');
  assert.equal(e.rcv_list[0].rcv_accession, 'RCV000055723');
});

// ---------- ③ SCV 前缀拒绝：层级说明（不耗配额、零 fetch） ----------

test('getClinvar: SCV 前缀拒绝——消息含 VCV/RCV 层级说明（零 fetch）', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('{}', { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(
    getClinvar({ accession: 'SCV000000019' }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /SCV 为单提交者断言记录，不支持直接查询/);
      assert.match(msg, /VCV 编号（变异汇总记录/);
      assert.match(msg, /RCV 编号（变异-疾病关系记录/);
      return true;
    },
  );
  await assert.rejects(getClinvar({ accession: 'XYZ123' }), /编号格式不正确/);
  assert.equal(calls.length, 0, '编号校验失败不得发起任何上游请求');
});

// ---------- efetch ERROR XML（HTTP 200 + <ERROR>）→ 如实转述，不吞成「未找到」 ----------

test('getClinvar: efetch 返回 ERROR XML → not_found 信封并转述上游原文', async (t) => {
  await topUp(1);
  const original = globalThis.fetch;
  mockFetch((url) =>
    url.includes('efetch.fcgi')
      ? new Response(fixture('clinvar-vcv140095', 'xml'), { status: 200, headers: { 'Content-Type': 'text/xml' } })
      : new Response('{}', { status: 200 }),
  );
  t.after(() => { globalThis.fetch = original; });
  const payload = (await getClinvar({ accession: 'VCV000999999' })) as {
    success: boolean; data: { empty: boolean; not_found: boolean; note?: string };
  };
  assert.equal(payload.success, true);
  assert.equal(payload.data.empty, true);
  assert.equal(payload.data.not_found, true);
  assert.match(payload.data.note ?? '', /ID list is empty/, '上游 ERROR 原文应如实转述');
  assert.match(payload.data.note ?? '', /VCV=变异汇总 \/ RCV=变异-疾病关系/);
});

// ---------- ⑧ esearch 零命中 → not_found 信封 ----------

test('searchClinvar: esearch 零命中 → not_found 信封 + 字段语法建议', async (t) => {
  await topUp(1);
  const original = globalThis.fetch;
  const calls = mockFetch((url) => {
    if (url.includes('esearch.fcgi')) {
      return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  t.after(() => { globalThis.fetch = original; });
  const payload = (await searchClinvar({ term: 'ZZZNOTAREALGENE999' })) as {
    success: boolean; data: { empty: boolean; not_found: boolean; note?: string; total: number };
  };
  assert.equal(payload.success, true);
  assert.equal(payload.data.empty, true);
  assert.equal(payload.data.not_found, true);
  assert.equal(payload.data.total, 0);
  assert.match(payload.data.note ?? '', /未命中检索词/);
  assert.match(payload.data.note ?? '', /TP53\[gene\]/, '建议应包含 ClinVar 字段语法示例');
  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('db'), 'clinvar');
  assert.equal(params.get('term'), 'ZZZNOTAREALGENE999');
  assert.equal(params.get('retmode'), 'json');
});

// ---------- esearch → esummary 黄金链路（2 token） ----------

test('searchClinvar: esearch→esummary 两段链路——概览条目黄金值，缺失 uid 防御性丢弃', async (t) => {
  await topUp(2);
  const original = globalThis.fetch;
  const calls = mockFetch((url) => {
    if (url.includes('esearch.fcgi')) return new Response(fixture('clinvar-esearch'), { status: 200 });
    if (url.includes('esummary.fcgi')) return new Response(fixture('clinvar-esummary'), { status: 200 });
    return new Response('{}', { status: 200 });
  });
  t.after(() => { globalThis.fetch = original; });

  const payload = (await searchClinvar({ term: 'TP53[gene]', limit: 3 })) as {
    success: boolean; data: {
      total: number; build_version: string;
      results: { vcv_accession: string; version?: string; gene?: string; condition: string; germline_classification?: string; review_status?: string; last_evaluated?: string; url: string; disclaimer: string }[];
    };
  };
  assert.equal(payload.success, true);
  // esearch 命中 3 个 uid，但 esummary fixture 只有 2 条记录——缺失行丢弃而非报错
  assert.equal(payload.data.total, 2);
  assert.equal(payload.data.build_version, 'unknown', 'ClinVar 无版本元数据端点，如实标 unknown 不拼造');

  const first = payload.data.results[0];
  assert.equal(first.vcv_accession, 'VCV004982772');
  assert.equal(first.version, '.1');
  assert.equal(first.gene, 'TP53');
  assert.equal(first.germline_classification, 'Likely benign');
  assert.equal(first.condition, 'TP53-related disorder', '疾病名取自 germline trait_set');
  assert.equal(first.review_status, 'criteria provided, single submitter');
  assert.equal(first.last_evaluated, '2026/08/11 00:00');
  assert.ok(first.url.includes('clinvar/variation/4982772'));
  assert.match(first.disclaimer, /专业人士审阅/);
  assert.equal(payload.data.results[1].vcv_accession, 'VCV004933289');
  assert.equal(payload.data.results[1].germline_classification, 'Uncertain significance');

  const esearch = new URL(calls[0].url).searchParams;
  assert.equal(esearch.get('retmax'), '3');
  const esummary = new URL(calls[1].url).searchParams;
  assert.equal(esummary.get('db'), 'clinvar');
  assert.equal(esummary.get('id'), '4982772,4933289,4933288');
});

// ---------- ⑦ 配额耗尽 → 「调用频率限制」而非 not_found（放最后：耗尽共享桶） ----------

test('searchClinvar: ncbiBucket 无 token → 抛「调用频率限制」且零 fetch（绝不算未找到）', async (t) => {
  while (acquireNcbi()) { /* 排空进程级共享桶 */ }
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('{}', { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(
    searchClinvar({ term: 'TP53[gene]' }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /调用频率限制/);
      assert.match(msg, /请稍后重试/);
      assert.ok(!msg.includes('未找到'), '配额不足 ≠ not_found（spec 4.2.2 红线）');
      return true;
    },
  );
  assert.equal(calls.length, 0, '配额检查在上游请求之前，不得发起任何 fetch');
});