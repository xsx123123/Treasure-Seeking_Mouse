export async function fetchLiterature(): Promise<never> { throw new Error('Platform literature adapter required'); }
export async function fetchUsageStats(): Promise<null> { return null; }
export async function fetchLeaderboard(): Promise<never> { throw new Error('Platform leaderboard not connected'); }
export async function updateNickname(): Promise<{ ok: false }> { return { ok: false }; }
export function myGuestKey(): string { return ''; }
