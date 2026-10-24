// config.ts：Agent 运行时行为的集中配置单点。
//
// 设计约束（spec）：
// - 同名配置只在 config.ts 出现定义，其余模块一律 import 消费，禁止散落硬编码；
// - 全部经 AGENT_* 环境变量可覆盖，非法值（非数字/越界）钳制回默认，不猜不抛；
// - env 读取统一走 envGet（Deno/Node 双运行时）；禁止 any。
//
// 提示：行为语义与原实现保持一致（如触顶提示在 maxTurns-1 轮联动下发），
// 调整上限只改环境变量即可，无需改代码。

import { envGet } from './shared.ts';

export interface AgentConfig {
  /** tool-calling 轮次上限；触顶提示在 maxTurns-1 轮联动下发（AGENT_MAX_TURNS，默认 40） */
  maxTurns: number;
  /** 送模型的历史条数（system 消息不计），超出取最近（AGENT_HISTORY_WINDOW，默认 16） */
  historyWindow: number;
  /** 单轮 LLM 请求超时毫秒数（与客户端断连信号 any 合并）（AGENT_LLM_TIMEOUT_MS，默认 90000） */
  llmTimeoutMs: number;
  /** SSE 心跳间隔毫秒数（防代理缓冲）（AGENT_HEARTBEAT_MS，默认 10000） */
  heartbeatIntervalMs: number;
  /** LLM 输入瘦身上限字符数（AGENT_TRIM_LIMIT，默认 100000） */
  trimLimit: number;
  /** 单次 grounding 回源核验上限（AGENT_GROUNDING_VERIFY_LIMIT，默认 5） */
  groundingVerifyLimit: number;
  /** 游客本地会话数量上限（AGENT_GUEST_SESSION_LIMIT，默认 50） */
  guestSessionLimit: number;
  /** 游客本地会话过期天数（读取时过滤）（AGENT_GUEST_TTL_DAYS，默认 7） */
  guestSessionTtlDays: number;
  /** 登录历史快照同步防抖毫秒数（AGENT_HISTORY_SYNC_DEBOUNCE_MS，默认 800） */
  historySyncDebounceMs: number;
  /** 使用统计内存护栏：超过后不再记录新 actor（AGENT_MAX_ACTORS，默认 20000） */
  maxTrackedActors: number;
}

/** 默认值单点定义（文档与 .env.example 引用此处，勿在别处复写字面量） */
export const CONFIG_DEFAULTS: Readonly<AgentConfig> = {
  maxTurns: 40,
  historyWindow: 16,
  llmTimeoutMs: 90_000,
  heartbeatIntervalMs: 10_000,
  trimLimit: 100_000,
  groundingVerifyLimit: 5,
  guestSessionLimit: 50,
  guestSessionTtlDays: 7,
  historySyncDebounceMs: 800,
  maxTrackedActors: 20_000,
};

/** 各项的合法区间（含边界）；env 值超出区间时钳制到边界，非法解析回退默认 */
const CONFIG_BOUNDS: Record<keyof AgentConfig, { min: number; max: number }> = {
  maxTurns: { min: 1, max: 200 },
  historyWindow: { min: 2, max: 200 },
  llmTimeoutMs: { min: 1000, max: 600_000 },
  heartbeatIntervalMs: { min: 1000, max: 120_000 },
  trimLimit: { min: 1000, max: 1_000_000 },
  groundingVerifyLimit: { min: 0, max: 50 },
  guestSessionLimit: { min: 1, max: 500 },
  guestSessionTtlDays: { min: 1, max: 365 },
  historySyncDebounceMs: { min: 0, max: 60_000 },
  maxTrackedActors: { min: 100, max: 1_000_000 },
};

const ENV_NAMES: Record<keyof AgentConfig, string> = {
  maxTurns: 'AGENT_MAX_TURNS',
  historyWindow: 'AGENT_HISTORY_WINDOW',
  llmTimeoutMs: 'AGENT_LLM_TIMEOUT_MS',
  heartbeatIntervalMs: 'AGENT_HEARTBEAT_MS',
  trimLimit: 'AGENT_TRIM_LIMIT',
  groundingVerifyLimit: 'AGENT_GROUNDING_VERIFY_LIMIT',
  guestSessionLimit: 'AGENT_GUEST_SESSION_LIMIT',
  guestSessionTtlDays: 'AGENT_GUEST_TTL_DAYS',
  historySyncDebounceMs: 'AGENT_HISTORY_SYNC_DEBOUNCE_MS',
  maxTrackedActors: 'AGENT_MAX_ACTORS',
};

/**
 * 纯函数解析配置：env 缺省取默认；可解析为有限数字则钳制到 [min, max] 取整；
 * 非法（NaN/非数字/空串）一律回默认。导出供测试离线注入 env。
 */
export function resolveAgentConfig(env: (key: string) => string): AgentConfig {
  const out = {} as Record<keyof AgentConfig, number>;
  for (const key of Object.keys(CONFIG_DEFAULTS) as (keyof AgentConfig)[]) {
    const def = CONFIG_DEFAULTS[key];
    const { min, max } = CONFIG_BOUNDS[key];
    const raw = env(ENV_NAMES[key]);
    const n = raw === '' ? NaN : Number(raw);
    if (Number.isFinite(n)) out[key] = Math.min(max, Math.max(min, Math.round(n)));
    else out[key] = def;
  }
  return out as AgentConfig;
}

/** 进程级单例：模块加载时求值一次，运行期保持稳定（与原实现行为一致） */
export const agentConfig: AgentConfig = resolveAgentConfig(envGet);