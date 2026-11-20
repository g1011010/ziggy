// Device-local persistence. Every access is guarded: storage can be
// unavailable (private mode, blocked site data), in which case we fall
// back to an in-memory copy for the session.

const PREFIX = 'ziggy:';
const memory = {};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw != null) return JSON.parse(raw);
  } catch { /* fall through */ }
  return key in memory ? memory[key] : fallback;
}

function write(key, value) {
  memory[key] = value;
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* memory only */ }
}

export const DEFAULT_WATCHLIST = ['^GSPC', '^IXIC', 'AAPL', 'MSFT', 'EURUSD=X', 'BTC-USD'];

export const DEFAULT_SETTINGS = {
  refresh: 60,          // seconds; 0 = manual
  proxy: 'auto',        // 'auto' | proxy id | 'custom'
  customProxy: '',      // template containing {url}
  lastGoodProxy: null,
};

export const store = {
  getWatchlist() {
    const w = read('watchlist', null);
    return Array.isArray(w) ? w : [...DEFAULT_WATCHLIST];
  },
  setWatchlist(list) { write('watchlist', [...new Set(list)]); },

  getMeta() { return read('meta', {}); },
  setMeta(symbol, info) {
    const m = read('meta', {});
    m[symbol] = { ...m[symbol], ...info };
    write('meta', m);
  },

  getAlerts() { return read('alerts', []); },
  setAlerts(alerts) { write('alerts', alerts); },

  getSettings() { return { ...DEFAULT_SETTINGS, ...read('settings', {}) }; },
  setSettings(patch) { write('settings', { ...this.getSettings(), ...patch }); },

  // Last good quote + sparkline per symbol, for offline / stale display.
  getCache() { return read('cache', {}); },
  setCached(symbol, entry) {
    const c = read('cache', {});
    c[symbol] = entry;
    write('cache', c);
  },

  exportData() {
    return {
      app: 'ziggy',
      version: 1,
      exportedAt: new Date().toISOString(),
      watchlist: this.getWatchlist(),
      meta: this.getMeta(),
      alerts: this.getAlerts(),
      settings: this.getSettings(),
    };
  },

  importData(data) {
    if (!data || data.app !== 'ziggy' || !Array.isArray(data.watchlist)) {
      throw new Error('Not a Ziggy backup file');
    }
    this.setWatchlist(data.watchlist.filter((s) => typeof s === 'string'));
    write('meta', data.meta && typeof data.meta === 'object' ? data.meta : {});
    write('alerts', Array.isArray(data.alerts) ? data.alerts : []);
    if (data.settings) write('settings', { ...DEFAULT_SETTINGS, ...data.settings });
  },

  clearAll() {
    for (const k of Object.keys(memory)) delete memory[k];
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};
