// gene_search / gene_get（MyGene 适配器）回归测试（离线，mock fetch + fixtures）
//
// 覆盖 design 2.6 表格七类用例：
// ① 单词检索双标识保留；② 多词批量映射保真（输出项数=输入项数）；③ species 缺失零 fetch；
// ④ 上游 429 退避耗尽（「暂时不可用」而非「未找到」）；⑤ 上游 404 → not_found 信封；
// ⑥ trimForLLM 截断标记；⑦ metadata 24h 缓存命中。
// 黄金值来自真实上游响应（fixtures 抓取于 2026-10-18，勿随意修改期望值）。
//
// 运行：npm test（已随根目录测试套件执行；MyGene 不占 NCBI token bucket，无测试间限流）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { searchGenes, getGene, cleanGeneTerm } from '../biomed/gene.ts';
import { extractBiomedCards } from '../biomed/index.ts';
import { trimForLLM } from '../index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'biomed');

function fixture(name: string): string {
  return gunzipSync(readFileSync(join(FIXTURES, `${name}.json.gz`))).toString('utf8');
}

interface FetchCall { url: string; method: string; body?: string }

/** 替换全局 fetch：记录 URL/方法/请求体并按路由返回响应（调用方用 t.after 恢复） */
function mockFetch(route: (url: string) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    return route(url);
  }) as typeof fetch;
  return calls;
}

interface GeneMatch {
  symbol: string; taxid: string; species?: string; entrez_gene_id: string;
  ensembl_gene_id?: string; uniprot_ids?: string[]; name?: string;
  summary?: string; genomic_pos?: { chr: string; start: number; end: number }; hgnc_id?: string;
}
interface GeneData {
  results: { query: string; not_found: boolean; matches: GeneMatch[] }[];
  total: number; source: string; build_version: string;
  empty?: boolean; not_found?: boolean; note?: string;
}

// ---------- ⑦ metadata 24h 缓存（放最前：首跳落缓存后，后续用例零 /metadata 请求） ----------

test('searchGenes: build_version 元数据缓存——第二次调用不再请求 /metadata', async (t) => {
  const original = globalThis.fetch;
  let metadataCalls = 0;
  const calls = mockFetch((url) => {
    if (url.includes('/metadata')) {
      metadataCalls++;
      return new Response(fixture('mygene-metadata'), { status: 200 });
    }
    return new Response(fixture('mygene-cdk2'), { status: 200 });
  });
  t.after(() => { globalThis.fetch = original; });
  const a = (await searchGenes({ queries: ['CDK2'], species: 'human' })) as { data: GeneData };
  const b = (await searchGenes({ queries: ['CDK2'], species: 'human' })) as { data: GeneData };
  assert.equal(metadataCalls, 1, '第二次调用应命中模块级缓存，不再请求 /metadata');
  assert.equal(a.data.build_version, '20260922');
  assert.equal(b.data.build_version, '20260922');
  assert.ok(calls.length >= 3, '两次检索各请求一次 /query，/metadata 只请求一次');
});

// ---------- ① 单词检索：GET 模糊查询 + 双标识保留 + 二名法→taxid 上行翻译 ----------

test('searchGenes: 单词检索断言双标识（Entrez 1017 + Ensembl ENSG00000123374）保留', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch((url) =>
    url.includes('/metadata')
      ? new Response(fixture('mygene-metadata'), { status: 200 })
      : new Response(fixture('mygene-cdk2'), { status: 200 }),
  );
  t.after(() => { globalThis.fetch = original; });

  const payload = (await searchGenes({ queries: ['CDK2'], species: 'Homo sapiens' })) as { data: GeneData };
  const { results, total, source } = payload.data;
  assert.equal(source, 'mygene');
  assert.ok(total >= 1, 'fixture（真实响应）命中 total=16');
  assert.equal(results.length, 1);
  assert.equal(results[0].query, 'CDK2');
  assert.equal(results[0].not_found, false);

  const m = results[0].matches[0];
  assert.equal(m.symbol, 'CDK2');
  assert.equal(m.name, 'cyclin dependent kinase 2');
  assert.equal(m.entrez_gene_id, '1017', 'Entrez 双标识之一');
  assert.equal(m.ensembl_gene_id, 'ENSG00000123374', 'Ensembl 双标识之二');
  assert.equal(m.taxid, '9606');
  assert.equal(m.species, 'Homo sapiens', 'taxid → 二名法学名回填');
  assert.deepEqual(m.uniprot_ids, ['P24941']);

  // 上行翻译断言：二名法学名（intent_plan 归一化产物形态）→ taxid 再传上游
  const queryCall = calls.find((c) => c.method === 'GET' && c.url.includes('/query'));
  assert.ok(queryCall, '单词检索应走 GET /query');
  const params = new URL(queryCall.url).searchParams;
  assert.equal(params.get('q'), 'CDK2');
  assert.equal(params.get('species'), '9606', 'Homo sapiens 应本地翻译为 taxid=9606 上行');
  assert.ok((params.get('fields') ?? '').includes('entrezgene'));
});

// ---------- ② 多词批量映射：POST 表单 + 输出项数=输入项数 + notfound 逐项标注 ----------

test('searchGenes: 混合批量映射——3 查询 3 输出，无效符号逐项标注 not_found', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch((url) =>
    url.includes('/metadata')
      ? new Response(fixture('mygene-metadata'), { status: 200 })
      : new Response(fixture('mygene-batch'), { status: 200 }),
  );
  t.after(() => { globalThis.fetch = original; });

  const payload = (await searchGenes({
    queries: ['CDK2', 'TP53', 'XYZNOTAGENE'], species: '9606',
  })) as { data: GeneData };
  const { results, total } = payload.data;

  // 批量保真（spec 5.2.1 规则 4）：输出项数 = 输入项数，绝不吞项
  assert.equal(results.length, 3, '输出项数必须等于输入项数');
  assert.equal(results[0].query, 'CDK2');
  assert.equal(results[0].matches[0].entrez_gene_id, '1017');
  assert.equal(results[0].matches[0].ensembl_gene_id, 'ENSG00000123374');
  assert.equal(results[1].query, 'TP53');
  assert.equal(results[1].matches[0].entrez_gene_id, '7157');
  assert.equal(results[2].query, 'XYZNOTAGENE');
  assert.equal(results[2].not_found, true, '无效符号逐项标注 not_found');
  assert.deepEqual(results[2].matches, []);
  assert.equal(total, 2, 'total 只计真实命中');

  // 上行形态断言：多词走 POST 表单批量映射
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/query'));
  assert.ok(post, '多词检索应走 POST /query');
  assert.ok(post.body?.includes('q=CDK2%2CTP53%2CXYZNOTAGENE'), '查询词以逗号连接提交');
  assert.ok(post.body?.includes('species=9606'));
  assert.ok(post.body?.includes('scopes=symbol'));
});

// ---------- ③ species 缺失：服务端兜底拒绝，零 fetch ----------

test('searchGenes: species 缺失抛错（消息含「必须指定物种」）且 mock fetch 零调用', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('{}', { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(
    searchGenes({ queries: ['CDK2'], species: undefined }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /必须指定物种/);
      assert.match(msg, /不得默认人类/, '服务端兜底须引导反问而非默认人类');
      return true;
    },
  );
  assert.equal(calls.length, 0, '参数校验失败不得发起任何上游请求');
});

// ---------- ④ 上游 429：退避耗尽 → 「暂时不可用」而非「未找到」 ----------

test('searchGenes: 上游 429 三连退避耗尽——错误含「暂时不可用」且不含「未找到」', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch(() => new Response('rate limited', { status: 429 }));
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(
    searchGenes({ queries: ['CDK2'], species: 'human' }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /暂时不可用/);
      assert.ok(!msg.includes('未找到'), '上游故障绝不能表述为「未找到记录」（spec 4.2.2 红线）');
      return true;
    },
  );
  assert.equal(calls.length, 3, 'retries=2 → 共 3 次尝试（1s/2s 退避）');
});

// ---------- 400：物种不被上游识别（使用者可修正的错误，两不误伤） ----------

test('searchGenes: 物种不被 MyGene 识别（HTTP 400）——引导改用 taxid，不算未找到', async (t) => {
  const original = globalThis.fetch;
  mockFetch((url) =>
    url.includes('/metadata')
      ? new Response(fixture('mygene-metadata'), { status: 200 })
      : new Response(fixture('mygene-species-400'), { status: 400 }),
  );
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(
    searchGenes({ queries: ['CDK2'], species: 'Foobarius baz' }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /不被 MyGene 识别/);
      assert.match(msg, /taxid/);
      assert.ok(!msg.includes('未找到'));
      return true;
    },
  );
});

// ---------- 200 + 非 JSON：按服务异常处理（bad-response.html fixture） ----------

test('searchGenes: 上游 200 返回 HTML 错误页——按「非预期的响应格式」处理', async (t) => {
  const original = globalThis.fetch;
  mockFetch(() => new Response(gunzipSync(readFileSync(join(FIXTURES, 'bad-response.html.gz'))).toString('utf8'), { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(
    searchGenes({ queries: ['CDK2'], species: 'human' }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /非预期的响应格式/);
      assert.ok(!msg.includes('未找到'));
      return true;
    },
  );
});

// ---------- ⑤ gene_get 上游 404 → not_found 信封（empty 标记，不算工具失败） ----------

test('getGene: 上游 404 → not_found 信封 + empty 标记 + 修正建议', async (t) => {
  const original = globalThis.fetch;
  const calls = mockFetch((url) =>
    url.includes('/metadata')
      ? new Response(fixture('mygene-metadata'), { status: 200 })
      : new Response(JSON.stringify({ success: false, error: 'Not Found.' }), { status: 404 }),
  );
  t.after(() => { globalThis.fetch = original; });
  const payload = (await getGene({ gene_id: '999999999' })) as { success: boolean; data: GeneData };
  assert.equal(payload.success, true, '未收录是合法空结果而非工具失败');
  assert.equal(payload.data.empty, true);
  assert.equal(payload.data.not_found, true);
  assert.deepEqual(payload.data.results, []);
  assert.match(payload.data.note ?? '', /未收录基因 ID「999999999」/);
  assert.match(payload.data.note ?? '', /gene_search/);
  assert.ok(calls.some((c) => c.url.includes('/gene/999999999')));
});

// ---------- gene_get 详情字段 + 物种不匹配警告 ----------

test('getGene: 详情字段（summary/genomic_pos/HGNC）与物种不匹配、聚合坐标提示', async (t) => {
  const original = globalThis.fetch;
  mockFetch((url) =>
    url.includes('/metadata')
      ? new Response(fixture('mygene-metadata'), { status: 200 })
      : new Response(fixture('mygene-1017'), { status: 200 }),
  );
  t.after(() => { globalThis.fetch = original; });
  const payload = (await getGene({ gene_id: '1017', species: '10090' })) as { data: GeneData };
  const g = payload.data.results[0];
  assert.equal(g.symbol, 'CDK2');
  assert.equal(g.entrez_gene_id, '1017');
  assert.ok((g.summary ?? '').length > 50, '详情应含功能摘要');
  assert.equal(g.genomic_pos?.chr, '12');
  assert.equal(g.hgnc_id, '1771');
  const note = payload.data.note ?? '';
  assert.match(note, /不匹配/, '传入物种（10090 小鼠）与条目（9606 人类）应告警');
  assert.match(note, /聚合/, 'MyGene 聚合坐标应附组装版本确认提示');
});

// ---------- 查询词清洗（纯函数） ----------

test('cleanGeneTerm: 逗号/冒号/纯符号/超长拒绝，控制字符折叠', () => {
  assert.equal(cleanGeneTerm('  CDK2 \n '), 'CDK2');
  assert.throws(() => cleanGeneTerm('CDK2,TP53'), /逗号或冒号/);
  assert.throws(() => cleanGeneTerm('symbol:CDK2'), /逗号或冒号/);
  assert.throws(() => cleanGeneTerm('!!!???'), /不含任何字母或数字/);
  assert.throws(() => cleanGeneTerm(''), /为空/);
  assert.throws(() => cleanGeneTerm('x'.repeat(101)), /过长/);
});

// ---------- ⑥ trimForLLM：超限结果的截断标记（index.ts 导出的纯函数） ----------

test('trimForLLM: 超过 100000 字符的批量结果截断到 10 条并打 truncated 标记', () => {
  // 100 词批量检索的极端形态：results 30 项、每项顶层 summary 4000 字（trimForLLM 的 summary 截断作用于项级）
  const big = {
    success: true,
    data: {
      results: Array.from({ length: 30 }, (_, i) => ({ symbol: `GENE${i}`, summary: 'x'.repeat(4000) })),
      total: 30, source: 'mygene', build_version: '20260922',
    },
  };
  const raw = JSON.stringify(big);
  assert.ok(raw.length > 100000, `前置：构造载荷应超限（实际 ${raw.length}）`);
  const trimmed = JSON.parse(trimForLLM(big as Parameters<typeof trimForLLM>[0])) as {
    data: { results: { summary: string }[]; truncated: boolean };
  };
  assert.equal(trimmed.data.results.length, 10, '结果集截断到 10 条');
  assert.equal(trimmed.data.truncated, true, '必须打 truncated:true 标记');
  const s = trimmed.data.results[0].summary;
  assert.ok(s.length === 401 && s.endsWith('…'), `summary 截断到 400 字 + 省略号（实际 ${s.length}）`);
  // 未超限载荷原样透传，不注入截断标记
  const small = { success: true, data: { results: [{ a: 1 }] } };
  const out = trimForLLM(small as Parameters<typeof trimForLLM>[0]);
  assert.equal(out, JSON.stringify(small));
  assert.ok(!out.includes('truncated'));
});

// ---------- 卡片投影（biomed/index.ts，4.1 接入的卡片约定） ----------

test('extractBiomedCards: gene_search 信封 → meta.source=gene 双标识卡片', async (t) => {
  const original = globalThis.fetch;
  mockFetch((url) =>
    url.includes('/metadata')
      ? new Response(fixture('mygene-metadata'), { status: 200 })
      : new Response(fixture('mygene-batch'), { status: 200 }),
  );
  t.after(() => { globalThis.fetch = original; });
  const payload = await searchGenes({ queries: ['CDK2', 'TP53', 'XYZNOTAGENE'], species: '9606' });
  const cards = extractBiomedCards('gene_search', payload) as {
    tool: string; accession: string; title: string; meta: Record<string, string>;
  }[];
  assert.equal(cards.length, 2, 'not_found 查询不产卡片');
  assert.equal(cards[0].tool, 'gene_search');
  assert.equal(cards[0].accession, '1017', 'accession 优先 Entrez ID');
  assert.equal(cards[0].title, 'CDK2 — cyclin dependent kinase 2');
  assert.equal(cards[0].meta.source, 'gene');
  assert.equal(cards[0].meta.entrez_gene_id, '1017');
  assert.equal(cards[0].meta.ensembl_gene_id, 'ENSG00000123374');
  assert.equal(cards[0].meta.species, 'Homo sapiens');
  assert.equal(cards[0].meta.uniprot_id, 'P24941');
  assert.ok(cards[0].meta.url?.includes('mygene.info/v3/gene/1017'));
  assert.equal(cards[1].accession, '7157');
});