# Paper → Data → Analysis：实施、接口与测试记录

> 注：island 实验已于 2026-10-18 归档至 `archive/island/`，契约类型迁 `src/presentation-contract.ts`；下文为归档前记录。

日期：2026-10-17；分支：`feat/paper-data-analysis`。配套 [审计](paper-to-analysis-audit.md) 与 [ADR](paper-to-analysis-adr.md)。

## 交付范围

已完成只读架构调查、复用边界与接口草案，以及第一条**离线 PDF → 原文证据索引**链路。尚未完成产品 MVP；Phase 1–5 均未通过整阶段验收。没有新增公开 HTTP 路由、论文上传 UI、模型解读、数据库核验或执行能力。

新增文件：

- `scripts/paper_evidence.py`：复用上级平台 PDFProcessor，生成页文本、启发式章节、编号/DOI/显式 PMID 提及、精确原文字符范围。
- `scripts/tests/test_paper_evidence.py`：12 项离线契约、来源身份、编号边界和失败测试。
- `scripts/tests/test_paper_pdf_integration.py`：5 项既有解析器集成测试；依赖缺失时明确 skip，真实论文测试另需 `PAPER_TEST_PDF`。
- ARC 文档三份与索引入口。未修改平台上传、权限、任务、数据库适配器或报告服务。
- `src/island/PaperWorkspace.tsx` 与 `contract.ts`：平台传入真实 view model 后展示四个工作区标签、证据定位和 A/B/C/未核验标记；action 仅回传受限意图，不直接执行任务。
- `src/island/paperEvidence.ts`：将 `paper-evidence.v1` 索引转换为受控工作区；核对 Unicode 码点偏移、quote、来源绑定的证据哈希、编号与片段一致性、引用完整性。离线输入声称已核验/A/B/C 时拒绝，方案与工作流保持空。内部一致性校验不等于已验证 PDF 来源真实性。
- `src/island/tests/paperEvidence.test.ts`：7 项接入与失败测试，包含真实 Python 索引跨语言接入。

## 离线 CLI 接口

从寻宝鼠根目录运行，使用**已有 OmicHub 虚拟环境**，不要求安装新的依赖：

```sh
../../.venv/bin/python scripts/paper_evidence.py /absolute/path/paper.pdf \
  --output /tmp/paper-evidence.json
```

输入仅支持显式选定的本地 PDF；不抓取 URL、不接受 DOI/PMID 代替文件。20 MiB、200 页、2,000,000 字符上限；检查 PDF 签名、加密状态和真实页数。解析使用所读取字节的临时快照，文件 SHA256 与解析源一致。现有输出文件拒绝覆盖。返回码 0 表示索引成功生成（仍可能 partial/needs_ocr），1 表示失败；消费者必须读取 JSON 状态，不能把返回码 0 当成完整论文解读。

输出 `paper-evidence.v1`：

| 字段 | 语义 |
|---|---|
| `source` | 文件 SHA256、实际解析器与 fallback_reason；不是已落库 FileRecord |
| `extraction_status` | succeeded / partial / needs_ocr / failed，仅指文字提取 |
| `interpretation_status` | 固定 not_started，未进行科学解读 |
| `pages` | 解析器原始文本与一基页码；空白/缺页另列 possible_ocr_pages |
| `sections` | 独立标题行启发式定位；不保证完整结构、作者/方法字段解析 |
| `evidence` | 来源绑定 ID、页码、章节、quote/context；start/end 为页文本的 Unicode 码点偏移，end 不含尾字符 |
| `mentions` | 去重规范标识、证据 ID；固定 mention_only / not_checked / match_tier=null |
| `gaps` | 未做深度解读、数据库核验、图表布局，以及缺页/截断/无编号等实际缺口 |

证据 ID 为 `SHA256(schema_version:source_sha256:page:start:end)`。JS 消费者不得直接把码点偏移用于 UTF-16 `String.slice()`，应使用码点数组或重新定位；图表坐标、figure、table 均为 null。DOI 是候选字符串，并未回源核验；显式 `PMID:数字` 才提取，避免将正文数字猜成 PMID。断行、复杂排版或其他引用格式仍可能漏检。

本地 CLI 不提供生产进程隔离、队列超时或并发配额。生产必须由平台 Task/worker 施加资源限制；不能直接作为公开上传处理器使用。超限或损坏文件在 CLI 返回错误；权限隔离、任意 URL 获取和项目归属尚未实现，应在平台接入时验证。

## 已运行的测试

| 检查 | 本次结果 | 能证明什么 |
|---|---|---|
| 平台 `.venv/bin/python -m unittest discover -s scripts/tests -v`，设置真实 PAPER_TEST_PDF | **17/17 通过，无 skip** | 证据契约 + 真实解析器 + 本地真实论文 |
| `npm test` | **13 个测试文件通过，0 失败** | 主仓库原有离线回归；不覆盖新 Python 代码 |
| 原有测试以 `node --test --test-isolation=none` 复跑 | **86 通过、1 skip、0 失败** | 确认执行实际断言；skip 为原有平台 catalog 集成测试 |
| `PAPER_TEST_INDEX=... node src/island/tests/paperEvidence.test.ts` | **7/7 通过，无 skip** | 真实索引接入、篡改、错误归属、悬空引用与 Unicode 偏移 |
| `npx tsc --noEmit` | 通过 | 当前工作树前端类型检查 |
| `npx vite build` | 通过 | 当前工作树构建；有大于 500 kB chunk 提醒 |
| `npx vite build --config vite.island.config.ts` | 通过 | 真正包含论文工作区的独立 island 产物；有大 chunk 提醒 |
| 浏览器 DOM smoke | **环境阻断，未通过验收** | 本地 HTTP socket 创建被拒绝；Chromium 启动因 setsockopt 权限失败 |
| 上传 API / 真实数据库核验 / 工作流执行 / BioReport / 完整浏览器 E2E | **未运行、未通过验收** | 不作端到端完成声明 |

可复跑命令（从子仓根目录，真实 PDF 使用父仓已有测试文件）：

```sh
python3 -m unittest discover -s scripts/tests -v
# 上一命令没有平台依赖时：12 通过，5 明确 skip，不等于集成通过。

PAPER_TEST_PDF='../../tests/data/A cellular and spatial atlas of TP53-associated tissue remodeling defines a multicellular tumor ecosystem in lung adenocarcinoma.pdf' \
  ../../.venv/bin/python -m unittest discover -s scripts/tests -v

PAPER_TEST_INDEX=/tmp/paper-evidence-real-20261017-v2.json \
  node src/island/tests/paperEvidence.test.ts
# 不设置 PAPER_TEST_INDEX 时：6 通过，真实索引测试明确 skip。

node --test --test-isolation=none functions/seqout-chat/tests/*.test.ts server/tests/*.test.mjs
```

本机 Node v24.11.0 的默认隔离测试输出仅列文件级通过；额外使用 `--test-isolation=none` 核对实际断言。上表区分文件数和用例数，不把 13 个文件误报为全部用例。当前运行没有修改既有测试启动脚本。

实际解析：论文 *A cellular and spatial atlas of TP53-associated tissue remodeling defines a multicellular tumor ecosystem in lung adenocarcinoma*，62 页；`PDFProcessor/pypdf`，fallback 原因 `rollout_skip`。SHA256：`268c64659660f84aa7f4238dde5940d4073ea3b6182c2376e80322351f984253`。

得到 8 个去重标识、11 处证据；每个片段均逐一验证 `page_text[start:end] == quote`，并重算证据 ID。GSE123904、HRA000154、GSE152607、GSE161824 位于 PDF 第 20 页，仍只声明“提及”；未据此断言原始数据、访问权限或适用性。DOI 后括号及引用序号的真实误提取已修复并加入回归测试。第 40 页识别到 Data availability / References 标题，章节仅为启发式。

本机临时产物 `/tmp/paper-evidence-real-20261017-v2.json`；校验摘要 `/tmp/paper-evidence-validation-20261017.json`。这些不是平台 Artifact，不是持久报告；完整论文文本未提交至仓库。

实际异常测试：

- 真实生成的空白 PDF：needs_ocr，possible_ocr_pages=[1]，不伪称完成 OCR。
- 真实生成的加密 PDF：在 PDFProcessor 前拒绝。
- 真实生成的 201 页 PDF：在 PDFProcessor 前拒绝超限。
- 带 PDF 签名但正文损坏的文件：pypdf 抛 PdfReadError 子类，CLI 返回失败；其 stderr 的 EOF 提醒为预期损坏样本输出。
- 错误签名和超过 20 MiB：离线测试验证调用解析器前拒绝。
- 无编号、缺页、截断、parser 失败、正文包含指令：状态明确，不生成任务，不把文本当指令。

论文工作区目前是受控展示组件：没有 `paperWorkspace` view model 时不会自行显示，也不会从 PDF 文本推断任务或数据库结果。当前 Vue/FastAPI 适配器尚未传入该 view model，因此本次无法声称浏览器中已完成论文上传、轮询或四标签端到端验收。

平台消费离线索引的示例：`const view = await paperEvidenceToWorkspace(index, title)`，再传入 `paperWorkspace`；`mount` 入口已导出该转换函数。失败抛错，由 Vue 的错误状态承接。该格式只支持文本提取，工作区显示“尚未科学解读/数据库核验”提示，不接受来自文档的计划或任务字段。

首页四卡片仍保留当前可用的文献检索文案与普通文本输入提示。产品上传/深度解读链路未接通前，不发布“上传 PDF”示例或支持上传的输入提示；用户要求的新入口文案在平台链路完成时同步启用。

浏览器尝试的隔离临时页面位于 `/tmp/treasure-island-poc-lib/paper-smoke.html`，加载真实解析索引而非模拟论文结果。`python3 -m http.server` 在 socket 创建阶段报 `Operation not permitted`；直接启动已有 Chromium 同样因 `setsockopt` 被拒绝（退出码 133）。没有得到 DOM 或截图，不计任何浏览器通过项；当前权限配置禁止提权，因此未绕过限制。

## 追加验证：输入分类与存在性核验

`src/island/paperInput.ts` 提供 PDF / DOI / PMID / HTTPS URL / 自然问题分类，导出给平台适配层；这不是上传或全文获取服务。PDF 选择检查非空、20 MiB 与扩展名/MIME，服务端仍须检查真实签名和权限。4 项边界测试通过。

`Composer` 在 `paperMode` 下显示 PDF 选择按钮，并通过 `paper.input` action 回传原始 `File`；没有 `paperMode` 时保留原有纯文本聊天界面。平台必须在 action 接收处执行项目鉴权、FileRecord 归属绑定、上传大小/类型校验和异步任务创建；React island 不执行网络请求。新增 action 契约测试通过，主应用与独立 island 构建均通过。

`verifyPaperMentions()` 复用现有 `verifyAccession()`，每次最多 20 个编号，异常保留 unknown，结果始终为 mention_only、matchTier=null。它没有注册 HTTP 路由，也未暴露为模型工具。存在性不能证明论文使用关系；A/B/C、补充材料和适用性尚未实现。

`scripts/paper_trace.mjs` 验证原文索引内部一致性后运行限量核验，写入新的、拒绝覆盖的 trace JSON；保留文件 SHA256、证据引用、核验时间、来源端点及延期条目。它复用现有只读适配器，没有再造数据库适配器。

```sh
node scripts/paper_trace.mjs /tmp/paper-evidence-real-20261017-v2.json \
  --output /tmp/paper-trace-real-20261017.json
node --test --test-isolation=none functions/seqout-chat/tests/*.test.ts server/tests/*.test.mjs src/island/tests/*.test.ts scripts/tests/*.test.mjs
# 或仅跑论文边界测试：npm run test:paper
```

真实论文核验尝试产物 `/tmp/paper-trace-real-20261017.json`：8 entries，0 exists、0 missing、8 unknown。只能证明调用链执行并保留不确定状态，不能证明数据库核验成功。无稳定通道（如 HRA）及网络/上游不可用均可能产生 unknown，当前适配器不细分原因。浏览工具的补充访问未返回结果，已终止等待，不作来源证据。

合并回归：本轮新增输入入口后，`npm run test:paper` 共 15 项，14 通过、1 skip；主仓库完整回归需按前述命令复跑。此前合并回归为 104 项，103 通过、1 skip、0 失败。真实索引此前单独以环境变量运行 7/7 通过。本次新增核验边界测试 2 项、trace 3 项、输入分类 4 项和 action 1 项；类型检查与两种构建通过。Phase 1–5 仍未完成。

## 平台接续清单

追加复核：Europe PMC 的 `hitCount` 缺失、非数字、负数或非整数时，现有核验器此前会误判 missing；现已改为 unknown，并覆盖异常响应回归。设置真实 PAPER_TEST_INDEX 后合并回归共 104 项，103 通过、1 项既有平台 catalog 集成 skip、0 失败。`npx tsc --noEmit`、主应用构建与 `git diff --check` 通过；构建仍提示大 chunk。完整目标仍未通过验收。

阻断审计：主平台 Vue/FastAPI/队列/数据库文件位于当前允许写入根之外，该条件已连续多轮未改变；浏览器 socket 权限限制亦未解除。下一步需要在允许写入 OmicHub 主平台且可运行浏览器和服务的工作区接续。不能通过增加子仓平行上传、队列或执行系统替代既有架构集成。

1. 在**允许写入上级 OmicHub 的工作区**接续。当前会话写入范围仅包括子仓和 `/tmp`；Vue/FastAPI/DB/队列集成无法在此落盘。现有未提交工作已保留。
2. 主平台增加经项目鉴权的 PaperDocument/PaperRevision，复用 FileRecord/Artifact、Task 与现有队列。落地审计中明确标为“提议”的 API；先验收所有者隔离、上传限制、失败与部分成功，再接 Vue 上传和 React 四标签。
3. 补 DOI/PMID 元数据与全文获取、可靠的论文结构化解读；有原文证据才生成结论，全文不可得必须保留 metadata_only。首页文案与真实可用能力同步发布。
4. 复用既有数据库适配器核验、发现补充材料，保留核验时间/来源/错误；实现 A/B/C 与“未确认提及”证据规则并实测防误归属。
5. 将真实 DatasetVersion 元数据与论文方法证据绑定既有 ResearchPlan 版本，复用 DAG/审核摘要。明确推荐、假设、统计风险和缺失参数。
6. 当前 `WRITE_RUNTIME_ACCEPTED=False` 不能绕过；须完成平台写运行验收，再验证批准后真实任务、失败传播、FlowFrame 和 BioReport/Manifest 闭环。
7. 分阶段补齐 API、权限、真实数据库与任务运行测试；最后以浏览器桌面/移动/明暗及完整真实 E2E 验收。当前类型、构建、单元及离线 PDF 集成结果不能代替这些证据。
