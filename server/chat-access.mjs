import { chatAccessMode, verifyCloudUser } from '../functions/seqout-chat/access.ts';

export function createChatAccess({ env = process.env, authenticate }) {
  const mode = chatAccessMode(env.CHAT_ACCESS_MODE || '', env.CHAT_SHARED_SECRET || '');
  return async (headers, signal) => {
    // Public API callers cannot supply internal trust or bypass configured authentication.
    delete headers['x-chat-key'];
    delete headers['x-cygnusx-platform-tools'];
    if (mode === 'authenticated') {
      const token = /^Bearer (\S+)$/.exec(headers.authorization || '')?.[1];
      if (!token) throw new Error('unauthorized');
      const cloudUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL || '';
      const cloudKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '';
      if (cloudUrl || cloudKey) {
        const user = await verifyCloudUser(token, cloudUrl, cloudKey, signal);
        if (!user) throw new Error('unauthorized');
        headers['x-stats-actor'] = user.id;
      } else {
        const user = authenticate(token);
        if (!user) throw new Error('unauthorized');
        headers['x-stats-actor'] = user.id;
        headers['x-account-kind'] = 'local'; // 自托管账号身份标记（任务归属 kind=local_account）
      }
    }
    headers['x-chat-key'] = env.CHAT_SHARED_SECRET || '';
  };
}
