// validateSearchQuery（检索词格式层校验）+ CHAT_SHARED_SECRET 启动告警 回归测试（离线）
//
// 背景：NGDC 5 工具有完整入参正则，而 seqout 检索工具与 literature_search 对 query 零校验，
// 模型传入空串/超长整段文字/纯符号会直接打到上游。修复：统一入口 validateSearchQuery
// （长度 1-500、剔除控制字符、拒绝纯符号串），失败抛带改写指引的错误，经 {success:false,error} 回灌。
// 另：CHAT_SHARED_SECRET 未配置时对话接口无鉴权，启动时必须打印醒目警告（不默认拒绝，兼容熟人部署）。
//
// 运行：npm test（已随根目录测试套件执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSearchQuery } from '../index.ts';


test('validateSearchQuery: 正常检索词原样通过（中英/带连字符/自动 trim）', () => {
  assert.equal(validateSearchQuery('lung adenocarcinoma'), 'lung adenocarcinoma');
  assert.equal(validateSearchQuery('  阿尔茨海默病 RNA-seq  '), '阿尔茨海默病 RNA-seq');
  assert.equal(validateSearchQuery('TP53[Gene Name] AND human[Organism]'), 'TP53[Gene Name] AND human[Organism]');
  assert.equal(validateSearchQuery('GSE151530'), 'GSE151530'); // 纯编号也是合法检索词
});

test('validateSearchQuery: 控制字符剔除为空格并折叠', () => {
  assert.equal(validateSearchQuery('lung\u0000cancer'), 'lung cancer');
  assert.equal(validateSearchQuery('a\u0001b\u007fc'), 'a b c');
});

test('validateSearchQuery: 空串/纯空白/纯控制字符拒绝，错误带改写指引', () => {
  for (const bad of ['', '   ', '\u0000\u0001'] as const) {
    assert.throws(() => validateSearchQuery(bad), /检索词为空.*重试/);
  }
});

test('validateSearchQuery: 超长（>500）拒绝并提示提炼关键词', () => {
  assert.throws(() => validateSearchQuery('a'.repeat(501)), /上限 500.*提炼/);
  assert.equal(validateSearchQuery('a'.repeat(500)).length, 500); // 边界值放行
});

test('validateSearchQuery: 纯符号串拒绝并给出关键词示例', () => {
  for (const bad of ['!!!???', '———……', '*** ###'] as const) {
    assert.throws(() => validateSearchQuery(bad), /不含任何字母或数字/);
  }
});

let bootCounter = 0;
async function bootFunction(secret?: string): Promise<string> {
  const previous = process.env.CHAT_SHARED_SECRET;
  const warn = console.warn;
  const warnings: string[] = [];
  try {
    if (secret === undefined) delete process.env.CHAT_SHARED_SECRET;
    else process.env.CHAT_SHARED_SECRET = secret;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    // Fresh module evaluation tests startup without a sandbox-forbidden spawnSync.
    await import(new URL(`../index.ts?startup-test=${++bootCounter}`, import.meta.url).href);
    return warnings.join('\n');
  } finally {
    console.warn = warn;
    if (previous === undefined) delete process.env.CHAT_SHARED_SECRET;
    else process.env.CHAT_SHARED_SECRET = previous;
  }
}

test('启动告警：未配置 CHAT_SHARED_SECRET 时打印醒目警告，配置后静默', async () => {
  const withoutSecret = await bootFunction();
  assert.match(withoutSecret, /CHAT_SHARED_SECRET/);
  assert.match(withoutSecret, /无鉴权/);
  const withSecret = await bootFunction('test-secret');
  assert.doesNotMatch(withSecret, /未配置 CHAT_SHARED_SECRET/);
});
