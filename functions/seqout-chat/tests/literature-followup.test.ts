// 数据集→文献自动补链（跨源联合编排）回归测试（离线，纯函数）
//
// 背景：主循环终态判断"cards 出现 GSE/PRJ 级数据集 + 有文献需求信号（intent_plan
// needs_literature=true 或用户原文含论文/文献/paper 类词）+ 模型本轮未调用过
// literature_search"时，平台自动补一次文献检索并入同一消息 cards 流。
// 模型仍是编排主体，这是兜底补链；本测试守住触发/不触发/防重三类边界。
//
// 运行：npm test（已随根目录测试套件执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardsContainStudy, needsLiteratureFollowup } from '../index.ts';

const GSE_CARD = { tool: 'seqout_search', accession: 'GSE117176', title: 'x', summary: '', meta: {} };
const PRJ_CARD = { tool: 'seqout_get_project_detail', accession: 'PRJNA481344', title: 'x', summary: '', meta: {} };
const LIT_CARD = { tool: 'literature_search', accession: '32015576', title: 'p', summary: '', meta: { source: 'literature', pmid: '32015576' } };
const RUN_CARD = { tool: 'seqout_get_runs', accession: 'SRR7526393', title: 'r', summary: '', meta: {} };

// ---------- cardsContainStudy ----------

test('cardsContainStudy: GSE/PRJNA/PRJCA 数据集卡片算，文献卡片与 run 级卡片不算', () => {
  assert.equal(cardsContainStudy([GSE_CARD]), true);
  assert.equal(cardsContainStudy([PRJ_CARD]), true);
  assert.equal(cardsContainStudy([{ ...PRJ_CARD, accession: 'PRJCA000437' }]), true);
  assert.equal(cardsContainStudy([LIT_CARD]), false, '文献卡片不算数据集');
  assert.equal(cardsContainStudy([RUN_CARD]), false, 'SRR run 级卡片不触发补链');
  assert.equal(cardsContainStudy([]), false);
  assert.equal(cardsContainStudy([GSE_CARD, LIT_CARD]), true, '混合卡片里有一个数据集即可');
});

// ---------- needsLiteratureFollowup：触发 / 不触发 / 防重 ----------

test('触发：数据集卡片 + intent_plan needs_literature=true', () => {
  assert.equal(
    needsLiteratureFollowup({ cards: [GSE_CARD], intentNeedsLiterature: true, userText: '帮我找小鼠肥胖相关的数据', literatureAlreadySearched: false }),
    true,
  );
});

test('触发：数据集卡片 + 用户原文含文献信号词（中英）', () => {
  for (const text of ['这个数据集有没有发表的论文？', 'find datasets and related papers', 'GSE117176 对应的文献', 'any publication using this data?']) {
    assert.equal(
      needsLiteratureFollowup({ cards: [GSE_CARD], intentNeedsLiterature: false, userText: text, literatureAlreadySearched: false }),
      true,
      `应触发：${text}`,
    );
  }
});

test('不触发：无文献需求信号 / 无数据集卡片', () => {
  assert.equal(
    needsLiteratureFollowup({ cards: [GSE_CARD], intentNeedsLiterature: false, userText: '帮我找小鼠肥胖相关的数据集', literatureAlreadySearched: false }),
    false,
    '没有文献信号时不补链',
  );
  assert.equal(
    needsLiteratureFollowup({ cards: [LIT_CARD], intentNeedsLiterature: true, userText: '查文献', literatureAlreadySearched: false }),
    false,
    '只有文献卡片（无数据集）时不补链',
  );
  assert.equal(
    needsLiteratureFollowup({ cards: [], intentNeedsLiterature: true, userText: '查论文', literatureAlreadySearched: false }),
    false,
  );
});

test('防重：模型本轮已调用过 literature_search → 绝不重复补链', () => {
  assert.equal(
    needsLiteratureFollowup({ cards: [GSE_CARD], intentNeedsLiterature: true, userText: '有没有相关论文', literatureAlreadySearched: true }),
    false,
  );
});
