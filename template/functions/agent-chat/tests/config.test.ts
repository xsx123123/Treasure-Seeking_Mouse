// config.ts 钳制测试（离线纯函数，零网络）
// 运行：node --test functions/agent-chat/tests/config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG_DEFAULTS, resolveAgentConfig } from '../config.ts';

const envOf = (map: Record<string, string>) => (key: string) => map[key] ?? '';

test('默认值：env 为空时逐项等于 CONFIG_DEFAULTS', () => {
  const cfg = resolveAgentConfig(envOf({}));
  for (const key of Object.keys(CONFIG_DEFAULTS) as (keyof typeof CONFIG_DEFAULTS)[]) {
    assert.equal(cfg[key], CONFIG_DEFAULTS[key], `${key} 默认值不符`);
  }
});

test('合法覆盖：env 提供合法值时生效', () => {
  const cfg = resolveAgentConfig(envOf({
    AGENT_MAX_TURNS: '12',
    AGENT_HISTORY_WINDOW: '8',
    AGENT_LLM_TIMEOUT_MS: '30000',
    AGENT_HEARTBEAT_MS: '5000',
    AGENT_TRIM_LIMIT: '20000',
    AGENT_GROUNDING_VERIFY_LIMIT: '0',
    AGENT_GUEST_SESSION_LIMIT: '100',
    AGENT_GUEST_TTL_DAYS: '30',
    AGENT_HISTORY_SYNC_DEBOUNCE_MS: '200',
    AGENT_MAX_ACTORS: '5000',
  }));
  assert.equal(cfg.maxTurns, 12);
  assert.equal(cfg.historyWindow, 8);
  assert.equal(cfg.llmTimeoutMs, 30000);
  assert.equal(cfg.heartbeatIntervalMs, 5000);
  assert.equal(cfg.trimLimit, 20000);
  assert.equal(cfg.groundingVerifyLimit, 0);
  assert.equal(cfg.guestSessionLimit, 100);
  assert.equal(cfg.guestSessionTtlDays, 30);
  assert.equal(cfg.historySyncDebounceMs, 200);
  assert.equal(cfg.maxTrackedActors, 5000);
});

test('非法值（非数字/空串/NaN 字面量）回默认；负数钳到下限边界', () => {
  const cfg = resolveAgentConfig(envOf({
    AGENT_MAX_TURNS: 'abc',
    AGENT_LLM_TIMEOUT_MS: '',
    AGENT_TRIM_LIMIT: 'NaN',
    AGENT_GUEST_TTL_DAYS: 'null',
    AGENT_HISTORY_WINDOW: '-4',
  }));
  assert.equal(cfg.maxTurns, CONFIG_DEFAULTS.maxTurns, '非数字回默认');
  assert.equal(cfg.llmTimeoutMs, CONFIG_DEFAULTS.llmTimeoutMs, '空串回默认');
  assert.equal(cfg.trimLimit, CONFIG_DEFAULTS.trimLimit, 'NaN 字面量回默认');
  assert.equal(cfg.guestSessionTtlDays, CONFIG_DEFAULTS.guestSessionTtlDays, 'null 字面量回默认');
  assert.equal(cfg.historyWindow, 2, '负数是有限数字，钳到下限 2（钳制语义一致）');
});

test('越界值钳制到边界（不回默认）', () => {
  const cfg = resolveAgentConfig(envOf({
    AGENT_MAX_TURNS: '99999',
    AGENT_HISTORY_WINDOW: '1',
    AGENT_HEARTBEAT_MS: '10',
    AGENT_GUEST_SESSION_LIMIT: '0.4',
  }));
  assert.equal(cfg.maxTurns, 200, '超上限钳到 200');
  assert.equal(cfg.historyWindow, 2, '低于下限钳到 2');
  assert.equal(cfg.heartbeatIntervalMs, 1000, '低于下限钳到 1000');
  assert.equal(cfg.guestSessionLimit, 1, '小数钳到下限 1（round + clamp）');
});

test('小数合法值向下取整到合法区间', () => {
  const cfg = resolveAgentConfig(envOf({ AGENT_MAX_TURNS: '7.9', AGENT_TRIM_LIMIT: '1050.6' }));
  assert.equal(cfg.maxTurns, 8);
  assert.equal(cfg.trimLimit, 1051);
});