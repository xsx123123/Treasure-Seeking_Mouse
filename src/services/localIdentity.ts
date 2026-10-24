export const LOCAL_TOKEN_KEY = 'seqout-local-token';
export const LOCAL_USER_KEY = 'seqout-local-user';
export function getLocalToken(): string {
  try { return localStorage.getItem(LOCAL_TOKEN_KEY) ?? ''; } catch { return ''; }
}
