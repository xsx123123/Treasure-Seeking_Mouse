#!/usr/bin/env node
// init.mjs：模板初始化脚本（零第三方依赖，Node >= 18）。
//
// 用法：
//   node init.mjs                                    # 交互问答
//   node init.mjs --name 显示名 --slug 短标识 --agent Agent名 --domain 领域名 --lang zh --yes
//   node init.mjs --check                            # 只扫描输出占位符报告，不写入
//   node init.mjs --help
//
// 语义：
// - 幂等：目录中已无占位符时输出「已初始化」并以退出码 2 结束（零写操作）；
// - 替换：纯文本级替换占位符记号（「双花括号 + 大写下划线」形式）→ 值；只处理文本文件白名单，排除 node_modules 与 fixtures/*.gz；
// - 报告：成功项（占位符 × 文件 × 处数）/ 未识别占位符（定位文件:行，提示登记）/ 遗漏项三段；
// - 退出码：0=全成功 / 1=存在未识别残留 / 2=已初始化（无可替换项）。
// - 登记纪律：内置占位符映射表与 README「占位符总清单」同源——新增占位符必须同步两处 + 文档登记。

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- 占位符登记表（与 README 占位符总清单同源） ----------
const PLACEHOLDERS = [
  { name: 'PROJECT_NAME', meaning: '项目显示名（README 标题 / index.html title / i18n 应用名 / 提示词角色）', ask: '项目显示名（如：法律文书助手）' },
  { name: 'PROJECT_SLUG', meaning: '短标识 kebab-case（package name / localStorage 键前缀 / 日志前缀 / 镜像名）', ask: '项目短标识 kebab-case（如：legal-doc-agent）', normalize: (v) => String(v).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') },
  { name: 'AGENT_NAME', meaning: 'Agent 人格名（提示词自称 / 界面助手名）', ask: 'Agent 名称（如：小法）' },
  { name: 'DOMAIN', meaning: '领域名（提示词与文档中的领域表述）', ask: '领域名称（如：法律文书检索）' },
  { name: 'DEFAULT_LANG', meaning: '默认界面语言（zh / en）', ask: '默认界面语言 zh 或 en（默认 zh）', normalize: (v) => (String(v).toLowerCase().startsWith('en') ? 'en' : 'zh') },
];

const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;

// ---------- 文件遍历（文本白名单；排除 node_modules / fixtures / dist） ----------
const TEXT_EXT = /\.(md|json|html|css|ts|tsx|mjs|js|conf|py|example)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'fixtures', '.git', 'data']);

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const file = join(dir, name);
    const st = statSync(file);
    if (st.isDirectory()) { walkFiles(file, out); continue; }
    if (!TEXT_EXT.test(name) && !name.includes('Makefile') && !name.startsWith('.env')) continue;
    if (name.endsWith('.gz')) continue;
    out.push(file);
  }
  return out;
}

/** 全目录扫描：返回 [{file, line, mark}]（行级定位） */
function scanPlaceholders(files) {
  const hits = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(PLACEHOLDER_RE)) {
        hits.push({ file: file.slice(HERE.length + 1), line: i + 1, mark: m[0] });
      }
    });
  }
  return hits;
}

// ---------- CLI 入参解析 ----------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--check') args.check = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

const HELP = `模板初始化（Agent 项目模板）

用法：
  node init.mjs [--name <显示名>] [--slug <短标识>] [--agent <Agent名>] [--domain <领域名>] [--lang zh|en] [--yes]
  node init.mjs --check        只扫描输出占位符报告，不写入
  node init.mjs --help

占位符清单（与 README「占位符总清单」同源）：
${PLACEHOLDERS.map((p) => `  {{${p.name}}}  ${p.meaning}`).join('\n')}`;

async function ask(question, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => {
    rl.question(`${question}${fallback ? `（默认 ${fallback}）` : ''}: `, (a) => res(a.trim()));
  });
  rl.close();
  return answer || fallback || '';
}

// ---------- CLI 参数名 → 占位符名映射 ----------
const CLI_MAP = { name: 'PROJECT_NAME', slug: 'PROJECT_SLUG', agent: 'AGENT_NAME', domain: 'DOMAIN', lang: 'DEFAULT_LANG' };

// ---------- 主流程 ----------
const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const files = walkFiles(HERE);
const hits = scanPlaceholders(files);
const known = new Set(PLACEHOLDERS.map((p) => `{{${p.name}}}`));
const unknownMarks = [...new Set(hits.filter((h) => !known.has(h.mark)).map((h) => h.mark))];

// 幂等检测：零命中且 package.json 无占位 name → 已初始化
const pkgPath = join(HERE, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const alreadyInit = hits.length === 0 && !String(pkg.name || '').startsWith('{{');

if (alreadyInit) {
  console.log('✅ 模板已初始化：未发现可替换的占位符（零写操作）。');
  process.exit(2);
}

// --check 模式：只输出报告
if (args.check) {
  console.log(`占位符扫描报告（${hits.length} 处命中，${files.length} 个文本文件）：\n`);
  const byMark = new Map();
  for (const h of hits) {
    if (!byMark.has(h.mark)) byMark.set(h.mark, []);
    byMark.get(h.mark).push(`${h.file}:${h.line}`);
  }
  for (const [mark, locs] of byMark) {
    const knownMark = known.has(mark);
    console.log(`${knownMark ? '✓' : '⚠️'} ${mark}（${locs.length} 处）${knownMark ? '' : ' —— 未在登记表中，需在 init.mjs 与 README 清单同步登记'}`);
    for (const loc of locs.slice(0, 20)) console.log(`    ${loc}`);
    if (locs.length > 20) console.log(`    … 另 ${locs.length - 20} 处`);
  }
  process.exit(unknownMarks.length > 0 ? 1 : 0);
}

// 收集替换值：CLI 参数优先（经 CLI_MAP 显式映射），缺项问答补齐（--yes 时用建议默认值兜底）
console.log('Agent 项目模板 · 初始化\n');
const values = {};
for (const p of PLACEHOLDERS) {
  const cliName = Object.keys(CLI_MAP).find((k) => CLI_MAP[k] === p.name);
  let v = cliName && typeof args[cliName] === 'string' ? args[cliName] : '';
  if (!v && !args.yes) v = await ask(p.ask, p.name === 'DEFAULT_LANG' ? 'zh' : '');
  if (!v) v = p.name === 'PROJECT_NAME' ? 'My Agent' : p.name === 'PROJECT_SLUG' ? 'my-agent' : p.name === 'AGENT_NAME' ? '小助手' : p.name === 'DOMAIN' ? '通用检索' : 'zh';
  values[p.name] = p.normalize ? p.normalize(v) : v;
}

console.log('\n替换值：');
for (const [k, v] of Object.entries(values)) console.log(`  {{${k}}} → ${v}`);

// ---------- 替换执行 ----------
let totalReplaced = 0;
const perFile = [];
for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  let count = 0;
  for (const [name, value] of Object.entries(values)) {
    const mark = `{{${name}}}`;
    if (!text.includes(mark)) continue;
    count += text.split(mark).length - 1;
    text = text.split(mark).join(value);
  }
  if (count > 0) {
    writeFileSync(file, text);
    totalReplaced += count;
    perFile.push({ file: file.slice(HERE.length + 1), count });
  }
}

// package.json 标识更新：name 已替换，version 归 0.1.0
{
  const pkgText = readFileSync(pkgPath, 'utf8');
  const pkgObj = JSON.parse(pkgText);
  pkgObj.version = '0.1.0';
  writeFileSync(pkgPath, JSON.stringify(pkgObj, null, 2) + '\n');
}

// ---------- 三段报告 ----------
console.log('\n━━━ 替换报告 ━━━');
console.log(`✅ 成功替换：${totalReplaced} 处（${perFile.length} 个文件）`);
for (const { file, count } of perFile) console.log(`    ${file} × ${count}`);

// 未识别占位符（替换后仍残留的 {{...}} 记号）
const postHits = scanPlaceholders(files).filter((h) => !known.has(h.mark));
if (postHits.length > 0) {
  console.log(`\n⚠️ 未识别占位符（${postHits.length} 处，需在 init.mjs 的 PLACEHOLDERS 与 README 清单登记后手工处理）：`);
  for (const h of postHits.slice(0, 20)) console.log(`    ${h.file}:${h.line}  ${h.mark}`);
}

// 遗漏项：登记表中有、目录中未出现的占位符（可能被手工删除）
const appeared = new Set(hits.map((h) => h.mark));
const missed = PLACEHOLDERS.filter((p) => !appeared.has(`{{${p.name}}}`));
if (missed.length > 0) {
  console.log(`\nℹ️ 登记表中未出现的占位符（${missed.length} 项，可能已被手工替换或删除）：`);
  for (const p of missed) console.log(`    {{${p.name}}}`);
}

console.log('\n━━━ 下一步（最小启动路径）━━━');
console.log('  cp server/.env.example server/.env   # 并填入 LLM_API_KEY');
console.log('  npm install');
console.log('  npm run server                       # 对话服务 :8787');
console.log('  npm run dev                          # 前端 :3015');
console.log('');

process.exit(postHits.length > 0 ? 1 : 0);