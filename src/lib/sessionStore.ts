// Session credentials held in memory only — never written to disk or storage.
const _store: { key: string | null; deviceShare: string | null } = {
  key: null,
  deviceShare: null,
};

export const sessionStore = {
  set(key: string, deviceShare?: string | null) {
    _store.key = key;
    _store.deviceShare = deviceShare ?? null;
  },
  getKey()         { return _store.key; },
  getDeviceShare() { return _store.deviceShare; },
  clear()          { _store.key = null; _store.deviceShare = null; },
};
