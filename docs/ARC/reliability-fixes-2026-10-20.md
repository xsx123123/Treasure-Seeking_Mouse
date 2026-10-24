# 五项可靠性修复：实现与验证记录

日期：2026-10-20。代码已修改，以下区分仓库实现、本地验证与尚未执行的线上操作。原设计见 [优化实施方案](reliability-optimization-plan-2026-10-20.md)，原问题见 [架构盘点](architecture-review-2026-10-19.md)。

## 1. 已实现的行为

| 问题 | 实现 | 核心位置 |
|---|---|---|
| 账号历史混用 | 按服务地址/账号分区；游客独立保留 7 天/50 条；登录验证、拉取与合并成功后才允许推送；请求固定 token，切换后拒收旧响应 | `src/lib/sessionState.ts`、`src/hooks/use-local-history.ts`、首页 |
| 旧历史归属 | 原 key 保留，建立原始备份；用户勾选后导入当前身份；已有 v2 游客会话也可选择导入账号，不自动归属 | SessionState 的 pending/importLegacy |
| 旧快照覆盖 | `/history` 协议 v2；revision 比较、request_id 重放保护、会话/消息删除标记；原子写盘后回复；超限明确拒绝，取消旧的静默截断 | `server/account-api.mjs`、`shared/history.ts` |
| 开启共享密钥后 Web 401 | 浏览器带用户 Bearer；Node 验证本地或已配置的 Supabase 身份后内部授权；直接 Edge 可验证 Supabase；伪造内部头不能越过 Node | `server/chat-access.mjs`、`functions/seqout-chat/access.ts`、handler、SSE service |
| 多批卡片覆盖 | cards 增量合并，end 校准最终集合；变异保留 assembly/等位身份；断流保留已收到内容；显示、入库与计数使用同一 finalMessage | `conversationState.ts`、`chatStream.ts`、首页 |
| 宝藏计数 | 动画不再累加宝藏；请求 finalize 一次结算，quiet 不影响计数；未收到任何有效结果的失败请求不报成功聊天 | 首页、TreasureMouse |
| 昵称 token 不匹配 | 前端使用 Authorization；有效账号改账号，无凭证访客改设备；无效 Bearer 返回 401；旧 body token 明确拒绝 | localAuth、Account API |
| 云端附加字段丢失 | 可选 metadata，保存 grounding/boost/completion；读旧记录兼容；写入使用最终消息快照；保存失败提示并可重试，稳定消息 ID 避免重复消息 | chatStore、conversationState、首页、migration |

首页还对消息所属会话与身份代次作检查，防止切会话时把旧消息写入新会话，或 A → B → A 期间接收首次 A 请求的迟到结果。模型目录与云会话列表的迟到请求同样会丢弃。

历史冲突按会话/消息 ID 合并。双方对同一消息产生不同修改、且无法证明一方为旧基线时保留冲突副本；删除标记防止旧客户端重新带回已删内容。同步失败继续保留本机修改并显示状态，不退回整包盲写。

## 2. 认证配置

| 配置 | 普通 Web 行为 |
|---|---|
| 没有共享密钥，也未设模式 | public，继续允许游客 |
| 配置共享密钥，未设模式 | authenticated，需登录 |
| `CHAT_ACCESS_MODE=public` | 操作者明确允许游客消费 LLM 配额 |
| `CHAT_ACCESS_MODE=authenticated` | 需验证账号；没有共享密钥时也有效 |

`CHAT_SHARED_SECRET` 不进入前端或浏览器存储。Node 使用同进程 WeakSet 标记已授权 Request；远程服务仍可用共享密钥直接调用 handler。WeakSet 信任不能通过 HTTP 头伪造。

Node 默认使用 Account API 账号；配置 `SUPABASE_URL/SUPABASE_ANON_KEY`（或 Node 环境中的 `VITE_SUPABASE_*`）后验证 Supabase 用户。直接 Edge 使用其 `SUPABASE_*` 环境配置。认证服务故障返回 503，无效凭证返回 401；不会因验证失败而降级游客。

文献单篇查询与公开用量统计沿用现有公开语义。authenticated 模式下的游客发送收到登录提示；尚未新增游客额度系统。

## 3. 迁移和上线顺序

### 自托管历史

前后端配套更新，按仓库约定 `make docker-start` 重建；不要只 restart。Docker chat target 已包含新 `shared/` 模块。

旧历史文件首次读取按 revision 0 兼容。旧页面缺少 base_revision 的 PUT 返回 428，必须刷新到新版；不能回滚为无版本覆盖。原 `seqout-local-session` 不删除，待归属区备份也不自动清空。

当前仍为单写 Node 进程与 JSON 文件；没有将原子替换宣称为多实例数据库事务。账号历史单次最多 1000 会话，且受 Node 入口 1 MiB 请求上限约束；超限拒绝并保留已有数据。

### 云端消息

**本次没有连接或修改用户的线上 Supabase。** 上线新版云端消息写入前，在实际目标数据库应用：

```text
migrations/20261020_chat_message_metadata.sql
```

迁移为 nullable JSONB 增量列，不修改现有 RLS/授权。缺列时新写入会明确失败并保留页面内容，不会静默丢弃核验结果；应用迁移后可点击重试。旧消息读取使用兼容查询，没有 metadata 的旧记录按原样展示，不伪造历史核验结果。

平台生成 client/types 保持原样。`chatStore.ts` 使用局部应用 schema overlay 描述新列；实际平台重新生成类型后可去掉该 overlay。回退应用版本时保留 metadata 列及数据。

## 4. 本次验证

| 检查 | 结果与边界 |
|---|---|
| `npm test` | 148 项：147 通过、1 跳过、0 失败；跳过项为原有外部平台目录测试，需 `CYGNUSX_TEST_CATALOG_PATH` |
| `npm run typecheck` | 通过；范围为前端与 Vite 配置，后端由 Node 回归覆盖 |
| `npm run build` | 通过；仍有主 JS chunk 大于 500 kB 的既有类型提醒 |
| i18n | zh/en 各 416 键，集合相同，无重复 |
| 实际 Node HTTP | 新 `node-bridge.test.mjs` 启动真实 local.mjs 与假 LLM，验证共享密钥开启后账号可取目录/对话；游客与伪造内部头被拒绝；不访问外部 LLM |
| 本地账号浏览器 | Chromium + 实际 Node + 假 LLM/数据源：登录、流式两批卡片、账号历史同步、刷新恢复、退出与切账号均通过，无 pageerror |
| 主动停止浏览器 | 首批卡片后点击“停止生成”，保留一张卡和中断提示，宝藏计数为 1，未重复结算 |
| 云消息浏览器 | 使用正式构建的 Supabase 分支，拦截 Auth/REST/SSE 为 fixture：实际 service 发送 metadata，刷新/重选会话后核验提示和下载推荐恢复；不代表线上 Supabase 验收 |
| 临时 PostgreSQL 17 | 创建已有消息与测试 owner RLS，连续应用 migration 两次；旧正文保留，新 JSONB 可读写，A 可读自己的记录、B 不可读。证明迁移在测试 schema 上有效，不替代实际项目 RLS 验证 |

定向测试已接入现有 `npm test` glob：

- `server/tests/reliability.test.mjs`：版本冲突/幂等/持久化、旧历史、昵称、认证故障、身份分区、延迟恢复、并发合并、删除、卡片、分片 SSE、metadata、坏缓存、容量失败、HTTP LAN 的 UUID 兼容。
- `server/tests/node-bridge.test.mjs`：实际 HTTP bridge 与 handler 的认证组合。
- `server/tests/account-api.test.mjs`：原路径约束回归保留，历史写样例升级到协议 v2。

可选的云消息浏览器回归保存在 `scripts/tests/reliability-browser.mjs`，需要可用的 Playwright/Chromium 环境。它拦截全部测试 Auth/REST 与对话请求，不连接生产服务。复跑时先构建固定测试配置：

```sh
VITE_SUPABASE_URL=https://fixture.supabase.co \
VITE_SUPABASE_ANON_KEY=fixture-anon \
VITE_CHAT_API=http://127.0.0.1:18787 \
npm run build -- --outDir /tmp/treasure-cloud-dist

# 已安装 playwright 时直接执行；也可用 PLAYWRIGHT_MODULE 指向临时安装的 index.mjs。
node scripts/tests/reliability-browser.mjs
```

该脚本默认启动本机 19315 静态测试端口，结束后关闭。Playwright 未进入应用运行时依赖或锁文件。

## 5. 尚未声明完成的线上验收

- 实际目标 Supabase 的迁移应用与 A/B 用户 RLS 回归；没有凭据或明确目标时不能据本地测试宣称已完成。
- 生产 Docker 重建和数据卷恢复；本次没有替换或重启用户的实际部署。
- 真实外部 LLM、数据源、直接 Deno Edge、CygnusX 平台联合验收；本次没有修改 GSE 映射/文献适配器，不运行与本次修复无关的 live 数据源请求。
- 独立科研论文/分析工作流能力未在本次范围内。

这些边界不影响仓库内修复代码和可复跑回归的交付，但上线前必须按实际使用的模式补验。需要回退时保留新分区/备份与 metadata，不重新开放旧版无版本历史写入。
