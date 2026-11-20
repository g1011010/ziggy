// Market data from Yahoo Finance's keyless endpoints, routed through a
// public CORS proxy (Yahoo does not send CORS headers). Proxies are tried
// in order; the last one that worked is tried first next time.

import { store } from './store.js';

export const PROXIES = [
  { id: 'corsproxy', name: 'corsproxy.io', tpl: 'https://corsproxy.io/?url={url}' },
  { id: 'allorigins', name: 'allorigins.win', tpl: 'https://api.allorigins.win/raw?url={url}' },
  { id: 'codetabs', name: 'codetabs.com', tpl: 'https://api.codetabs.com/v1/proxy?quest={url}' },
];

const YAHOO = 'https://query1.finance.yahoo.com';
const TIMEOUT_MS = 10000;

export const RANGES = [
  { id: '1D', range: '1d', interval: '5m' },
  { id: '5D', range: '5d', interval: '15m' },
  { id: '1M', range: '1mo', interval: '1d' },
  { id: '6M', range: '6mo', interval: '1d' },
  { id: '1Y', range: '1y', interval: '1d' },
  { id: '5Y', range: '5y', interval: '1wk' },
];

function proxyOrder() {
  const s = store.getSettings();
  if (s.proxy === 'custom' && s.customProxy.includes('{url}')) {
    return [{ id: 'custom', name: 'Custom', tpl: s.customProxy }];
  }
  if (s.proxy !== 'auto') {
    const p = PROXIES.find((x) => x.id === s.proxy);
    if (p) return [p];
  }
  const last = PROXIES.find((x) => x.id === s.lastGoodProxy);
  return last ? [last, ...PROXIES.filter((x) => x !== last)] : [...PROXIES];
}

// The timeout covers the whole exchange, including reading the body: a proxy
// that sends headers and then stalls must not hang a refresh forever.
async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return { res, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

// Unique query param per request so caching proxies always fetch fresh data.
const bust = () => `&_=${Date.now()}`;

export async function fetchJSON(target) {
  let lastErr;
  for (const p of proxyOrder()) {
    try {
      const { res, text } = await fetchText(p.tpl.replace('{url}', encodeURIComponent(target)));
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`${p.name}: not JSON (HTTP ${res.status})`); }
      // Yahoo returns JSON error bodies with 4xx (e.g. unknown symbol) — those are real answers.
      if (!res.ok && !json?.chart?.error && !json?.finance?.error) {
        throw new Error(`${p.name}: HTTP ${res.status}`);
      }
      if (p.id !== 'custom' && store.getSettings().lastGoodProxy !== p.id) {
        store.setSettings({ lastGoodProxy: p.id });
      }
      return json;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`${p.name}: timed out`) : e;
    }
  }
  throw lastErr || new Error('No proxy available');
}

function parseChart(json, symbol) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || `No data for ${symbol}`);
  const m = r.meta || {};
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const t = [];
  const v = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null && Number.isFinite(closes[i])) { t.push(ts[i]); v.push(closes[i]); }
  }
  const price = m.regularMarketPrice ?? v[v.length - 1];
  const prevClose = m.previousClose ?? m.chartPreviousClose ?? null;
  const reg = m.currentTradingPeriod?.regular;
  return {
    quote: {
      symbol: m.symbol || symbol,
      name: m.longName || m.shortName || symbol,
      price,
      prevClose,
      change: prevClose != null ? price - prevClose : null,
      changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
      currency: m.currency || '',
      exchange: m.fullExchangeName || m.exchangeName || '',
      type: m.instrumentType || '',
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      high52: m.fiftyTwoWeekHigh ?? null,
      low52: m.fiftyTwoWeekLow ?? null,
      marketTime: m.regularMarketTime ?? null,
      session: reg ? { start: reg.start, end: reg.end } : null,
    },
    series: { t, v },
  };
}

/** Quote plus intraday series (used for the watchlist sparkline). */
export async function getQuote(symbol) {
  const url = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false${bust()}`;
  return parseChart(await fetchJSON(url), symbol);
}

export async function getChart(symbol, rangeId) {
  const r = RANGES.find((x) => x.id === rangeId) || RANGES[0];
  const url = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${r.range}&interval=${r.interval}&includePrePost=false${bust()}`;
  return parseChart(await fetchJSON(url), symbol);
}

export async function search(q) {
  const url = `${YAHOO}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
  const json = await fetchJSON(url);
  return (json?.quotes || [])
    .filter((x) => x.symbol)
    .map((x) => ({
      symbol: x.symbol,
      name: x.shortname || x.longname || x.symbol,
      exchange: x.exchDisp || x.exchange || '',
      type: x.typeDisp || x.quoteType || '',
    }));
}

/** Run async fn over items with at most `limit` in flight. Never rejects. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = { ok: true, value: await fn(items[idx]) }; }
      catch (error) { out[idx] = { ok: false, error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
