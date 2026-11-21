// Yahoo-shaped fixture responses served in place of the CORS proxies.

const PRICES = {
  '^GSPC': [5900, 5850], '^IXIC': [19000, 19100], AAPL: [190, 187.5], MSFT: [420, 425],
  'EURUSD=X': [1.0832, 1.0811], 'BTC-USD': [97000, 95000], 'VOD.L': [72.4, 71.9], TSLA: [250, 240], ANT: [97.17, 83],
  NVDA: [145, 141], GOOGL: [178, 176.2], 'ETH-USD': [3400, 3350],
};

function chart(symbol, range, price, prev) {
  const n = range === '1d' ? 78 : range === '5d' ? 130 : range === '5y' ? 260 : 120;
  const now = Math.floor(Date.now() / 1000);
  const step = range === '1d' ? 300 : range === '5d' ? 900 : range === '5y' ? 604800 : 86400;
  const t = [], c = [];
  for (let i = 0; i < n; i++) {
    t.push(now - (n - 1 - i) * step);
    c.push(+(prev + (price - prev) * (i / (n - 1)) + Math.sin(i / 5) * price * 0.002).toFixed(4));
  }
  c[n - 1] = price;
  if (n > 10) c[5] = null; // Yahoo sometimes has gaps
  return {
    chart: {
      result: [{
        meta: {
          symbol, currency: symbol.endsWith('.L') ? 'GBp' : 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS',
          instrumentType: 'EQUITY', regularMarketPrice: price, chartPreviousClose: prev,
          regularMarketDayHigh: price * 1.01, regularMarketDayLow: prev * 0.99,
          fiftyTwoWeekHigh: price * 1.2, fiftyTwoWeekLow: price * 0.7,
          longName: `${symbol} Test Co`, regularMarketTime: now,
          currentTradingPeriod: { regular: { start: now - 3600, end: now + 3600 } },
        },
        timestamp: t,
        indicators: { quote: [{ close: c }] },
      }],
      error: null,
    },
  };
}

/** Install proxy interception. `opts.failProxies` lists proxy hosts to fail. */
async function mockData(page, opts = {}) {
  const calls = [];
  calls.targets = [];
  const handler = async (route) => {
    const req = new URL(route.request().url());
    calls.push(req.host);
    if ((opts.stallProxies || []).includes(req.host)) return; // never answers
    if (opts.offline || (opts.failProxies || []).includes(req.host)) {
      return route.fulfill({ status: 503, body: 'Service unavailable' });
    }
    const target = new URL(req.searchParams.get('url') || req.searchParams.get('quest'));
    calls.targets.push(target);
    if (target.pathname.includes('/finance/spark')) {
      if (opts.noSpark) {
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ finance: { result: null, error: { code: 'Unauthorized', description: 'Invalid Crumb' } } }) });
      }
      const result = target.searchParams.get('symbols').split(',')
        .filter((sym) => ((opts.prices && opts.prices[sym]) || PRICES[sym]) && !(opts.sparkSkips || []).includes(sym))
        .map((sym) => {
          const r = chart(sym, '1d', ...((opts.prices && opts.prices[sym]) || PRICES[sym])).chart.result[0];
          const { longName, fullExchangeName, regularMarketDayHigh, regularMarketDayLow, ...lean } = r.meta;
          return { symbol: sym, response: [{ ...r, meta: lean }] };
        });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ spark: { result, error: null } }) });
    }
    if (target.pathname.includes('/v1/finance/search')) {
      const q = target.searchParams.get('q').toUpperCase();
      const quotes = Object.keys(PRICES).filter((s) => s.includes(q)).map((s) => ({ symbol: s, shortname: `${s} Test Co`, exchDisp: 'NASDAQ', typeDisp: 'Equity' }));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ quotes }) });
    }
    const sym = decodeURIComponent(target.pathname.split('/').pop());
    const prices = (opts.prices && opts.prices[sym]) || PRICES[sym];
    if (!prices) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(chart(sym, target.searchParams.get('range'), ...prices)) });
  };
  await page.route(/workers\.dev|corsproxy\.io|allorigins\.win|codetabs\.com/, handler);
  return calls;
}

// Finnhub mock. Prices differ slightly from the Yahoo fixtures so tests can
// tell which source a number came from.
const FH = { AAPL: [191.11, 187.5], MSFT: [421.11, 425], NVDA: [146.11, 141], GOOGL: [179.11, 176.2], ANT: [98.11, 83], TSLA: [251.11, 240],
  'BINANCE:BTCUSDT': [97111, 95000], 'BINANCE:ETHUSDT': [3411, 3350] };

async function mockFinnhub(page, opts = {}) {
  const calls = [];
  await page.route(/finnhub\.io/, (route) => {
    const u = new URL(route.request().url());
    calls.push(u.pathname + '?' + u.searchParams.get('symbol'));
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (opts.invalid) return json({ error: 'Invalid API key' }, 401);
    const sym = u.searchParams.get('symbol');
    if (u.pathname.endsWith('/quote')) {
      const p = FH[sym];
      if (!p) return json({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 });
      const [c, pc] = p;
      return json({ c, d: c - pc, dp: ((c - pc) / pc) * 100, h: c * 1.01, l: pc * 0.99, o: pc, pc, t: Math.floor(Date.now() / 1000) });
    }
    if (u.pathname.endsWith('/stock/profile2')) return json(FH[sym] ? { name: `${sym} Finnhub Inc` } : {});
    if (u.pathname.endsWith('/candle')) {
      if (opts.candles !== 'ok') return json({ error: "You don't have access to this resource." }, 403);
      const now = Math.floor(Date.now() / 1000);
      const t = Array.from({ length: 50 }, (_, i) => now - (49 - i) * 300);
      return json({ s: 'ok', t, c: t.map((_, i) => 180 + i * 0.2), o: [], h: [], l: [], v: [] });
    }
    if (u.pathname.endsWith('/search')) {
      const q = u.searchParams.get('q').toUpperCase();
      return json({ count: 1, result: Object.keys(FH).filter((k) => !k.includes(':') && k.includes(q)).map((k) => ({ description: `${k} FINNHUB INC`, displaySymbol: k, symbol: k, type: 'Common Stock' })) });
    }
    return json({}, 404);
  });
  return calls;
}

module.exports = { PRICES, chart, mockData, mockFinnhub };
