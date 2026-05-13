// Session key held in memory only — never written to disk, localStorage, or sessionStorage.
const _store: { key: string | null } = { key: null };

export const sessionStore = {
  set(k: string)  { _store.key = k; },
  get()           { return _store.key; },
  clear()         { _store.key = null; },
};
