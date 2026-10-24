-- chat_tasks：消息排队与后台任务持续执行（message_queue）的任务登记表。
-- Additive：纯新增表，存量数据/策略/授权不受影响。回滚应用代码后本表可保留（惰性无写）。
-- Apply to the configured Supabase database before deploying the task-enabled function.
--
-- RLS 语义：anon/authenticated 全拒——一切访问经 Edge Function（service_role 绕过 RLS），
-- 归属校验在函数内单点执行（三类身份统一：登录用户/游客设备指纹/自托管账号；
-- 游客无 auth 语境，无法用 RLS 表达设备指纹归属）。
BEGIN;

CREATE TABLE IF NOT EXISTS public.chat_tasks (
  task_id        uuid PRIMARY KEY,
  owner_kind     text NOT NULL CHECK (owner_kind IN ('supabase_user','guest_device','local_account')),
  owner_id       text NOT NULL,                -- 登录用户 id / 游客设备指纹 / 自托管账号 id（仅归属键，不关联敏感信息）
  session_ref    text NOT NULL,
  queue_id       text,                         -- 客户端防重键；NULL = 旧前端直接发起
  status         text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','expired')),
  suspended      boolean NOT NULL DEFAULT false,  -- 内部标记位（Edge 分段续跑挂起），不进入对外状态枚举
  lang           text NOT NULL DEFAULT 'zh',
  question_snapshot jsonb NOT NULL,            -- 提问+历史（断连独立续跑所需；随终态窗口清理）
  progress_snapshot jsonb,                     -- running 期间里程碑；终态后清空
  result         jsonb,                        -- 终态完整结果（含错误文案）
  error          text CHECK (error IN ('llm_error','timeout','aborted','service_restart')),
  instance_id    text NOT NULL,                -- 执行实例标识（孤儿判定）
  heartbeat_at   timestamptz NOT NULL DEFAULT now(),  -- 里程碑刷新（僵尸侦测）
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  expires_at     timestamptz                   -- 终态时刻 + 24h（可配置 TASK_RESULT_TTL_MS）
);

-- 幂等与串行约束（spec 6.2 规则 10）：
-- ① 同 (owner, queue_id) 最多一个任务（部分唯一索引，queue_id 非空时生效）
CREATE UNIQUE INDEX IF NOT EXISTS chat_tasks_owner_queue_uq
  ON public.chat_tasks (owner_kind, owner_id, queue_id) WHERE queue_id IS NOT NULL;
-- ② 同 session_ref 同时最多一个活跃任务（部分唯一索引，仅活跃态）
CREATE UNIQUE INDEX IF NOT EXISTS chat_tasks_session_running_uq
  ON public.chat_tasks (owner_kind, owner_id, session_ref) WHERE status IN ('queued','running');
-- 查询索引：按身份的活跃/可恢复任务列表（spec 4.1 规则 6 的 2s 约束）
CREATE INDEX IF NOT EXISTS chat_tasks_owner_status_idx
  ON public.chat_tasks (owner_kind, owner_id, status, created_at DESC);
-- 清理索引：过期扫描
CREATE INDEX IF NOT EXISTS chat_tasks_expires_idx
  ON public.chat_tasks (expires_at) WHERE expires_at IS NOT NULL;

-- RLS：启用且不创建任何 anon/authenticated 策略 = 默认全拒；
-- service_role 不受 RLS 约束（Supabase 语义），函数内经 service_role key 访问。
ALTER TABLE public.chat_tasks ENABLE ROW LEVEL SECURITY;

-- 过期清理：pg_cron 可用则注册定时任务（部署后探测，见交付说明 §2.7-④）；
-- 不可用则函数内懒清理兜底（任何 store 访问顺手删 expired 终态任务）。
-- SELECT cron.schedule('chat_tasks_gc', '*/15 * * * *',
--   $$DELETE FROM public.chat_tasks WHERE expires_at IS NOT NULL AND expires_at < now()$$);

COMMIT;