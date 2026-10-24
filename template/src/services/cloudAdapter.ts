// cloudAdapter.ts：云模式「可选适配」边界（默认离线）。
//
// 设计边界（模板）：本地账号 + localStorage 是默认形态；云端（如 Supabase 兼容实例）是
// 可选扩展点。本文件保留「离线 Proxy 桩 + isOfflineMode」的机制形态——未配置
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 时，任何调用链 await 得 { data: null, error: null }，
// auth 固定未登录，业务层据此走游客/本地账号分支。
//
// 接入真实云端（按需自装依赖）：安装 @supabase/supabase-js 后在 createClient 分支实例化，
// 保持本文件导出面（cloudClient/isOfflineMode/cloudUrl）不变即可零改业务代码。

interface CloudSession {
  user: { id: string; email?: string } | null;
  access_token?: string;
}

export interface CloudAdapter {
  /** 任何查询：离线恒 { data: null, error: null } */
  from(): never;
  auth: {
    getSession(): Promise<{ data: { session: CloudSession | null }; error: null }>;
    onAuthStateChange(): { data: { subscription: { unsubscribe(): void } } };
    signOut(): Promise<{ data: null; error: null }>;
  };
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_ANON_KEY?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

function optionalEnv(value: string | undefined): string {
  return (value ?? "").trim();
}

export const cloudUrl = optionalEnv(import.meta.env.VITE_SUPABASE_URL);
export const cloudAnonKey = optionalEnv(import.meta.env.VITE_SUPABASE_ANON_KEY);

/** 完全自托管（未配置云实例）时为 true：应用运行游客 + 本地账号模式 */
export const isOfflineMode = !cloudUrl || !cloudAnonKey;

/**
 * 离线 Proxy 桩：调用链上的任何方法都返回自身，await 结果为 { data: null, error: null }；
 * auth 固定未登录（业务层据此走游客分支），fire-and-forget 调用静默空转。
 */
function createOfflineAdapter(): CloudAdapter {
  const nullResult = Promise.resolve({ data: null, error: null });
  const self: unknown = new Proxy(
    function () {},
    {
      get(_t, prop) {
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return nullResult[prop as 'then' | 'catch' | 'finally'].bind(nullResult);
        }
        if (prop === 'auth') return offlineAuth;
        return self;
      },
      apply() {
        return self;
      },
    },
  );
  const offlineAuth = {
    getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    signOut: () => nullResult,
  };
  return self as CloudAdapter;
}

/** 云客户端单例：离线时为 Proxy 桩；配置云实例后在此替换为真实客户端 */
export const cloudClient: CloudAdapter = createOfflineAdapter();