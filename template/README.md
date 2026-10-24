# Agent 项目模板（{{PROJECT_NAME}}）

> 一套可复用的 **Agent 项目模板**：LLM tool-calling 多轮循环 + SSE 流式对话 + 工具注册门 + 意图规划 + grounding 校验 + 会话记忆 + 自托管服务壳 + 最小前端骨架。
> 复制本目录 → `node init.mjs` → 填一个 LLM 密钥 → 几分钟内得到一个可运行的 Agent 应用。
>
> 模板版本：0.1.0 ｜ 抽取来源：Treasure-Seeking_Mouse 仓库（`functions/seqout-chat/` 等，2026-10-21 一次性快照抽象，抽取后与源仓库互不依赖）

---

## 目录

1. [模板整体架构说明](#1-模板整体架构说明)
2. [目录结构说明](#2-目录结构说明)
3. [核心模块职责与工作原理](#3-核心模块职责与工作原理)
4. [环境准备与依赖安装](#4-环境准备与依赖安装)
5. [基于模板创建新项目](#5-基于模板创建新项目)
6. [关键配置项说明](#6-关键配置项说明)
7. [自定义与二次扩展指南](#7-自定义与二次扩展指南)
8. [常见问题与注意事项](#8-常见问题与注意事项)
- [占位符总清单](#占位符总清单)

---

## 1. 模板整体架构说明

模板内部按「**前端骨架 / Agent 后端 / 服务壳 / 模板工程化**」四区划分：

```
┌─────────────────────────────────────────────────────────────┐
│  前端骨架 src/（React SPA, Vite dev :3015）                    │
│  routes/index.tsx 页面编排 · services/chatClient.ts SSE 解析  │
│  i18n 双语 · styles.css 主题 token · 游客/登录双模式           │
└──────────────┬──────────────────────────────────────────────┘
               │ POST 对话（SSE 流式）GET /models /stats
               │ /auth/* /history(PUT)
┌──────────────▼──────────────────────────────────────────────┐
│  自托管服务壳 server/local.mjs（:8787，零依赖 Node HTTP 壳）   │
│  .env 解析 · CORS · 1MB body 上限 · 断连中止 · 统计落盘        │
│  account-api.mjs 本地账号 / 历史快照 / 排行榜                  │
└──────────────┬──────────────────────────────────────────────┘
               │ 进程内 import handler（零网络跃层）
┌──────────────▼──────────────────────────────────────────────┐
│  Agent 核心后端 functions/agent-chat/（handler 主循环）        │
│  config.ts 配置单点 · shared.ts 网络基建 · intent.ts 意图 IR   │
│  grounding 校验 · usageStats 统计 · echo/demo_cards 示例工具   │
│  weather/ 注册门示例模块 · prompts/ 双语提示词管理              │
└──────────────┬──────────────────────────────────────────────┘
               │ 每轮 1 次 chat/completions（tool-calling）
        ┌──────▼──────┐          ┌─────────────────────┐
        │ OpenAI 兼容  │          │ 使用者领域数据 API    │
        │ LLM 网关     │          │ （示例：weather 模块）│
        └─────────────┘          └─────────────────────┘
```

**一次对话的完整数据流**（前端发起 → 流式返回的 SSE 帧序列时序）：

```
前端 POST {messages, model, stream:true, lang}
  ├─ 心跳：: ping（每 10s，防代理缓冲，前端忽略非 data: 行）
  ├─ {"delta":"..."}           正文增量（多次）
  ├─ {"event":"tool","name":"echo","label":"回显文本（示例）","status":"running"}
  ├─ {"event":"tool","name":"echo","status":"done","ms":3}
  ├─ {"event":"cards","cards":[{tool,accession,title,summary,meta}]}   （有卡片才发）
  ├─ ...（多轮 tool-calling 循环，最多 40 轮）
  ├─ {"event":"grounding","unconfirmed":[...],"confirmed":[...]}       （有未证实引用才发）
  ├─ {"event":"end","cards":[全部卡片],"tools":[工具轨迹]}
  └─ data: [DONE]
```

帧语义**冻结**：`delta / tool / cards / grounding / end / error / [DONE]` 七类帧与心跳只加不改——新增帧类型必须对旧前端透明（前端解析是 else-if 链，未知事件自然跳过）。

**模板的四条设计红线**（详见第 8 章）：

1. SSE 协议只加不改；2. 领域模块禁止反向 import 主文件；3. 空结果 ≠ 失败（empties 与 errors 分列统计）；4. 生成物（prompts.generated.ts）禁手改。

---

## 2. 目录结构说明

```
template/
├── init.mjs                     # 模板初始化脚本（占位符替换 + 报告，零依赖、幂等）
├── package.json                 # 最小依赖清单（前端 + 工具链；后端零运行时依赖）
├── tsconfig.json / vite.config.ts / index.html / .gitignore / .dockerignore
├── Makefile                     # docker-start 预检链（密钥预检 → 端口检测 → 构建启动）
├── README.md                    # 本文档（唯一入口）
├── docs/
│   ├── deployment.md            # 部署专项（Docker 双容器 / nginx SSE 反代 / 卷挂载）
│   └── extension-guide.md       # 扩展指南全录（六路径菜谱 + 联动点清单）
├── functions/agent-chat/        # ── Agent 核心后端（Node 22.6+ 原生跑 .ts，零依赖）──
│   ├── index.ts                 # handler 主循环：tool-calling 循环 / SSE 下行 / 工具分发 / grounding / 统计
│   ├── config.ts                # 运行时行为配置单点（AGENT_* 环境变量可覆盖，带钳制）
│   ├── shared.ts                # envGet / fetchWithRetry / createTokenBucket 网络基建
│   ├── intent.ts                # 意图 IR 校验框架（纯函数，消费 intent-vocab 词表）
│   ├── intent-vocab.ts          # 意图槽位与归一化词表单点定义（换领域只改这一个文件）
│   ├── prompts/
│   │   ├── system-zh.md         # 中文系统提示词（唯一可编辑来源）
│   │   └── system-en.md         # 英文系统提示词（与 zh 逐条平行）
│   ├── prompts.generated.ts     # sync 脚本生成物（禁手改）
│   ├── scripts/sync-prompts.mjs # md → generated.ts 同步脚本
│   ├── weather/                 # 注册门示例模块（六项导出契约 + 注册门双保险的活教材）
│   │   ├── types.ts / client.ts / current.ts / forecast.ts / index.ts
│   └── tests/                   # 离线测试（node:test + mock fetch + gzip fixtures）
│       ├── config.test.ts / intent.test.ts / prompts-sync.test.ts
│       ├── echo.test.ts / demo-cards.test.ts / weather.test.ts / grounding.test.ts
│       └── fixtures/weather-{ok,auth-failed,empty}.json.gz
├── server/                      # ── 自托管服务壳（零依赖 Node）──
│   ├── local.mjs                # HTTP 壳：.env 解析 / CORS / 断连中止 / 统计落盘 / 占位符检测
│   ├── account-api.mjs          # 本地账号体系：scrypt 口令 / 历史快照 / 排行榜（通用列名）
│   ├── .env.example             # 环境变量唯一来源（每变量五要素注释）
│   └── tests/account-api.test.mjs
├── src/                         # ── 前端最小骨架（React 19 + Vite + Tailwind v4）──
│   ├── main.tsx                 # 应用入口
│   ├── routes/index.tsx         # 主页：handleSend 主流程 / 会话切换 / 双模式 / 主题切换
│   ├── services/
│   │   ├── chatClient.ts        # SSE 解析 else-if 链（未知事件透明跳过）+ StreamHandlers
│   │   ├── localAuth.ts         # 本地账号 + 历史快照防抖同步
│   │   ├── cloudAdapter.ts      # 云模式可选边界（离线 Proxy 桩 + isOfflineMode）
│   │   └── deviceId.ts          # 匿名设备标识（X-Stats-Actor）
│   ├── components/chat/         # 8 个组件：ChatMessage / Composer / EmptyState / Markdown /
│   │                            # SessionSidebar / ToolTrace / GroundingNotice / ResultCard
│   ├── components/auth/AuthDialog.tsx
│   ├── i18n/                    # 轻量 i18n 内核 + zh/en 双字典（zh 为键权威）
│   ├── lib/                     # cn（clsx+tailwind-merge）/ copyText（非安全上下文兜底）
│   └── styles.css               # :root/.dark 双套主题 token + 基础动效
└── deploy/                      # ── Docker 部署 ──
    ├── Dockerfile               # 双 target：web（nginx 托管静态产物）/ chat（Node 跑服务）
    ├── docker-compose.yml       # 双容器拓扑 + /app/data 命名卷 + --env-file 注入
    ├── nginx.docker.conf        # SSE 反代（proxy_buffering off 等关键段）
    └── check-llm-key.py         # 启动前密钥预检（避免"容器起来了但一对话就报错"）
```

---

## 3. 核心模块职责与工作原理

### 3.1 Agent 执行循环（`functions/agent-chat/index.ts` 的 `handler`）

**职责**：接收 POST 对话请求，驱动「LLM → 工具 → LLM → …」多轮循环，以 SSE 流式返回。

**工作原理**（主循环不变量，平移自已验证实现）：

1. `GET /stats` 分支**必须先于** models 分支判定——否则一切 GET 会被 models 吞掉；
2. Request body 只读一次（`req.json()` 不可重复调用）；
3. 历史裁剪 `slice(-historyWindow)` 后前置 system 双语消息（按 `lang` 选择）；
4. 每轮请求信号 = `AbortSignal.any([req.signal, timeout(llmTimeoutMs)])`——断连与超时任一触发即中止；
5. 上游 SSE 逐行解析：`[DONE]` 置完成标志、`json.usage` 计 token、`delta.tool_calls` **按 index 增量聚合**（id/name/arguments 均为增量拼接，流式 tool-calling 的关键语义）；
6. 无工具调用即结束本轮（`!sawDone` 时补发空 delta 保底）；
7. 工具执行：running 事件 → 执行 → 有卡发 cards 帧 + `trimForLLM` 回灌 + done 事件；失败则错误信封回灌 + error 事件；**空结果（`data.empty`）计 empties 不计 errors**；
8. 触顶提示在 `maxTurns - 1` 轮联动下发；
9. 终态顺序固定：grounding 校验 → `end` 帧 → finally 清心跳 + `[DONE]` + close；
10. 断连四不纪律：停止读上游流、不执行工具、不进下一轮、不发事件。

> **来源与坑**：主循环形态源自原仓库 `functions/seqout-chat/index.ts`（2176 行中约 700 行框架主体）。**为什么不拆散**：已被验证的行为时序（终态顺序、abort 检查点分布、tool_calls 聚合语义）拆散反而引入回归风险。上游 tool_calls 增量聚合曾是对接多家网关时的关键踩坑点——部分网关把 arguments 分多帧下发，按 index 拼接才能还原完整 JSON。

### 3.2 工具调用机制（声明式 schema + 六项导出契约 + 注册门）

**职责**：把「工具如何被模型看见、如何被执行、如何变成卡片」标准化。

**三种接入形态**（模板各配一个活教材）：

| 形态 | 范本 | 适用 |
|---|---|---|
| 直接内置 | `echo`（index.ts 内 case） | 一两个简单工具的最短路径 |
| 卡片产出型内置 | `demo_cards` | 需要结构化卡片展示的工具 |
| 注册门模块 | `weather/`（独立目录 + 双保险门） | 有独立凭据/开关的领域模块 |

**六项导出契约**（领域模块的标准 API，weather 为示范实现）：

```text
export const <域>_TOOL_DEFS        // 1. 工具定义集（OpenAI function schema）
export const <域>_TOOL_NAMES       // 2. 工具名 as const 元组
export function is<域>Tool(name)   // 3. 判属函数
export async function execute<域>Tool(name, args)  // 4. 执行入口（同签名同信封）
export const <域>_TOOL_LABELS      // 5. 中文展示标签映射
export function extract<域>Cards(name, payload)    // 6. 卡片投影（异常一律空数组）
export function <域>Registered()   // 7.（可选）注册门
```

**注册门双保险**：`ENABLED 环境变量为真` **且** `凭据非空` 才注册进 TOOL_DEFS；`execute<域>Tool` 入口**独立再校验**一次——注册状态与运行时不一致时抛中文 CONFIG_MISSING 错误、**零上游请求**。开箱默认关闭：`WEATHER_ENABLED` 未配置时工具面零新增，纯 LLM + 内置示例即可跑通全链路。

> **来源与坑**：契约形态源自原仓库 `protocols/`、`biomed/` 两个领域模块的实测组织方式。**硬红线**：领域模块禁止反向 import 主 index.ts（ES 循环依赖）；schema 辅助函数（`tool/reqStr/strOpt/intOpt`）与主文件**同构复制不共享**——共享会让模块反向依赖主文件。**空结果口径**：上游「查无此条目」以 `{success:true, data:{empty:true, note}}` 信封返回（计 empties），与「工具执行失败」（抛错计 errors）严格分开——曾把两者混为一谈导致统计面板误报工具故障率。

### 3.3 会话记忆（三层，均为会话级）

1. **服务端窗口**：`history.slice(-historyWindow)` 只送最近 N 条，system 消息始终在窗口外前置；
2. **游客本地持久化**（前端）：localStorage 单 key 存全部会话；每会话记 `ts` 最后活跃时间；上限 50 条、超 7 天未活跃的**读取时过滤**（写入不清理——避免写路径变重）；
3. **登录快照同步**：前端防抖整快照 `PUT /history`；服务端按会话 id 存储；登录时「服务端与本地方合并，同 id 取较新」。

> **来源与坑**：刻意**不引入**长期记忆/向量检索（会话级记忆已覆盖对话场景的绝大多数需求，伪需求会显著增加运维面）。游客会话「读取时过滤」而非「写入时清理」是性能取舍：流式期间 messages 每 delta 变一次，写路径多做事会让回答越长越卡（原仓库实测）。历史同步走 **PUT**（CORS 必须允许 PUT 方法，见 3.7）。

### 3.4 提示词管理（双语外置 md + sync 脚本 + 守漂移测试）

**链路**：`prompts/system-{zh,en}.md`（唯一可编辑来源，双语逐条平行）→ `npm run sync:prompts` 执行 `scripts/sync-prompts.mjs`（读 md 剥末尾单换行 → `JSON.stringify` 嵌入生成 `prompts.generated.ts`，免转义坑）→ 业务代码 import 生成物 → `tests/prompts-sync.test.ts` 比对 md 与实际导入字符串，**改 md 忘跑 sync 立即红**。

> **来源与坑**：生成物**禁手改**（下次 sync 会覆盖）；JSON.stringify 嵌入是为了绕开「提示词含反引号/反斜杠时的转义地狱」；双语两份逐条平行（改一条必须两份同步，否则英文用户拿到旧规则）。模板内置的提示词是中性骨架（角色定位 → 工具规则 → 呈现 → 语言 → 安全边界五段），替换正文即可。

### 3.5 意图规划框架（intent.ts + intent-vocab.ts）

**职责**：把「用户问题 → 结构化意图」落成显式 IR。模型经 `intent_plan` 工具产出意图 JSON，框架校验并归一化（判别联合 `ok:true/false`，未知值一律拒绝不猜），归一化结果作为 tool 消息回灌模型引导后续工具参数。

**主循环拦截位**：`intent_plan` 不调外部 API、不发 SSE tool 事件、不计用量；校验通过的 IR 落 tool_logs 供审计（前端轨迹按名过滤）；失败只回灌原因，整体退化为无意图行为。

**框架与数据分离**：校验/判别联合/归一化逻辑在 `intent.ts`（零领域内容）；槽位 schema 与归一化词表在 `intent-vocab.ts` 单点定义——**换领域只改这一个文件**（模板内置「分类/地区」中性示例词表）。

> **来源与坑**：源自原仓库把物种中文名归一化为二名法学名的实践——词表驱动 + 未知值拒绝（宁缺勿猜）是防模型自造词表值的关键。测试是黄金用例（期望值人工核实写死，不随实现改）。

### 3.6 grounding 校验框架（正文 ↔ 证据一致性）

**职责**：模型正文引用的标识须与本轮证据卡片同源。主循环终态（`end` 之前）执行：`SCAN_PATTERNS` 模式集扫描全文 → 与卡片标识集合比对 → 卡片外标识回源核验（上限 `groundingVerifyLimit` 个，3s 超时）→ 仍无法证实的经 `{event:"grounding"}` 下发前端警示条；核验摘要以 `grounding_check` 条目写 tool_logs 供审计。

**参数化**：模式集与验证器路由表是 `index.ts` 内的**集中注册表常量区**（模板给中性示例：DOI/URL 模式 + doi.org 可达性验证）；框架函数（扫描/比对/限量回源/降级）零领域内容。上游全灭时整次降级不提示——基础设施抖动不应误报模型。

> **来源与坑**：扫描模式注册表的 normalize 函数把命中归一到与卡片可比的规范形（DOI 小写、URL 原样、普通编号大写）——规范形不一致是这类比对最常见的漏报原因。

### 3.7 自托管服务壳（server/local.mjs + account-api.mjs）

**职责**：零依赖 Node HTTP 壳，把 `handler` 以**进程内 import** 方式跑起来（无网络跃层）。

**关键机制**：

- `.env` 手工解析（KEY=VALUE、去引号、`$VAR`/`${VAR}` 引用、进程变量优先）；
- 统计持久化：启动恢复 + 每 15s 有变化才落盘，**tmp 文件 + 原子 rename**（防写一半坏档）；
- `MAX_BODY=1MB` 流式累计超限 413；`res.on('close') → abort` 断连中止（省 token）；
- **CORS 必须允许 `PUT` 与 `X-Stats-Actor` 头**（历史同步走 PUT、统计上报走该头——缺任一前端都会静默失败）；
- 启动期**占位符残留检测**：未跑 init.mjs 时 console.warn 列出文件与记号，不阻塞启动；
- 账号体系：scrypt 口令哈希 + 随机 Bearer token + JSON 落盘（tmp+rename 防抖）。

> **来源与坑**：Docker 内必须显式 `CHAT_API_HOST=0.0.0.0`（默认 127.0.0.1 只绑回环，容器间不可达；compose 已配）。**安全定位（如实说明）**：自托管熟人场景，无速率限制——公网部署请置于反代之后自行加限流，并配置 `CHAT_SHARED_SECRET`。账号 api 有路径穿越回归测试守护（email 进文件名前硬校验 + containment 断言）。

### 3.8 配置管理（config.ts 单点）

**职责**：全部运行时行为参数（轮次/超时/心跳/瘦身/核验上限/游客会话策略/统计护栏）单点定义，`AGENT_*` 环境变量可覆盖，非法值钳制回默认。**同名配置只在 config.ts 出现一次**，其余模块一律 import 消费。

### 3.9 用量统计（usageStats）

**职责**：进程内单例统计（chats/llmCalls/toolCalls/toolErrors/**empties** 分列 + per-tool count/errors/empties + token 三项 + actors 去重）；`GET /stats` 返回快照并附可选模块集成状态枚举（`integrations.weather: disabled|token_missing|enabled`，不含凭据值任何信息）。`MAX_ACTORS` 内存护栏防恶意刷 actor 膨胀。

### 3.10 测试体系（离线 + LIVE 双态）

**运行器**：`node --test`（零测试框架依赖）；`npm test` 离线全量，`npm run test:live` 联网验收（`WEATHER_LIVE=1`，上游 429/瞬态自动 skip 不算失败）。

**模式**：测试文件内 `mockFetch` 按 URL 路由桩（临时替换 `globalThis.fetch`，测后还原）+ `setEnv` 辅助；fixtures 为真实上游响应 gzip 固化（`tests/fixtures/*.json.gz`，`.gitignore` 反豁免）；黄金用例期望值人工核实写死。

> **来源与坑**：Node 原生 type-stripping **不支持构造器参数属性**（`constructor(readonly x: T)` 语法会直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）——领域模块的 Error 子类要写成普通字段赋值。这是跑 `.ts` 测试时最常见的语法雷。

---

## 4. 环境准备与依赖安装

### 硬要求：Node ≥ 22.6

后端用 Node **原生 type-stripping 直接跑 .ts**（`node server/local.mjs` import TS 模块），该能力 22.6 才引入。检查：

```bash
node --version   # 需 ≥ v22.6.0（推荐 24.x）
```

### 包管理器

`npm`（模板只带 package.json，无 lockfile；首次 install 后建议提交生成的 package-lock.json）。

### LLM 网关要求（四项）

1. 提供 `GET {base}/models` 模型目录（标准 OpenAI 形态或 `{models:[...]}` 形态均可）；
2. 提供 `POST {base}/chat/completions`（SSE 流式）；
3. 支持 **tool-calling**（`tools` + `tool_choice` 参数，流式 `delta.tool_calls` 增量下发）；
4. 支持 `stream_options.include_usage`（流末回传 token 用量；不支持时统计面板 token 项为零，不影响对话）。

任意 OpenAI 兼容服务均可：OpenAI / DeepSeek / 硅基流动 / 本地 vLLM + ngrok 等。

### 安装依赖

```bash
npm install
```

后端与服务壳**零运行时依赖**（只有前端与工具链需要 install）。

---

## 5. 基于模板创建新项目

五步走（命令逐条可复制）：

### 第 1 步：复制模板

把 `template/` 目录整体复制到你自己的项目位置（不要包含 `node_modules/` 与运行数据）：

```bash
cp -r path/to/Treasure-Seeking_Mouse/template my-agent && cd my-agent
rm -rf node_modules dist server/data server/.stats.json 2>/dev/null
```

### 第 2 步：初始化（替换占位符）

```bash
node init.mjs --name 我的项目 --slug my-project --agent 小助 --domain 知识检索 --lang zh --yes
```

省略参数则进入交互问答；`node init.mjs --check` 只看占位符分布不写入。替换报告会列出「成功项 / 未识别占位符（提示登记）/ 遗漏项」三段。

### 第 3 步：配置环境

```bash
cp server/.env.example server/.env
# 编辑 server/.env，至少填入：
#   LLM_API_KEY=sk-xxx          （必填）
#   LLM_BASE_URL=https://api.deepseek.com   （换成你的网关）
#   LLM_MODEL=deepseek-chat     （默认模型）
```

### 第 4 步：启动

```bash
npm install
npm run server    # 终端 1：对话服务 http://localhost:8787
npm run dev       # 终端 2：前端 http://localhost:3015
```

### 第 5 步：验证（验收信号清单）

浏览器打开 http://localhost:3015 ，逐项核对：

| # | 验收信号 | 通过标准 |
|---|---|---|
| 1 | 启动日志 | `server` 终端打印本地服务地址与 LLM_BASE_URL；未填 key 时有醒目警告 |
| 2 | 纯 LLM 对话 | 发送「现在几点」——正文逐字流式出现（delta 持续到达） |
| 3 | echo 工具 | 发送「用 echo 工具把『你好』转成大写」——出现工具胶囊（running→done + 耗时） |
| 4 | demo_cards 卡片 | 发送「给我看 fruits 主题的演示卡片」——出现结构化卡片网格 |
| 5 | 结束帧 | 每轮回复正常收尾（end 帧后流关闭） |
| 6 | weather 静默 | 未配 WEATHER_API_KEY 时，天气工具**不出现在**工具轨迹（注册门静默）；`curl http://localhost:8787/stats` 的 `integrations.weather` 为 `disabled` |
| 7 | 游客会话 | 发几条消息后刷新页面——会话仍在侧栏（localStorage 持久化） |
| 8 | 注册登录 | 侧栏「登录/注册」创建账号——登录后历史合并（PUT /history 生效） |
| 9 | 离线测试 | `npm test` 全绿（无需网络） |

---

## 6. 关键配置项说明

### 6.1 环境变量（`server/.env` 唯一来源）

| 变量 | 用途 | 默认值 | 构建期 | 缺失行为 |
|---|---|---|---|---|
| `LLM_API_KEY` | 模型服务密钥 | 无 | 否 | 服务可启动（warn），对话返回 503 + 修复指引 |
| `LLM_BASE_URL` | OpenAI 兼容网关地址（须以 /v1 结尾） | `https://api.example.com/v1` | 否 | 用默认值，请求将失败并提示 |
| `LLM_MODEL` | 默认模型名 | `default-model` | 否 | GET 目录用网关 defaultModel；对话用默认值 |
| `CHAT_API_PORT` / `CHAT_API_HOST` | 服务端口 / 监听地址 | `8787` / `127.0.0.1` | 否 | 缺省即默认；容器内须显式 `0.0.0.0`（compose 已配） |
| `CHAT_SHARED_SECRET` | 可选对话共享密钥 | 未配置 | 否 | 未配置完全兼容无鉴权；配置后须带 `X-Chat-Key` |
| `AGENT_*` 行为项 | 见 6.2 | 见 6.2 | 否 | 钳制到默认 |
| `WEATHER_ENABLED` / `WEATHER_API_KEY` | 示例注册门（开关+凭据） | `false` / 空 | 否 | 任一缺失 → weather 零注册、直调抛 CONFIG_MISSING |
| `WEATHER_LIVE` | weather 联网测试开关 | 未设=离线 | 否 | 离线跑 fixtures |
| `STATS_FILE` / `DATA_DIR` | 统计快照 / 数据落盘目录 | `server/.stats.json` / `server/data` | 否 | 缺省即默认；容器挂 `/app/data` 卷 |
| `WEB_PORT` | 宿主访问端口 | `10087` | 否 | make 预检占用即报错停止 |
| `VITE_CHAT_API` | 前端对话服务地址 | `http://localhost:8787` | **是** | 缺省走默认；改后需重新 build |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | 可选云模式接入 | 未配置 | **是** | 纯游客 + 本地账号模式（离线 Proxy 桩） |

### 6.2 行为配置项（`config.ts` 单点定义，env 可覆盖，带钳制）

| 配置项 | env 覆盖名 | 默认值 | 作用 |
|---|---|---|---|
| `maxTurns` | `AGENT_MAX_TURNS` | 40 | tool-calling 轮次上限；触顶提示在 maxTurns-1 轮联动 |
| `historyWindow` | `AGENT_HISTORY_WINDOW` | 16 | 送模型的历史条数（system 不计） |
| `llmTimeoutMs` | `AGENT_LLM_TIMEOUT_MS` | 90000 | 单轮 LLM 请求超时 |
| `heartbeatIntervalMs` | `AGENT_HEARTBEAT_MS` | 10000 | SSE 心跳间隔 |
| `trimLimit` | `AGENT_TRIM_LIMIT` | 100000 | LLM 输入瘦身上限字符数 |
| `groundingVerifyLimit` | `AGENT_GROUNDING_VERIFY_LIMIT` | 5 | 单次 grounding 回源核验上限 |
| `guestSessionLimit` | `AGENT_GUEST_SESSION_LIMIT` | 50 | 游客本地会话数量上限 |
| `guestSessionTtlDays` | `AGENT_GUEST_TTL_DAYS` | 7 | 游客会话过期天数（读取时过滤） |
| `historySyncDebounceMs` | `AGENT_HISTORY_SYNC_DEBOUNCE_MS` | 800 | 登录历史快照同步防抖 |
| `maxTrackedActors` | `AGENT_MAX_ACTORS` | 20000 | 统计内存护栏 |

### 6.3 密钥管理专节

| 密钥 | 位置 | 轮换方式 |
|---|---|---|
| `LLM_API_KEY` | `server/.env`（已被 .gitignore / .dockerignore 双重排除） | 直接改文件值重启；或用引用式写法 `LLM_API_KEY=$MY_LLM_KEY` 从 shell/进程环境注入，轮换只换环境变量 |
| `WEATHER_API_KEY` | `server/.env`（仅服务端读取） | 同上；删除后重启即回到零注册态 |
| `CHAT_SHARED_SECRET` | `server/.env` + 前端请求头 `X-Chat-Key` | 改值重启；前端直连场景需同步配 `VITE_CHAT_API` 侧的请求头注入（按需扩展） |

**红线**：任何密钥类变量**禁止**出现在 `VITE_*` 命名空间——`VITE_*` 会被打包进前端产物，等于公开。

---

## 7. 自定义与二次扩展指南

六条扩展路径（完整菜谱含全部联动点清单见 `docs/extension-guide.md`）：

| 路径 | 范本 | 最小步骤 |
|---|---|---|
| **加工具** | `echo` | TOOL_DEFS 加声明 → executeTool 加 case → labelOf 加标签 → 补测试（四步） |
| **加领域模块** | `weather/` | 独立目录 + 六项导出契约 + 注册门双保险 + 主文件三处接线（import / 条件展开 / 委托）+ fixtures/LIVE 测试 |
| **加协议帧** | `grounding` 帧 | 服务端 send → 前端解析 else-if → 路由页回调三处联动（「只加不改」红线） |
| **改提示词** | `prompts/system-*.md` | 改 md（唯一来源）→ `npm run sync:prompts` → 守漂移测试自动校验；双语两份同步改 |
| **换主题与文案** | `styles.css` / `i18n/locales` | 只动 token 与 zh/en 双字典；zh 是键权威，缺 en 键静默回退中文 |
| **接入自有存储** | `cloudAdapter.ts` | 云模式可选边界：离线 Proxy 桩 + 按需自装依赖说明 |

**换领域最短路径**：改 `intent-vocab.ts`（词表）+ `prompts/system-*.md`（提示词）+ 用你的工具替换示例工具三件事，框架零改动。

---

## 8. 常见问题与注意事项

### 密钥安全

- 密钥只进 `server/.env`（双 ignore 排除）；`VITE_*` 禁止携带密钥（构建产物公开可读）；
- `CHAT_SHARED_SECRET` 未配置 = 对话接口无鉴权（启动日志会醒目警告）；公网部署务必配置并置于反代之后。

### 限流与 429

- 上游 429/5xx 由 `fetchWithRetry` 自动退避重试（1s/2s/4s，默认 3 次后抛出）；
- 领域模块自带令牌桶（`createTokenBucket(rate, capacity)`）——预算用尽时**直接降级**（返回错误或空结果），不排队等待；
- LIVE 测试对 429/瞬态失败自动 skip，不算测试失败。

### 空结果口径

- 上游「查无此条目」= 业务空结果：`{success:true, data:{empty:true, note}}` 信封（统计计 **empties**）；
- 工具执行异常 = 真错误：抛 Error → 主循环转 `{success:false, error}` 信封回灌（统计计 **errors**）；
- 两者在 `/stats` 面板分列展示——混用会让故障率失真。

### 协议兼容红线

- SSE 帧「只加不改」：改既有帧语义会同时破坏新旧前端；新帧类型对旧前端的 else-if 链天然透明；
- 前端解析器保持 else-if 形态（勿改成 exhaustive switch）。

### Node 版本

- 后端 `node server/local.mjs` 原生跑 `.ts` 需 **Node ≥ 22.6**；测试同（`node --test *.test.ts`）；
- type-stripping 不支持构造器参数属性语法（`constructor(readonly x)`）——Error 子类用普通字段赋值。

### Docker 部署注意

- 容器内必须 `CHAT_API_HOST=0.0.0.0`（compose 已显式配置，勿删）；宿主裸跑保持 127.0.0.1；
- 统计与账号数据挂 `/app/data` 命名卷（`docker compose down` 不丢，`down -v` 才删）；
- 密钥经 `--env-file server/.env` 注入运行时，不进镜像（`.dockerignore` 排除）；`VITE_*` 是构建期变量，改了要重新 build；
- nginx SSE 反代三件套：`proxy_buffering off` + `proxy_read_timeout 600s` + 精确匹配无尾斜杠的 `/chat-api`（详见 `docs/deployment.md`）。

### 原仓库踩坑摘录（「来源与坑」速查）

| 坑 | 后果 | 模板内的防护 |
|---|---|---|
| fetch 请求头含非 ASCII（如中文 User-Agent） | Node/undici 直接抛 TypeError，该上游源整体不可用 | shared.ts 头注释约定 + weather client 用 ASCII UA |
| CORS 缺 PUT / X-Stats-Actor | 前端历史同步、统计上报**静默失败**（无报错） | local.mjs CORS 白名单显式包含两者 |
| 落盘直接覆写原文件 | 进程中断时留下半截 JSON 坏档 | 全部走 tmp + rename 原子写 |
| 模型把自由文本当词表值直传上游 | 上游 422 原始报文对模型不友好 | intent 校验未知值一律 ok:false 不猜 |
| 表格结果从中间截断 JSON | 模型收到半截原始文本 | trimForLLM 按行二分切，truncated 标记 |
| 代理层缓冲 SSE | 长回复卡住不动 | 心跳注释行 + `X-Accel-Buffering: no` 响应头 |

---

## 占位符总清单

初始化脚本 `init.mjs` 的内置映射表与本清单一一对应（**登记纪律**：新增占位符必须同步 init.mjs 的 PLACEHOLDERS 数组与本表，否则 init 报「未识别占位符」提醒你补登记）。

| 占位符 | 含义 | 出现位置（文件级） | 替换示例 |
|---|---|---|---|
| `{{PROJECT_NAME}}` | 项目显示名 | `package.json`(description)、`index.html`(title)、`Makefile`、`deploy/*`(注释)、`functions/agent-chat/prompts/system-{zh,en}.md`、`src/i18n/locales/{zh,en}.ts` | 法律文书助手 |
| `{{PROJECT_SLUG}}` | 短标识（kebab/小写，键前缀与日志） | `package.json`(name)、`deploy/docker-compose.yml`(name)、`functions/agent-chat/index.ts`(FUNCTION_NAME)、`server/local.mjs`(日志前缀)、`index.html`、`src/i18n/index.ts`、`src/services/{localAuth,deviceId}.ts`、`src/routes/index.tsx`(localStorage 键前缀) | legal-doc-agent |
| `{{AGENT_NAME}}` | Agent 名称（提示词人格名） | `prompts/system-{zh,en}.md`、`src/i18n/locales/{zh,en}.ts`(欢迎语) | 小法 |
| `{{DOMAIN}}` | 领域名（提示词与文案中的领域表述） | `prompts/system-{zh,en}.md`、`src/i18n/locales/{zh,en}.ts` | 法律文书检索 |
| `{{DEFAULT_LANG}}` | 默认界面语言（zh/en） | `index.html`(lang + 引导脚本)、`src/i18n/index.ts`(默认语言常量) | zh |

全文检索核对：`grep -roh '{{[A-Z_]*}}' . | sort -u` 的输出集合应 ⊆ 本表（node_modules/dist 除外）。

---

**扩展阅读**：部署细节见 `docs/deployment.md`；六路径扩展菜谱全录（含全部联动点）见 `docs/extension-guide.md`。