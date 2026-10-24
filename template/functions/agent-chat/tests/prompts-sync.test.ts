// 提示词漂移守卫：prompts/system-{zh,en}.md 是唯一可编辑来源，改完必须 npm run sync:prompts
// 重新生成 prompts.generated.ts；本测试比对「md 内容」与「运行时实际导入的字符串」，不一致即红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SYSTEM_PROMPT, SYSTEM_PROMPT_EN } from '../prompts.generated.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const md = (name: string): string => readFileSync(join(HERE, '..', 'prompts', name), 'utf8').replace(/\n$/, '');

test('SYSTEM_PROMPT 与 prompts/system-zh.md 同步（改 md 后跑 npm run sync:prompts）', () => {
  assert.equal(SYSTEM_PROMPT, md('system-zh.md'));
});

test('SYSTEM_PROMPT_EN 与 prompts/system-en.md 同步（改 md 后跑 npm run sync:prompts）', () => {
  assert.equal(SYSTEM_PROMPT_EN, md('system-en.md'));
});

test('双份提示词的关键规则仍在（防误删整段）', () => {
  for (const [name, p] of [['zh', SYSTEM_PROMPT], ['en', SYSTEM_PROMPT_EN]] as const) {
    assert.match(p, /intent_plan/, `${name} 缺意图规划规则`);
    assert.match(p, /demo_cards/, `${name} 缺示例工具引用`);
    assert.match(p, /绝不编造|Never fabricate/, `${name} 缺真实性红线`);
    assert.match(p, /防玩坏红线|Anti-abuse red lines/, `${name} 缺防玩坏红线规则`);
  }
});

test('双语双份逐段平行（段落数一致）', () => {
  const zhSections = SYSTEM_PROMPT.split('\n\n').length;
  const enSections = SYSTEM_PROMPT_EN.split('\n\n').length;
  assert.equal(zhSections, enSections, `zh ${zhSections} 段 / en ${enSections} 段，双语段落须逐条平行`);
});