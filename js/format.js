// Number, time and HTML helpers.

export function decimalsFor(value, symbol = '') {
  const a = Math.abs(value);
  if (symbol.endsWith('=X')) return a >= 20 ? 2 : 4;   // FX pairs
  if (a === 0) return 2;
  if (a < 0.01) return 6;
  if (a < 1) return 4;
  return 2;
}

export function fmtPrice(value, symbol = '') {
  if (value == null || !Number.isFinite(value)) return '—';
  const d = decimalsFor(value, symbol);
  return value.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtChange(change, pct, symbol = '') {
  if (change == null || !Number.isFinite(change)) return '—';
  const s = change > 0 ? '+' : change < 0 ? '−' : '';
  const abs = fmtPrice(Math.abs(change), symbol);
  const p = pct != null && Number.isFinite(pct) ? ` (${s}${Math.abs(pct).toFixed(2)}%)` : '';
  return `${s}${abs}${p}`;
}

export function fmtPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const s = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${s}${Math.abs(pct).toFixed(2)}%`;
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(sec, intraday) {
  const d = new Date(sec * 1000);
  return intraday
    ? d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function isMarketOpen(quote, nowSec = Date.now() / 1000) {
  const s = quote?.session;
  if (!s) return null;
  return nowSec >= s.start && nowSec < s.end;
}
