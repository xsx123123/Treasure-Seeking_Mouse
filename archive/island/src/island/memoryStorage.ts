/** Ephemeral presentation preferences only; never reads the old account/browser store. */
const values = new Map<string, string>();
export const memoryStorage = {
  getItem: (key: string): string | null => values.get(key) ?? null,
  setItem: (key: string, value: string): void => { values.set(key, value); },
  removeItem: (key: string): void => { values.delete(key); },
  clear: (): void => values.clear(),
};
