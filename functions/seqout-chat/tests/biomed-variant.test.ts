// variant_search / variant_get（MyVariant 适配器）回归测试（离线，mock fetch + fixtures）
//
// 黄金用例（2026-10-18 实测固化，勿随意改期望值）：
// - rs58991260 在 hg19 → chr1:g.218631822G>A（有 CADD 无 ClinVar/gnomAD 聚合）；
//   在 hg38 → chr1:g.218458480G>A（CADD 集合级缺失，正好断言 missing_note 不跨组装补值）。
// 覆盖 design 2.6 七类用例：双坐标黄金 / 多等位 size≥20 / 格式拒绝零 fetch / c. HGVS 拒绝 /
// URL 编码（> → %3E、冒号保留）/ hg38 缺 CADD 的 missing_note / region 与 variant 二选一。
//
// 运行：npm test（MyVariant 不占 NCBI token bucket，无测试间限流）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { searchVariants, getVariant, requireAssembly } from '../biomed/variant.ts';
import { extractBiomedCards } from '../biomed/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'biomed');

function fixture(name: string): string {
  return gunzipSync(readFileSync(join(FIXTURES, `${name}.json.gz`))).toString('utf8');
}

interface FetchCall { url: string; method: string; body?: string }

function mockFetch(route: (url: string) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    return route(url);
  }) as typeof fetch;
  return calls;
}

/** MyVariant /metadata 无独立 fixture（探测值 build_version=20250624），路由内联返回 */
function variantRoute(queryHandler: (url: string) => Response): (url: string) => Response {
  return (url) =>
    url.includes('/metadata')
      ? new Response(JSON.stringify({ build_version: '20250624' }), { status: 200 })
      : queryHandler(url);
}

interface VariantEntry {
  variant_id: string; assembly: string; rsid?: string; gene?: string;
  chr?: string; pos?: string; ref?: string; alt?: string; cytoband?: string;
  sources_summary: string; missing_note?: string;
}
interface VariantData {
  results: VariantEntry[]; total: number; source: string; build_version: string;
  assembly: string; empty?: boolean; not_found?: boolean; note?: string;
}

// ---------- ① 黄金用例：同一 rsID 双坐标各自标注 assembly ----------

test('searchVariants: 黄金用例——rs58991260 在 hg19/hg38 返回不同坐标且各自标注 assembly', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(variantRoute((url) => {
    const assembly = new URL(url).searchParams.get('assembly') ?? '';
    if (assembly === 'hg19') return new Response(fixture('myvariant-rs58991260-hg19'), { status: 200 });
    if (assembly === 'hg38') return new Response(fixture('myvariant-rs58991260-hg38'), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
  t.after(() => { globalThis.fetch = original; });

  const hg19 = (await searchVariants({ variant: 'rs58991260', assembly: 'hg19' })) as { data: VariantData };
  assert.equal(hg19.data.assembly, 'hg19');
  assert.equal(hg19.data.results.length, 1);
  assert.equal(hg19.data.results[0].variant_id, 'chr1:g.218631822G>A', '黄金值：hg19 坐标');
  assert.equal(hg19.data.results[0].assembly, 'hg19');
  assert.equal(hg19.data.results[0].rsid, 'rs58991260');
  assert.equal(hg19.data.results[0].chr, '1');
  assert.equal(hg19.data.results[0].pos, '218631822');
  assert.equal(hg19.data.results[0].ref, 'G');
  assert.equal(hg19.data.results[0].alt, 'A');
  assert.equal(hg19.data.results[0].sources_summary, 'dbSNP ✓ / ClinVar 聚合 ✗ / gnomAD exome ✗ / CADD ✓');

  const hg38 = (await searchVariants({ variant: 'rs58991260', assembly: 'hg38' })) as { data: VariantData };
  assert.equal(hg38.data.assembly, 'hg38');
  assert.equal(hg38.data.results[0].variant_id, 'chr1:g.218458480G>A', '黄金值：hg38 坐标（同一 rsID，组装偏移）');
  assert.equal(hg38.data.results[0].assembly, 'hg38');

  assert.equal(hg19.data.build_version, '20250624');
  // rsID 检索必须走 /query 端点
  const queryCalls = calls.filter((c) => c.url.includes('/query'));
  assert.equal(queryCalls.length, 2);
  assert.equal(new URL(queryCalls[0].url).searchParams.get('q'), 'rs58991260');
});

// ---------- ⑥ hg38 缺 CADD：missing_note 集合级缺口说明，不跨组装补值 ----------

test('searchVariants: hg38 缺 CADD → missing_note 标注集合级缺口，不跨组装补值', async (t) => {
  const original = globalThis.fetch;
  mockFetch(variantRoute((url) =>
    (new URL(url).searchParams.get('assembly') ?? '') === 'hg38'
      ? new Response(fixture('myvariant-rs58991260-hg38'), { status: 200 })
      : new Response('{}', { status: 200 }),
  ));
  t.after(() => { globalThis.fetch = original; });
  const payload = (await searchVariants({ variant: 'rs58991260', assembly: 'hg38' })) as { data: VariantData };
  const e = payload.data.results[0];
  assert.equal(e.sources_summary, 'dbSNP ✓ / ClinVar 聚合 ✗ / gnomAD exome ✗ / CADD ✗');
  assert.match(e.missing_note ?? '', /CADD 在 hg38 集合暂无覆盖（集合级缺口，非该变异特有）/, 'hg38 的 CADD 缺口按集合级说明');
  assert.match(e.missing_note ?? '', /ClinVar 聚合无该变异记录/);
  assert.match(e.missing_note ?? '', /gnomAD exome 无该变异频率数据/);
  // 同一 rsID 在 hg19 有 CADD——但 hg38 结果绝不借用 hg19 的 CADD 数据
  assert.ok(!e.sources_summary.includes('CADD ✓'));
});

// ---------- ② 多等位 rsID：size 钳至 ≥20 保证候选全保留 ----------

test('searchVariants: rsID 检索 size 钳至 ≥20（多等位候选全保留）', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(variantRoute(() => new Response(fixture('myvariant-rs58991260-hg19'), { status: 200 })));
  t.after(() => { globalThis.fetch = original; });
  await searchVariants({ variant: 'rs334', assembly: 'hg19' }); // HBB 三等位 rsID
  const p1 = new URL(calls[calls.length - 1].url).searchParams;
  assert.equal(p1.get('size'), '20', '默认 limit=10 时 size 至少 20');
  await searchVariants({ variant: 'rs334', assembly: 'hg19', limit: 50 });
  const p2 = new URL(calls[calls.length - 1].url).searchParams;
  assert.equal(p2.get('size'), '50', 'limit=50 时取更大者');
  assert.equal(p2.get('q'), 'rs334');
});

// ---------- ③⑦ 参数校验：格式拒绝 / 二选一 / assembly 必填（全部零 fetch） ----------

test('searchVariants: rs123abc 格式拒绝 + region/variant 二选一 + assembly 必填（零 fetch）', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('{}', { status: 200 }));
  t.after(() => { globalThis.fetch = original; });

  await assert.rejects(
    searchVariants({ variant: 'rs123abc', assembly: 'hg38' }),
    /变异标识格式不正确.*rsID（rs \+ 数字/,
  );
  await assert.rejects(
    searchVariants({ assembly: 'hg38' }),
    /必须提供 variant（rsID（如 rs58991260）或基因组 HGVS/,
  );
  await assert.rejects(
    searchVariants({ variant: 'rs58991260', region: { chromosome: '7', start: 1, end: 100 }, assembly: 'hg38' }),
    /只能二选一/,
  );
  await assert.rejects(
    searchVariants({ variant: 'rs58991260' }),
    /参考基因组组装（assembly）必填且只能为 hg19（GRCh37）或 hg38（GRCh38）/,
  );
  assert.equal(calls.length, 0, '参数校验失败不得发起任何上游请求');
});

test('requireAssembly: 只接受 hg19/hg38（大小写不敏感），其余拒绝', () => {
  assert.equal(requireAssembly('HG38'), 'hg38');
  assert.equal(requireAssembly(' hg19 '), 'hg19');
  assert.throws(() => requireAssembly('GRCh38'), /必填且只能为/);
  assert.throws(() => requireAssembly(''), /必填且只能为/);
  assert.throws(() => requireAssembly(undefined), /必填且只能为/);
});

// ---------- ④ c./p. HGVS 拒绝：不支持自动转换，不得编造坐标 ----------

test('variant_search/variant_get: 转录本（c.）与蛋白（p.）HGVS 拒绝（零 fetch）', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('{}', { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  // 最常见形态：NM_000546.5:c.997C>T（c. 前是冒号——design 正则曾漏掉此形态）
  await assert.rejects(
    searchVariants({ variant: 'NM_000546.5:c.997C>T', assembly: 'hg38' }),
    (err: unknown) => {
      assert.match(err instanceof Error ? err.message : String(err), /不支持转录本（c.）或蛋白（p.）HGVS 自动转换/);
      assert.match(err instanceof Error ? err.message : String(err), /不得返回编造坐标/);
      return true;
    },
  );
  await assert.rejects(getVariant({ variant_id: 'NM_000546.5:c.997C>T', assembly: 'hg38' }), /不支持转录本/);
  await assert.rejects(getVariant({ variant_id: 'p.Arg514Ter', assembly: 'hg38' }), /不支持转录本/);
  assert.equal(calls.length, 0);
});

// ---------- ⑤ HGVS URL 编码：> 为 %3E、冒号保留 ----------

test('variant_get: HGVS 走 /variant/{id} 精确端点——URL 中 > 编码为 %3E、冒号保留', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(variantRoute((url) =>
    url.includes('/variant/')
      ? new Response(fixture('myvariant-variant-hg38'), { status: 200 })
      : new Response('{}', { status: 200 }),
  ));
  t.after(() => { globalThis.fetch = original; });
  const payload = (await getVariant({ variant_id: 'chr1:g.218458480G>A', assembly: 'hg38' })) as { data: VariantData };
  const e = payload.data.results[0];
  assert.equal(e.variant_id, 'chr1:g.218458480G>A');
  assert.equal(e.rsid, 'rs58991260');
  assert.equal(e.assembly, 'hg38');

  const url = calls.find((c) => c.url.includes('/variant/'))?.url ?? '';
  assert.ok(url.includes('/variant/chr1:g.218458480G%3EA'), `路径须为 chr1:g.218458480G%3EA（实际 ${url}）`);
  assert.ok(!url.includes('%3A'), '冒号按 design 约定保留原文，不编码为 %3A');
  assert.equal(new URL(url).searchParams.get('assembly'), 'hg38');
});

// ---------- variant_get 404 → not_found 信封（组装偏移提示，不算工具失败） ----------

test('variant_get: 上游 404 → not_found 信封 + 组装偏移提示', async (t) => {
  const original = globalThis.fetch;
  mockFetch(variantRoute(() => new Response('not found', { status: 404 })));
  t.after(() => { globalThis.fetch = original; });
  const payload = (await getVariant({ variant_id: 'chr1:g.999999999A>T', assembly: 'hg38' })) as { success: boolean; data: VariantData };
  assert.equal(payload.success, true);
  assert.equal(payload.data.empty, true);
  assert.equal(payload.data.not_found, true);
  assert.match(payload.data.note ?? '', /在 hg38 集合不存在/);
  assert.match(payload.data.note ?? '', /hg19 与 hg38 的坐标不同/);
});

// ---------- region 检索：区间语法与防御性校验 ----------

test('searchVariants: region 区间检索——q=chr:start-end 语法 + 过宽/倒置区间拒绝', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(variantRoute(() => new Response(JSON.stringify({ hits: [] }), { status: 200 })));
  t.after(() => { globalThis.fetch = original; });

  const payload = (await searchVariants({
    region: { chromosome: '7', start: 140453100, end: 140453200 }, assembly: 'hg38',
  })) as { data: VariantData };
  const q = new URL(calls[calls.length - 1].url).searchParams.get('q') ?? '';
  assert.equal(q, 'chr7:140453100-140453200', 'region 转区间查询语法');
  assert.equal(payload.data.empty, true, '空区间如实返回 not_found 信封');
  assert.match(payload.data.note ?? '', /chr7:140453100-140453200/);

  await assert.rejects(
    searchVariants({ region: { chromosome: '7', start: 140453200, end: 140453100 }, assembly: 'hg38' }),
    /区间不合法：start（140453200）大于 end（140453100）/,
  );
  await assert.rejects(
    searchVariants({ region: { chromosome: '7', start: 1, end: 6_000_000 }, assembly: 'hg38' }),
    /区间过宽.*上限 5,000,000 bp/,
  );
  await assert.rejects(
    searchVariants({ region: { chromosome: 'chr7', start: 1, end: 100 }, assembly: 'hg38' }),
    /染色体格式不正确.*1-22、X、Y、M 或 MT/,
  );
});

// ---------- 卡片投影（biomed/index.ts，assembly 必带） ----------

test('extractBiomedCards: variant 信封 → meta.source=variant 卡片（assembly 徽章数据必带）', async (t) => {
  const original = globalThis.fetch;
  mockFetch(variantRoute((url) =>
    (new URL(url).searchParams.get('assembly') ?? '') === 'hg38'
      ? new Response(fixture('myvariant-rs58991260-hg38'), { status: 200 })
      : new Response('{}', { status: 200 }),
  ));
  t.after(() => { globalThis.fetch = original; });
  const payload = await searchVariants({ variant: 'rs58991260', assembly: 'hg38' });
  const cards = extractBiomedCards('variant_search', payload) as {
    tool: string; accession: string; title: string; meta: Record<string, string>;
  }[];
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.tool, 'variant_search');
  assert.equal(c.accession, 'rs58991260', 'accession 优先 rsID 小写规范形');
  assert.equal(c.title, 'chr1:g.218458480G>A（rs58991260）');
  assert.equal(c.meta.source, 'variant');
  assert.equal(c.meta.assembly, 'hg38', 'assembly 是变异卡片必带字段（前端徽章）');
  assert.equal(c.meta.rsid, 'rs58991260');
  assert.ok(c.meta.url?.includes('ncbi.nlm.nih.gov/snp/rs58991260'));
  assert.match(c.meta.sources_summary, /dbSNP ✓/);
});