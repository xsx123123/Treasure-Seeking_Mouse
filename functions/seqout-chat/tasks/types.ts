// tasks/types.ts：消息排队与后台任务持续执行的领域类型与常量单一事实源。
// 模块红线：tasks/ 目录禁止反向 import 主文件 index.ts（deps 函数指针注入，对齐 protocols/ 契约）；
// 既有类型统一从 ../shared.ts 引入（Json/GroundingReport），不复制第二份。
import type { Json, GroundingReport } from '../shared.ts';
import type { ParseIntentResult, ResearchIntent } from '../intent.ts';

/* ---------- 身份归属 ---------- */

/** 三类身份（与排行榜/历史存储同一身份源）：平台登录用户 / 游客设备指纹 / 自托管本地账号 */
export type OwnerKind = 'supabase_user' | 'guest_device' | 'local_account';

/**
 * 任务归属主体。equals/storageKey 语义：
 * - equals：kind 与 id 逐值相等（归属四校验点——创建/续传/拉取/取消——统一单点比较，registry.ts 实现）；
 * - storageKey：`${kind}:${id}`，存储层 owner_kind/owner_id 两列的逻辑拼接形（FileTaskStore 内存索引键）。
 */
export interface OwnerRef {
  kind: OwnerKind;
  id: string;
}

/* ---------- 任务状态机 ---------- */

/** 对外七态（协议面唯一暴露集合）；suspended 是 ChatTask 上的独立布尔标记位，不进入本枚举 */
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

/** 失败类别四值（与 chat_tasks.error CHECK 约束逐字一致） */
export type TaskErrorKind = 'llm_error' | 'timeout' | 'aborted' | 'service_restart';

/** 终态集合：迁移不可逆（updateStatus 条件迁移由 store 实现保证） */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled', 'expired'];

/** 活跃态集合：计入并发上限、触发会话内串行约束 */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['queued', 'running'];

/* ---------- 任务数据 ---------- */

/** 主循环消费的消息形态（OpenAI 对话格式 + 工具消息；与 index.ts ChatMsg 同构） */
export interface ChatHistoryMessage {
  role: string;
  content: string | null;
  tool_calls?: Json;
  tool_call_id?: string;
  name?: string;
}

/** 创建即冻结：提问 + 当时历史（断连独立续跑所需；随终态窗口清理） */
export interface QuestionSnapshot {
  content: string;
  history: ChatHistoryMessage[];
}

/** 续跑重建用的轮摘要：每轮 assistant 文本 + 工具调用名/参数/结果摘要（trimForLLM 输出） */
export interface RoundDigest {
  assistant: string;
  toolCalls: { name: string; args: string; resultSummary: string }[];
}

/** running 期间里程碑快照；终态后被 result 取代（两者清其一） */
export interface ProgressSnapshot {
  content: string;
  cards: Json[];
  tools: ToolLogEntry[];
  grounding: GroundingReport | null;
  boost: { accession: string | null } | null;
  rounds: RoundDigest[];
  /** 截断护栏标记：rounds 超限丢最旧轮时置位 */
  rounds_truncated?: boolean;
  /** 事件序号水位（snapshot 生成时刻） */
  seq: number;
}

/** 工具日志条目（与主循环 toolLogs 内联形态一致；任务组 5 迁出后由 runner 消费） */
export interface ToolLogEntry {
  name: string;
  label: string;
  ok: boolean;
  ms: number;
  intent?: ResearchIntent;
  notes?: string[];
}

/** 终态完整结果（result 拉取载荷的存储形） */
export interface TaskResult {
  content: string;
  cards: Json[];
  toolLogs: ToolLogEntry[];
  grounding: GroundingReport | null;
  boost: { accession: string | null } | null;
  error: string | null;
}

/** 任务事件（环形缓冲元素；缓冲纯内存不落盘） */
export interface TaskEvent {
  seq: number;
  frame: Json;
  at: number;
}

/** 任务实体（与 chat_tasks 表列一一对应；FileTaskStore 落盘同形） */
export interface ChatTask {
  task_id: string;
  owner: OwnerRef;
  session_ref: string;
  /** 客户端防重键；null = 旧前端直接发起 */
  queue_id: string | null;
  status: TaskStatus;
  /** Edge 分段续跑挂起标记（内部位，协议面不暴露） */
  suspended: boolean;
  lang: 'zh' | 'en';
  question_snapshot: QuestionSnapshot;
  progress_snapshot: ProgressSnapshot | null;
  result: TaskResult | null;
  error: TaskErrorKind | null;
  /** 执行实例标识（Node=启动时间戳+pid 哈希；Edge=isolate 模块级随机值），孤儿判定依据 */
  instance_id: string;
  heartbeat_at: number;
  created_at: number;
  finished_at: number | null;
  expires_at: number | null;
}

/* ---------- 排队消息（前端草稿级概念，不进服务端表；与前端 taskQueue 同构，design §2.2.2-E） ---------- */

export type QueueItemStatus = 'queued' | 'cancelled' | 'promoted' | 'drafted';

export interface QueuedMessage {
  queue_id: string;
  session_ref: string;
  content: string;
  enqueued_at: number;
  status: QueueItemStatus;
}

/* ---------- 协议帧名与缓冲常量 ---------- */

/** SSE 新增帧名（协议只加不改：既有 delta/tool/cards/grounding/end/error/[DONE]/心跳冻结） */
export const TASK_EVENT_NAMES = { task: 'task', snapshot: 'snapshot' } as const;

/** 续传环形缓冲：每任务最近 200 帧、总字符 ≤200KB（超限丢最旧帧） */
export const TASK_EVENT_BUFFER_SIZE = 200;
export const TASK_EVENT_BUFFER_BYTES = 200_000;

/* ---------- 配置默认值（design §2.4 单一事实源；envGet 读取点在 registry/runner，此处仅定义默认） ---------- */

/** 单会话排队上限（前端 VITE_QUEUE_MAX_PER_SESSION 覆盖，1–50 钳制） */
export const QUEUE_MAX_PER_SESSION = 10;
/** 单身份并发活跃任务上限（TASK_MAX_CONCURRENT_PER_OWNER 覆盖，1–10 钳制，经能力位下发前端） */
export const TASK_MAX_CONCURRENT_PER_OWNER = 3;
/** 任务硬超时 30min（TASK_HARD_TIMEOUT_MS 覆盖，≥60s 钳制） */
export const TASK_HARD_TIMEOUT_MS = 1_800_000;
/** 终态结果保留窗口 24h（TASK_RESULT_TTL_MS 覆盖，≥1h 钳制） */
export const TASK_RESULT_TTL_MS = 86_400_000;
/** Edge 挂起预算余量阈值（部署前按实测校准） */
export const TASK_EDGE_SUSPEND_HEADROOM_MS = 15_000;
/* ---------- 主循环依赖注入接口（runner 禁 import 主文件，deps 函数指针打包传入） ---------- */

export interface ToolCallLike {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** LLM 单轮结果：ok=false 时 status 为上游状态码 */
export interface LlmRoundResult {
  ok: boolean;
  status?: number;
  text?: string;
  toolCalls?: ToolCallLike[];
  sawDone?: boolean;
}

/**
 * runChatLoop 的依赖包：index.ts 在创建任务/降级路径时打包传入。
 * 覆盖主循环对主文件的全部耦合点（统计/工具执行/卡片抽取/grounding/补链/兜底卡片）。
 */
export interface ChatLoopDeps {
  /** 单轮 LLM 调用：内部发 delta 经 onDelta、聚合 tool_calls、计 llmCalls 与 token 用量 */
  llmRound: (messages: ChatHistoryMessage[], onDelta: (text: string) => void, signal: AbortSignal) => Promise<LlmRoundResult>;
  executeTool: (name: string, args: Record<string, Json | undefined>) => Promise<Json>;
  platformHas: (name: string) => boolean;
  platformCall: (name: string, args: Record<string, Json | undefined>, signal: AbortSignal) => Promise<Json>;
  labelOf: (name: string) => string;
  extractCards: (name: string, payload: Json) => Json[];
  trimForLLM: (payload: Json) => string;
  parseIntent: (raw: unknown) => ParseIntentResult;
  hasRuns: (prj: string) => Promise<boolean>;
  isBusinessEmpty: (payload: Json | null) => boolean;
  needsLiteratureFollowup: (opts: { cards: Json[]; intentNeedsLiterature: boolean; userText: string; literatureAlreadySearched: boolean }) => boolean;
  searchAllLiterature: (args: Record<string, Json | undefined>) => Promise<Json>;
  wrapLit: (data: Json) => Json;
  groundingCheck: (text: string, cards: Json[]) => Promise<GroundingReport>;
  /** 工具调用统计写入点（全局 usageStats 的收敛回调） */
  trackToolStart: (name: string) => void;
  trackToolEmpty: (name: string) => void;
  trackToolError: (name: string) => void;
  /** 主循环常量（避免 runner import 主文件） */
  intentToolName: string;
  literatureToolName: string;
  downloadLinkTools: ReadonlySet<string>;
  logPrefix: string;
}

export interface ChatLoopArgs {
  model: string;
  /** 含 system 的完整消息数组（循环内原地追加 assistant/tool 消息，与迁出前形态一致） */
  messages: ChatHistoryMessage[];
  /** 用户历史（文献补链的 lastUserMsg 判定源） */
  history: ChatHistoryMessage[];
  lang: 'zh' | 'en';
  requestId: string;
  startTime: number;
  /** Edge 唤醒续跑时的既有轮摘要（续跑起点在其后继续） */
  initialRounds?: RoundDigest[];
  /** 续跑起始轮次（挂起点下一轮；缺省 0） */
  startRound?: number;
}

export interface ChatLoopOutcome {
  fullText: string;
  allCards: Json[];
  toolLogs: ToolLogEntry[];
  aborted: boolean;
  rounds: RoundDigest[];
  /** Edge 预算挂起：beforeRound 哨兵触发时置位（未走终态帧，由调用方落完整快照 + suspended 标记） */
  suspended?: boolean;
}

export type EmitFn = (frame: Json) => void;

/** 轮前哨兵：返回 'suspend' 时主循环在本轮开始前收口挂起（Edge 预算管理）；onRound 同步轮摘要给快照层 */
export interface ChatLoopHooks {
  beforeRound?: (round: number) => 'suspend' | 'continue';
  onRound?: (digest: RoundDigest) => void;
}

/** Edge wall-clock 预算总量（保守值，部署前按 §2.7 实测校准 TASK_EDGE_SUSPEND_HEADROOM_MS 与本值） */
export const TASK_EDGE_WALL_BUDGET_MS = 140_000;