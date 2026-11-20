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
  const handler = async (route) => {
    const req = new URL(route.request().url());
    calls.push(req.host);
    if (opts.offline || (opts.failProxies || []).includes(req.host)) {
      return route.fulfill({ status: 503, body: 'Service unavailable' });
    }
    const target = new URL(req.searchParams.get('url') || req.searchParams.get('quest'));
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
  await page.route(/corsproxy\.io|allorigins\.win|codetabs\.com/, handler);
  return calls;
}

module.exports = { PRICES, chart, mockData };
