// Market data from Yahoo Finance's keyless endpoints, routed through a
// public CORS proxy (Yahoo does not send CORS headers).
//
// Speed / reliability strategy:
//  - Watchlist quotes are fetched in ONE batched "spark" request (up to 20
//    symbols) instead of one request per symbol, which avoids proxy rate
//    limits. Symbols the batch misses fall back to individual requests.
//  - Proxies are raced with a head start: the best proxy goes first, and if
//    it hasn't answered within HEDGE_MS the next one starts in parallel.
//    First valid answer wins; the rest are cancelled.
//  - Proxies that fail are benched for a few minutes.
//  - Chart responses are cached in memory.

import { store } from './store.js';
import { hasFinnhub, toFinnhub, fhQuote, fhCandles, fhSearch } from './finnhub.js';

export const PROXIES = [
  // Ziggy's own Cloudflare Worker (worker/proxy.js): fast, Yahoo-only.
  { id: 'ziggy', name: 'Ziggy relay', tpl: 'https://ziggy.g1011010.workers.dev/?url={url}' },
  { id: 'allorigins', name: 'allorigins.win', tpl: 'https://api.allorigins.win/raw?url={url}' },
  { id: 'codetabs', name: 'codetabs.com', tpl: 'https://api.codetabs.com/v1/proxy?quest={url}' },
];

const YAHOO = 'https://query1.finance.yahoo.com';
const TIMEOUT_MS = 10000;
const HEDGE_MS = 2500;
const BENCH_MS = 3 * 60 * 1000;
const BATCH_SIZE = 20;

export const RANGES = [
  { id: '1D', range: '1d', interval: '5m', ttl: 60e3 },
  { id: '5D', range: '5d', interval: '15m', ttl: 5 * 60e3 },
  { id: '1M', range: '1mo', interval: '1d', ttl: 15 * 60e3 },
  { id: '6M', range: '6mo', interval: '1d', ttl: 30 * 60e3 },
  { id: '1Y', range: '1y', interval: '1d', ttl: 30 * 60e3 },
  { id: '5Y', range: '5y', interval: '1wk', ttl: 60 * 60e3 },
];

// corsproxy.io was removed: since late 2026 it rejects keyless requests (401).

// ---------- Proxy selection ----------

const health = {}; // proxy id -> { benchUntil, ms }

function proxyOrder() {
  const s = store.getSettings();
  const custom = proxyTemplate(s.customProxy);
  if (s.proxy === 'custom' && custom) {
    return [{ id: 'custom', name: 'Your relay', tpl: custom }];
  }
  if (s.proxy !== 'auto') {
    const p = PROXIES.find((x) => x.id === s.proxy);
    if (p) return [p];
  }
  const now = Date.now();
  const score = (p) =>
    (health[p.id]?.benchUntil > now ? 1e6 : 0) +
    (p.id === 'ziggy' ? -2000 : 0) + // own relay first unless it's failing
    (p.id === s.lastGoodProxy ? 0 : 1000) +
    (health[p.id]?.ms ?? 5000) / 10;
  return [...PROXIES].sort((a, b) => score(a) - score(b));
}

/**
 * Turn what the user typed into a proxy template. Accepts a full template
 * with {url}, or just a relay address like https://ziggy.me.workers.dev
 * (then ?url={url} is added). Returns null if it isn't an https URL.
 */
export function proxyTemplate(input) {
  const v = (input || '').trim();
  if (!/^https:\/\/[^\s/]+/i.test(v)) return null;
  if (v.includes('{url}')) return v;
  const base = v.split(/[?#]/)[0].replace(/\/*$/, '/');
  return `${base}?url={url}`;
}

/** Measured latency per proxy, for the Settings screen. */
export function proxyHealth() {
  return Object.fromEntries(PROXIES.map((p) => [p.id, { ...health[p.id] }]));
}

// Unique query param per request so caching proxies always fetch fresh data.
const bust = () => `&_=${Date.now()}`;

async function attempt(p, target, signal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(p.tpl.replace('{url}', encodeURIComponent(target)), { signal: ctrl.signal, cache: 'no-store' });
    const text = await res.text(); // inside the timeout: a stalled body can't hang us
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`${p.name}: not JSON (HTTP ${res.status})`); }
    // Yahoo returns JSON error bodies with 4xx (e.g. unknown symbol) — those are real answers.
    if (!res.ok && !json?.chart?.error && !json?.finance?.error && !json?.spark?.error) {
      throw new Error(`${p.name}: HTTP ${res.status}`);
    }
    health[p.id] = { ms: Math.round(performance.now() - t0), benchUntil: 0 };
    return json;
  } catch (e) {
    if (signal.aborted) throw e; // cancelled because another proxy won
    health[p.id] = { ...health[p.id], benchUntil: Date.now() + BENCH_MS };
    throw timedOut ? new Error(`${p.name}: timed out`) : e.name === 'AbortError' ? new Error(`${p.name}: aborted`) : e;
  } finally {
    clearTimeout(t);
    signal.removeEventListener('abort', onAbort);
  }
}

export function fetchJSON(target) {
  const order = proxyOrder();
  const cancelAll = new AbortController();
  return new Promise((resolve, reject) => {
    let next = 0, running = 0, settled = false, hedge = null;
    const errors = [];

    const launch = () => {
      clearTimeout(hedge);
      if (settled || next >= order.length) return;
      const p = order[next++];
      running++;
      attempt(p, target, cancelAll.signal).then((json) => {
        if (settled) return;
        settled = true;
        clearTimeout(hedge);
        cancelAll.abort();
        if (p.id !== 'custom' && store.getSettings().lastGoodProxy !== p.id) {
          store.setSettings({ lastGoodProxy: p.id });
        }
        resolve(json);
      }, (err) => {
        running--;
        if (settled) return;
        errors.push(err);
        if (next < order.length) launch();            // failed fast: try the next one now
        else if (running === 0) { settled = true; reject(errors[0]); }
      });
      // Head start over: if still waiting, race the next proxy too.
      if (next < order.length) hedge = setTimeout(launch, HEDGE_MS);
    };
    launch();
  });
}

// ---------- Parsing ----------

function parseChart(json, symbol) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || `No data for ${symbol}`);
  return parseResult(r, symbol);
}

function parseResult(r, symbol) {
  const m = r.meta || {};
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const t = [];
  const v = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null && Number.isFinite(closes[i])) { t.push(ts[i]); v.push(closes[i]); }
  }
  const price = m.regularMarketPrice ?? v[v.length - 1];
  if (price == null) throw new Error(`No price for ${symbol}`);
  const prevClose = m.previousClose ?? m.chartPreviousClose ?? null;
  const reg = m.currentTradingPeriod?.regular;
  return {
    quote: {
      symbol: m.symbol || symbol,
      name: m.longName || m.shortName || null,
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

/** Parse a batched spark response. Handles both the v7 and v8 shapes. */
function parseSpark(json) {
  const out = {};
  const list = json?.spark?.result;
  if (Array.isArray(list)) {
    for (const r of list) {
      const resp = r?.response?.[0];
      if (!r?.symbol || !resp) continue;
      try { out[r.symbol] = parseResult(resp, r.symbol); } catch { /* fall back per symbol */ }
    }
  } else if (json && typeof json === 'object' && !json.spark && !json.chart && !json.finance) {
    for (const [sym, d] of Object.entries(json)) {
      if (!Array.isArray(d?.close) || !Array.isArray(d?.timestamp)) continue;
      try {
        out[sym] = parseResult({
          meta: { symbol: sym, previousClose: d.previousClose, chartPreviousClose: d.chartPreviousClose },
          timestamp: d.timestamp,
          indicators: { quote: [{ close: d.close }] },
        }, sym);
      } catch { /* fall back per symbol */ }
    }
  }
  return out;
}

// ---------- Public API ----------

/** Quote plus intraday series for one symbol (used for the watchlist sparkline). */
export async function getQuote(symbol) {
  const url = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false${bust()}`;
  return parseChart(await fetchJSON(url), symbol);
}

let sparkWorks = true; // flips off for this session if Yahoo rejects batch requests

/** Yahoo batch (spark) for intraday series + quote. Missing symbols are omitted. */
export async function getSpark(symbols) {
  const found = {};
  if (!sparkWorks || !symbols.length) return found;
  const chunks = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) chunks.push(symbols.slice(i, i + BATCH_SIZE));
  const res = await Promise.all(chunks.map(async (chunk) => {
    const url = `${YAHOO}/v7/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}&range=1d&interval=5m&includePrePost=false${bust()}`;
    try { return parseSpark(await fetchJSON(url)); } catch { return null; }
  }));
  res.forEach((r) => Object.assign(found, r || {}));
  if (res.every((r) => r && !Object.keys(r).length)) sparkWorks = false;
  return found;
}

/**
 * Quotes for many symbols. Finnhub (when a key is set) answers first and is
 * reported through onPartial; Yahoo covers everything else. Returns
 * [{ok, value|error}] aligned with `symbols`; Finnhub values have series: null.
 * Never rejects.
 */
export async function getQuotes(symbols, { onPartial } = {}) {
  const found = {};
  const fhSyms = hasFinnhub() ? symbols.filter((s) => toFinnhub(s)) : [];
  if (fhSyms.length) {
    const r = await mapLimit(fhSyms, 4, fhQuote);
    fhSyms.forEach((s, i) => { if (r[i].ok) found[s] = { quote: r[i].value, series: null }; });
    if (Object.keys(found).length) {
      onPartial?.(symbols.map((s) => (found[s] ? { ok: true, value: found[s] } : null)));
    }
  }
  const rest = symbols.filter((s) => !found[s]);
  const yahoo = await getYahooQuotes(rest);
  rest.forEach((s, i) => { if (yahoo[i].ok) found[s] = yahoo[i].value; });
  return symbols.map((s) => {
    if (found[s]) return { ok: true, value: found[s] };
    const j = rest.indexOf(s);
    return { ok: false, error: yahoo[j]?.error || new Error(`No data for ${s}`) };
  });
}

async function getYahooQuotes(symbols) {
  const found = symbols.length > 1 ? await getSpark(symbols) : {};
  const missing = symbols.filter((s) => !found[s]);
  const single = await mapLimit(missing, 3, getQuote);
  missing.forEach((s, i) => { if (single[i].ok) found[s] = single[i].value; });
  return symbols.map((s, i) => {
    if (found[s]) return { ok: true, value: found[s] };
    const j = missing.indexOf(s);
    return { ok: false, error: single[j]?.error || new Error(`No data for ${s}`) };
  });
}

const chartCache = new Map(); // `${symbol}|${range}` -> { at, data }

/** Cached chart if present (any age), for instant display. */
export function peekChart(symbol, rangeId) {
  return chartCache.get(`${symbol}|${rangeId}`) || null;
}

export function isChartFresh(symbol, rangeId) {
  const hit = peekChart(symbol, rangeId);
  const r = RANGES.find((x) => x.id === rangeId) || RANGES[0];
  return !!hit && Date.now() - hit.at < r.ttl;
}

export async function getChart(symbol, rangeId) {
  const r = RANGES.find((x) => x.id === rangeId) || RANGES[0];
  if (isChartFresh(symbol, r.id)) return peekChart(symbol, r.id).data;
  let data = null;
  if (hasFinnhub() && toFinnhub(symbol)) {
    try {
      const [series, quote] = await Promise.all([fhCandles(symbol, r.id), fhQuote(symbol)]);
      data = { quote, series };
    } catch { /* fall back to Yahoo */ }
  }
  if (!data) {
    const url = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${r.range}&interval=${r.interval}&includePrePost=false${bust()}`;
    data = parseChart(await fetchJSON(url), symbol);
  }
  chartCache.set(`${symbol}|${r.id}`, { at: Date.now(), data });
  return data;
}

/**
 * Search Finnhub (if keyed) and Yahoo in parallel. onUpdate(results) is called
 * whenever more results arrive; resolves with the final merged list.
 */
export async function search(q, onUpdate) {
  let merged = [];
  const add = (items) => {
    const seen = new Set(merged.map((x) => x.symbol));
    merged = [...merged, ...items.filter((x) => !seen.has(x.symbol))];
    onUpdate?.(merged);
  };
  const jobs = [yahooSearch(q).then(add, () => {})];
  if (hasFinnhub()) jobs.unshift(fhSearch(q).then(add, () => {}));
  await Promise.all(jobs);
  return merged;
}

async function yahooSearch(q) {
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
