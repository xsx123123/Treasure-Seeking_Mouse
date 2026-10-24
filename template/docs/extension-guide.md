# 扩展指南（Agent 项目模板 · 六路径菜谱全录）

> 每条路径列出**全部联动点**（后端 / 前端 / 文档 / 测试），按清单逐项改完即完成一次扩展；
> 漏任何一处都会留下「只在某个界面语言/某个分支生效」的隐性 bug。
> 范本均可运行：echo（内置最短路径）、demo_cards（卡片型）、weather/（注册门模块）、grounding 帧（协议帧）。

## 路径一：加工具（echo 为范本——直接内置形态）

四个联动点（`functions/agent-chat/index.ts` 单文件内）：

1. **TOOL_DEFS 声明**：`tool('my_tool', '描述（给模型看，写清何时用/参数语义）', { 参数 schema }, ['必填参数'])`；
2. **executeTool case**：`case 'my_tool': { 参数校验 → 业务执行 → wrap(data) 或 emptyResult(note) }`——错误用 `throw new Error(中文可读)`（主循环自动转 `{success:false,error}` 信封回灌并计 errors）；
3. **labelOf 标签**：map 加 `my_tool: '中文标签'`（前端工具胶囊与统计面板展示）；
4. **测试**：`tests/my-tool.test.ts`（参数校验 / 信封形状 / 空结果口径 / 卡片投影），加进 `package.json` 无需改（test glob 自动覆盖）。

前端零改动（工具胶囊/统计自动纳入）；i18n 的 `toolLabel` 表可选加英文覆盖。

## 路径二：加领域模块（weather/ 为范本——六项导出契约 + 注册门）

**目录组织**（对齐 weather/ 范式）：`functions/agent-chat/<domain>/`，建议 types.ts（类型）/ client.ts（配置缓存 + HTTP 客户端 + 错误分类）/ <能力>.ts（各工具实现）/ index.ts（单点出口）。

**七项导出**（契约签名，`<域>` 为你的领域前缀）：

```text
export const <域>_TOOL_DEFS: ToolDef[]                          // 1. 工具定义集
export const <域>_TOOL_NAMES: readonly string[]                 // 2. 工具名集
export function is<域>Tool(name: string): boolean               // 3. 判属函数
export async function execute<域>Tool(name, args): Promise<Json>   // 4. 执行入口（同签名同信封）
export const <域>_TOOL_LABELS: Record<string, string>           // 5. 标签集
export function extract<域>Cards(name, payload): Json[]         // 6. 卡片投影（异常一律空数组）
export function <域>Registered(): boolean                       // 7. 注册门（有独立凭据时）
```

**注册门双保险**（语义照抄 weather）：

- 注册判定：`ENABLED 环境变量解析为真` **且** `凭据非空` 才注册（另可导出 `<域>IntegrationStatus(): 'disabled'|'token_missing'|'enabled'` 供 /stats 展示）；
- 执行入口**独立再校验**：不一致时抛中文 CONFIG_MISSING 类错误、**零上游请求**（防「注册状态与运行时不一致」）。

**主文件三处接线**（`index.ts`，唯一方向——模块 → 主文件禁止反向 import，ES 循环依赖红线）：

1. import 语句；
2. `TOOL_DEFS = [ ..., ...(<域>Registered() ? <域>_TOOL_DEFS : []) ]` 条件展开；
3. `executeTool` 入口 `if (is<域>Tool(name)) return execute<域>Tool(name, args)` + `extractCards` 入口 `if (is<域>Tool(name)) return extract<域>Cards(name, payload)` + `labelOf` 合并标签。

**红线清单**：

- 模块内 schema 辅助（tool/reqStr/strOpt/intOpt）**同构复制**，不 import 主文件；
- fetch 请求头必须 ASCII（ByteString 校验，中文 UA 直接抛 TypeError）；
- 消费 `shared.ts` 的 `fetchWithRetry`（429/5xx 退避）与 `createTokenBucket`（限流降级）；
- 空结果走 `{success:true, data:{empty:true, note}}` 信封（计 empties），不要抛错（计 errors）。

**测试与 fixtures**：`tests/fixtures/<域>-{ok,auth-failed,empty}.json.gz` 三态固化 + `tests/<域>.test.ts`（mockFetch 路由桩 + setEnv + 注册门三态 + 双保险零 fetch 断言 + LIVE 开关 skip 语义）；启动日志与 `/stats` 的 integrations 枚举同步加你的模块状态。

**文档联动**：README §3.2 六项契约表加一行；`.env.example` 加 ENABLED/凭据变量（五要素注释）。

## 路径三：加协议帧（grounding 帧为范本）

**三处联动**（缺一处即「服务端发了前端看不见」或「旧前端崩了」）：

1. **服务端发送**（`index.ts` 主循环）：`send({ event: 'my_event', ...payload })`——payload 结构自定义，但**不得复用/修改既有帧的语义**；
2. **前端解析**（`src/services/chatClient.ts`）：else-if 链加 `else if (obj.event === 'my_event' && ...) handlers.onMyEvent?.(...)`——回调标记为**可选**（`?`），保持对旧调用方向后兼容；
3. **路由页挂接**（`src/routes/index.tsx`）：`handleSend` 的 handlers 里加 `onMyEvent: (p) => patch((m) => ({ ...m, myField: p }))` + `ChatUIMessage` 加展示字段 + 组件渲染。

**「只加不改」红线**（写入模板 README §1 的设计红线）：新帧类型必须对旧前端透明——前端解析是 else-if 链，未知事件自然跳过；改既有帧语义会同时破坏新旧前端。心跳（`: ping`）与 `[DONE]` 语义冻结，勿动。

## 路径四：改提示词（双语 md 唯一来源）

1. 改 `functions/agent-chat/prompts/system-zh.md`（**唯一可编辑来源**）；
2. **双语平行**：`system-en.md` 同步改对应条目（两份段落结构一致，守漂移测试会核对段落数）；
3. `npm run sync:prompts` 重新生成 `prompts.generated.ts`（**生成物禁手改**；忘了跑 sync，`tests/prompts-sync.test.ts` 立即红）；
4. 需要新增「关键规则仍在」防误删断言时，同步更新 `prompts-sync.test.ts` 的第三个测试。

提示词结构建议保持五段：角色定位（含 `{{AGENT_NAME}}`/`{{DOMAIN}}` 占位）→ 能力与工具规则 → 结果呈现与卡片引用 → 语言与格式 → 安全与边界。

## 路径五：换主题与文案

- **主题**：只动 `src/styles.css` 的 `:root` / `.dark` token 与 `@theme` 映射——组件一律消费语义 token（`bg-card` / `text-helix` 等），**禁止**在组件里写死 hex/Tailwind 内置色；`index.html` 内联的防闪白底色需同步改（两处注释已标注）；
- **文案**：一律走 `t("key")`，不写死在组件里；**zh/en 两份字典同时加**（`src/i18n/locales/{zh,en}.ts`）——zh 是键的权威来源，缺 en 键会**静默回退中文**（英文用户看到中文文案的常见根因）；改完 `npx tsc --noEmit` 验证键数一致（MessageKey 模板类型兜底）；
- 服务层错误提示用 `translate(readLang(), "key")`（非组件上下文）。

## 路径六：接入自有存储（云模式可选适配边界）

模板默认**本地账号 + localStorage + JSON 落盘**；云端是可选扩展点：

1. `src/services/cloudAdapter.ts` 保留了「离线 Proxy 桩 + `isOfflineMode`」的机制形态——未配 `VITE_SUPABASE_URL` 时任何调用链 await 得 `{data:null, error:null}`，业务层据此走本地分支；
2. 接入真实云（如 Supabase 兼容实例）：`npm install @supabase/supabase-js`（**按需自装**，模板刻意不进依赖），在 cloudAdapter 的 `cloudClient` 分支实例化真实客户端，保持导出面（cloudClient/isOfflineMode/cloudUrl）不变即可零改业务代码；
3. 云端登录分支：参照 AuthDialog 的结构补云端模式（ signUp/verifyOtp 状态机），`routes/index.tsx` 的 `effUser` 取云端 session 优先；
4. 具体表结构/RLS 策略由你的业务定义（模板不预置任何表）。

## 附：终态兜底补调编排模式（不进模板代码的设计形态）

原仓库有一个「主循环终态自动补链」编排（本轮产出某类卡片 + 检测到衍生需求信号 + 模型本轮未自查时，平台自动补一次检索并入同一消息流）。该模式的**判定逻辑是领域内容**，模板只保留设计形态说明：

- 触发判定函数必须是**纯函数可测**（输入本轮卡片/意图/用户原文，输出布尔），配套三类黄金用例（触发/不触发/防重）；
- 补链结果并入同一消息的 cards 流、计 tool_logs 与用量，模型仍是编排主体（兜底不替代）；
- 防重标志（模型本轮已调用过对应工具则绝不重复）。

实现位置建议：主循环 `end` 帧之前的终态段（grounding 之前/之后皆可，固定顺序后写进注释）。

## 附：换领域最短路径（三件事）

1. `intent-vocab.ts`：换 targets 枚举、filters 槽位、归一化词表（框架零改动）；
2. `prompts/system-{zh,en}.md`：换角色定位与工具规则（跑 sync）；
3. 用路径一/二加你的领域工具（删掉 echo/demo_cards/weather 三个示例亦可——记得同步删 labelOf/TOOL_DEFS/测试/i18n toolLabel 表/空态示例文案）。