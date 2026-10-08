// intent（检索意图 IR）黄金用例测试（离线，纯函数，不打 LLM、不联网）
//
// 意图翻译此前完全委托提示词隐式行为，无中间 schema、无落盘、无校验。
// intent.ts 把「用户问题 → ResearchIntent」落成显式 IR：parseResearchIntent 校验+归一化
// （organism 中文学名映射、assay→library_strategy 词表），判别联合 ok:false 供调用方降级。
// 本文件断言 IR 结构与归一化结果而非模型原文，保证意图层可回归。
//
// 运行：npm test（已随根目录测试套件执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTENT_TARGETS,
  normalizeOrganism,
  normalizeAssay,
  parseResearchIntent,
} from '../intent.ts';

// ---------- normalizeOrganism：中文学名归一化映射表 + 二名法形 ----------

test('normalizeOrganism: 常见中文学名归一化为二名法学名', () => {
  const cases: [string, string][] = [
    ['小鼠', 'Mus musculus'],
    ['人', 'Homo sapiens'],
    ['大鼠', 'Rattus norvegicus'],
    ['斑马鱼', 'Danio rerio'],
    ['果蝇', 'Drosophila melanogaster'],
    ['拟南芥', 'Arabidopsis thaliana'],
  ];
  for (const [input, expected] of cases) {
    const r = normalizeOrganism(input);
    assert.ok(r.ok, `${input} 应归一化成功`);
    assert.equal(r.value, expected);
  }
});

test('normalizeOrganism: 学名原样通过且与中文名归一一致（小鼠 ≡ Mus musculus）', () => {
  const fromChinese = normalizeOrganism('小鼠');
  const fromLatin = normalizeOrganism('Mus musculus');
  assert.ok(fromChinese.ok && fromLatin.ok);
  assert.equal(fromChinese.value, fromLatin.value);
  // 大小写修正：mus musculus → Mus musculus
  const fixed = normalizeOrganism('mus musculus');
  assert.ok(fixed.ok);
  assert.equal(fixed.value, 'Mus musculus');
});

test('normalizeOrganism: 非法 organism 拒绝而非猜值', () => {
  for (const bad of ['老鼠药', 'not a species!!', '???', '']) {
    const r = normalizeOrganism(bad);
    assert.ok(!r.ok, `「${bad}」应被拒绝`);
  }
});

// ---------- normalizeAssay：别名 → library_strategy 词表 ----------

test('normalizeAssay: 中英文别名映射到 library_strategy 规范值', () => {
  const cases: [string, string][] = [
    ['单细胞', 'scRNA-Seq'],
    ['scRNA-seq', 'scRNA-Seq'],
    ['single cell', 'scRNA-Seq'],
    ['转录组', 'RNA-Seq'],
    ['ATAC', 'ATAC-Seq'],
    ['ChIP-seq', 'ChIP-Seq'],
    ['全基因组', 'WGS'],
    ['宏基因组', 'Metagenomic'],
  ];
  for (const [input, expected] of cases) {
    const r = normalizeAssay(input);
    assert.ok(r.ok, `${input} 应归一化成功`);
    assert.equal(r.value, expected);
  }
});

test('normalizeAssay: 未知 assay 拒绝而非直传', () => {
  const r = normalizeAssay('蛋白质组学');
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.reason, /词表/);
});

// ---------- parseResearchIntent：整体校验与降级路径 ----------

/** 黄金用例：肿瘤免疫治疗相关的单细胞数据 → assay=scRNA-seq 且 needs_literature=true */
test('parseResearchIntent: 单细胞+文献意图的完整 IR', () => {
  const r = parseResearchIntent({
    question: '肿瘤免疫治疗相关的单细胞数据',
    targets: ['geo', 'literature'],
    filters: { assay: '单细胞', condition: '肿瘤免疫治疗' },
    needs_literature: true,
  });
  assert.ok(r.ok, `应校验通过：${r.ok === false ? r.reason : ''}`);
  if (!r.ok) return;
  assert.equal(r.intent.question, '肿瘤免疫治疗相关的单细胞数据');
  assert.deepEqual(r.intent.targets, ['geo', 'literature']);
  assert.equal(r.intent.filters.assay, 'scRNA-Seq');
  assert.equal(r.intent.filters.condition, '肿瘤免疫治疗');
  assert.equal(r.intent.needs_literature, true);
  // 别名归一化应留审计痕迹
  assert.ok(r.notes.some((n) => n.includes('scRNA-Seq')));
});

test('parseResearchIntent: 空 filters 合法，缺省 filters 也合法', () => {
  const a = parseResearchIntent({ question: '肺癌数据', targets: ['geo'], filters: {}, needs_literature: false });
  assert.ok(a.ok);
  if (a.ok) assert.deepEqual(a.intent.filters, {});
  const b = parseResearchIntent({ question: '肺癌数据', targets: ['geo'], needs_literature: false });
  assert.ok(b.ok);
  if (b.ok) assert.deepEqual(b.intent.filters, {});
});

test('parseResearchIntent: 非法 organism / 未知 assay 整体判负（调用方据此降级）', () => {
  const base = { question: 'q', targets: ['geo'], needs_literature: false };
  const badOrganism = parseResearchIntent({ ...base, filters: { organism: '老鼠药' } });
  assert.ok(!badOrganism.ok);
  if (!badOrganism.ok) assert.match(badOrganism.reason, /organism/);
  const badAssay = parseResearchIntent({ ...base, filters: { assay: '质谱流式' } });
  assert.ok(!badAssay.ok);
  if (!badAssay.ok) assert.match(badAssay.reason, /assay/);
});

test('parseResearchIntent: has_control 仅接受真布尔', () => {
  const base = { question: 'q', targets: ['geo'], needs_literature: false };
  for (const bad of ['true', 1, 'yes']) {
    const r = parseResearchIntent({ ...base, filters: { has_control: bad } });
    assert.ok(!r.ok, `has_control=${JSON.stringify(bad)} 应被拒绝`);
  }
  const good = parseResearchIntent({ ...base, filters: { has_control: true } });
  assert.ok(good.ok);
  if (good.ok) assert.equal(good.intent.filters.has_control, true);
});

test('parseResearchIntent: targets 必须是非空已知目标数组', () => {
  const base = { question: 'q', needs_literature: false };
  assert.ok(!parseResearchIntent({ ...base, targets: [] }).ok);
  assert.ok(!parseResearchIntent({ ...base, targets: ['pubmed'] }).ok, '未知目标 pubmed 应拒绝');
  assert.ok(!parseResearchIntent({ ...base }).ok, '缺 targets 应拒绝');
  // 全量合法目标 + 去重
  const all = parseResearchIntent({ ...base, targets: ['geo', 'geo', 'sra', 'ngdc'], needs_literature: false });
  assert.ok(all.ok);
  if (all.ok) assert.deepEqual(all.intent.targets, ['geo', 'sra', 'ngdc']);
  assert.deepEqual([...INTENT_TARGETS], ['geo', 'sra', 'ena', 'ngdc', 'literature']);
});

test('parseResearchIntent: 缺 question / 非对象输入判负', () => {
  assert.ok(!parseResearchIntent(null).ok);
  assert.ok(!parseResearchIntent('字符串').ok);
  assert.ok(!parseResearchIntent({ targets: ['geo'], needs_literature: false }).ok);
  assert.ok(!parseResearchIntent({ question: '  ', targets: ['geo'], needs_literature: false }).ok);
});

test('parseResearchIntent: needs_literature 必须是布尔；targets 含 literature 时强制一致', () => {
  const notBool = parseResearchIntent({ question: 'q', targets: ['geo'], needs_literature: 'yes' });
  assert.ok(!notBool.ok);
  // 一致性修正：targets 含 literature 但 needs_literature=false → 归一为 true 并记 note，不判负
  const fixed = parseResearchIntent({ question: 'q', targets: ['literature'], needs_literature: false });
  assert.ok(fixed.ok);
  if (fixed.ok) {
    assert.equal(fixed.intent.needs_literature, true);
    assert.ok(fixed.notes.some((n) => n.includes('needs_literature')));
  }
});

test('parseResearchIntent: tissue_or_celltype / condition 自由文本透传（trim，无词表校验）', () => {
  const r = parseResearchIntent({
    question: 'q',
    targets: ['sra'],
    filters: { tissue_or_celltype: '  CD8+ T 细胞 ', condition: ' 非小细胞肺癌 ' },
    needs_literature: false,
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.intent.filters.tissue_or_celltype, 'CD8+ T 细胞');
    assert.equal(r.intent.filters.condition, '非小细胞肺癌');
  }
});
