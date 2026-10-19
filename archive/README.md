# archive/ 历史归档区

本目录收纳已停止维护或已完成历史使命的项目副本与实验产物。归档日期：2026-10-18（仓库目录整理，spec 见 `.codeartsdoer/specs/repo_structure_cleanup/`）。

**归档区约定**：

- 只进不出：新归档物移入本目录后不再迭代，内容保持归档时点的冻结快照（零翻新、零裁剪）。
- 恢复维护需先迁出：如需重启任一条目，先将该目录整体移回仓库根（或合适位置）并恢复对应构建配置引用，再动内容。
- 内部文档以归档时仓库快照为准：归档物内部的 README / AGENTS / MIGRATION 中对主仓库（`../`）的相对引用，按归档前的目录结构理解；主仓库仍在迭代，快照描述可能与现状有出入。

## 条目说明

| 条目 | 原路径 | 来历 | 状态 | 注意事项 |
|---|---|---|---|---|
| `qmuse/` | `qmuse/` | 本应用的 QMuse 平台迁移版（Supabase→QMuse 云服务、Edge Function→云函数、SSE→整包模拟流式） | 2026-10-06 起停止维护；2026-10-18 归档 | **勿删**红线仍生效；`qmuse-app/AGENTS.md` 的约束在新路径下继续适用 |
| `weixin/` | `weixin/` | 微信小程序版工作区（Taro 4.3 + React 18 首轮可编译工程） | 未在微信开发者工具/真机验证；2026-10-18 归档 | 内部 `../qmuse/` 引用因同级归档保持有效；`../` 指主仓库的表述按快照理解 |
| `crawler/` | `crawler/` | T1 捉虫休眠模块最小骨架（Python 三态状态机 + 指数退避） | 非运行链路、无构建引用；2026-10-18 归档 | 无 |
| `island/` | 根目录 4 个配置文件 + `src/island/` + `scripts/paper_trace.mjs` 等 | CygnusX 展示 Island 隔离实验（未发布，G-P1A 未通过） | 未发布；2026-10-18 归档 | **typecheck 覆盖缩围**：`src/island/` 移出后 `tsconfig.json` 的 `src/**/*` 不再检查 island 代码，属预期；共享契约类型已迁 `src/presentation-contract.ts`；`scripts/paper_evidence.py` 及两个 pytest 仍留守 `scripts/`（无 island 依赖、独立可用）；归档内 `paper_trace.mjs` 对 `src/island/paperEvidence.ts` 的 import 断裂属快照预期 |

## 新旧路径映射

| 旧路径 | 新路径 |
|---|---|
| `qmuse/` | `archive/qmuse/` |
| `weixin/` | `archive/weixin/` |
| `crawler/` | `archive/crawler/` |
| `island-reference.html` | `archive/island/island-reference.html` |
| `tsconfig.island.json` | `archive/island/tsconfig.island.json` |
| `vite.island.config.ts` | `archive/island/vite.island.config.ts` |
| `vite.island-reference.config.ts` | `archive/island/vite.island-reference.config.ts` |
| `src/island/` | `archive/island/src/island/` |
| `scripts/paper_trace.mjs` | `archive/island/scripts/paper_trace.mjs` |
| `scripts/tests/paperTrace.test.mjs` | `archive/island/scripts/tests/paperTrace.test.mjs` |

另：`src/presentation-contract.ts` 为归档时从 `src/island/contract.ts` 迁出的共享契约类型（活代码区唯一演化源）；本地构建产物 `dist/`、`.tsbuildinfo` 于同批删除（可由 build/typecheck 再生成）。