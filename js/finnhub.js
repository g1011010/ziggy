// Finnhub (https://finnhub.io): fast, CORS-enabled API with a free key.
// Used for US stocks and crypto quotes, company names and search. Charts are
// tried here too, but the free plan may not include candle history, so every
// call is optional: callers fall back to Yahoo when this throws.

import { store } from './store.js';

const BASE = 'https://finnhub.io/api/v1';
const TIMEOUT_MS = 8000;

let candlesDenied = false; // set when the key's plan has no candle access

export function finnhubKey() {
  return (store.getSettings().finnhubKey || '').trim();
}

export function hasFinnhub() {
  return !!finnhubKey();
}

/**
 * Map a Yahoo-style symbol to Finnhub. Returns null for things the free plan
 * doesn't cover well (indices, FX, non-US listings) — those stay on Yahoo.
 */
export function toFinnhub(symbol) {
  const crypto = symbol.match(/^([A-Z0-9]{2,10})-USD$/);
  if (crypto) return { symbol: `BINANCE:${crypto[1]}USDT`, kind: 'crypto' };
  if (/^[A-Z]{1,5}$/.test(symbol)) return { symbol, kind: 'stock' }; // plain US ticker
  if (/^[A-Z]{1,4}\.[AB]$/.test(symbol)) return { symbol, kind: 'stock' }; // BRK.B style
  return null;
}

async function get(path, params) {
  const key = finnhubKey();
  if (!key) throw new Error('No Finnhub key');
  const qs = new URLSearchParams({ ...params, token: key });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}?${qs}`, { signal: ctrl.signal, cache: 'no-store' });
    if (res.status === 401) throw Object.assign(new Error('Finnhub: invalid API key'), { status: 401 });
    if (res.status === 403) throw Object.assign(new Error('Finnhub: not included in your plan'), { status: 403 });
    if (res.status === 429) throw Object.assign(new Error('Finnhub: rate limit reached'), { status: 429 });
    if (!res.ok) throw Object.assign(new Error(`Finnhub: HTTP ${res.status}`), { status: res.status });
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Finnhub: timed out');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Quote in Ziggy's shape (no series). Throws if Finnhub has no data. */
export async function fhQuote(symbol) {
  const m = toFinnhub(symbol);
  if (!m) throw new Error(`Finnhub doesn't cover ${symbol}`);
  const q = await get('/quote', { symbol: m.symbol });
  if (!q || !Number.isFinite(q.c) || (q.c === 0 && !q.t)) throw new Error(`Finnhub: no data for ${symbol}`);
  return {
    symbol,
    name: null,
    price: q.c,
    prevClose: q.pc || null,
    change: Number.isFinite(q.d) ? q.d : (q.pc ? q.c - q.pc : null),
    changePct: Number.isFinite(q.dp) ? q.dp : (q.pc ? ((q.c - q.pc) / q.pc) * 100 : null),
    dayHigh: q.h || null,
    dayLow: q.l || null,
    marketTime: q.t || null,
    currency: m.kind === 'crypto' ? 'USD' : '',
  };
}

/** Company name, cached in device storage so it's fetched once per symbol. */
export async function fhName(symbol) {
  const m = toFinnhub(symbol);
  if (!m || m.kind !== 'stock') return null;
  const p = await get('/stock/profile2', { symbol: m.symbol });
  return p?.name || null;
}

const RES = {
  '1D': { res: '5', secs: 86400 * 1.2 },
  '5D': { res: '15', secs: 86400 * 7 },
  '1M': { res: 'D', secs: 86400 * 31 },
  '6M': { res: 'D', secs: 86400 * 183 },
  '1Y': { res: 'D', secs: 86400 * 366 },
  '5Y': { res: 'W', secs: 86400 * 365 * 5 },
};

/** Candle series {t, v}. Throws when unavailable (e.g. free plan → 403). */
export async function fhCandles(symbol, rangeId) {
  if (candlesDenied) throw new Error('Finnhub candles not in plan');
  const m = toFinnhub(symbol);
  const r = RES[rangeId];
  if (!m || !r) throw new Error('Not covered');
  const to = Math.floor(Date.now() / 1000);
  try {
    const c = await get(m.kind === 'crypto' ? '/crypto/candle' : '/stock/candle', {
      symbol: m.symbol, resolution: r.res, from: String(Math.floor(to - r.secs)), to: String(to),
    });
    if (c?.s !== 'ok' || !Array.isArray(c.t) || c.t.length < 2) throw new Error('Finnhub: no candle data');
    return { t: c.t, v: c.c };
  } catch (e) {
    if (e.status === 403 || e.status === 401) candlesDenied = true;
    throw e;
  }
}

export async function fhSearch(q) {
  const j = await get('/search', { q });
  return (j?.result || [])
    .filter((x) => x.symbol && !x.symbol.includes(':'))
    .slice(0, 10)
    .map((x) => ({
      symbol: x.displaySymbol || x.symbol,
      name: x.description || x.symbol,
      exchange: 'US',
      type: x.type || '',
    }));
}

/** Quick check used by Settings → Test. */
export async function fhTest() {
  const q = await get('/quote', { symbol: 'AAPL' });
  if (!Number.isFinite(q?.c) || q.c === 0) throw new Error('Finnhub: unexpected response');
  return q.c;
}
