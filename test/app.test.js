// End-to-end tests: serve the app locally, intercept the CORS-proxy requests
// and answer them with Yahoo-shaped fixtures. No network access needed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let server, base, browser;

before(async () => {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => { await browser?.close(); server?.close(); });

const { mockData, mockFinnhub } = require('./fixtures.js');

async function newPage(contextOpts = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block', ...contextOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

// ---------- Tests ----------

test('watchlist loads default symbols with prices', async () => {
  const { ctx, page, errors } = await newPage();
  await mockData(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  const syms = await page.$$eval('.row', (rs) => rs.map((r) => r.dataset.sym));
  assert.deepEqual(syms, ['^GSPC', '^IXIC', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'ANT', 'EURUSD=X', 'BTC-USD', 'ETH-USD']);
  assert.match(await page.textContent('.row[data-sym="AAPL"] .chg'), /\+1\.33%/);
  assert.ok(await page.$('.row[data-sym="MSFT"] .chg.down'));
  assert.equal(await page.textContent('.row[data-sym="EURUSD=X"] .px b'), '1.0832');
  assert.match(await page.textContent('#status'), /Updated/);
  assert.ok(await page.$('.row[data-sym="AAPL"] svg.spark path'));
  // No horizontal overflow at phone width.
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('search adds a symbol and it persists across reload', async () => {
  const { ctx, page, errors } = await newPage();
  await mockData(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  await page.click('#add-btn');
  await page.fill('#q', 'vod');
  await page.click('#results button[data-sym="VOD.L"]');
  await page.waitForSelector('#results .added');
  await page.click('[data-close]');
  await page.waitForSelector('.row[data-sym="VOD.L"] .px b:text("72.40")');
  await page.reload();
  await page.waitForSelector('.row[data-sym="VOD.L"]');
  assert.equal((await page.$$('.row')).length, 11);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('detail view renders chart for every range and scrubs', async () => {
  const { ctx, page, errors } = await newPage();
  await mockData(page);
  await page.goto(base);
  await page.click('.row[data-sym="AAPL"] .sym');
  await page.waitForSelector('#detail:not([hidden]) #d-chart canvas');
  assert.match(await page.textContent('#d-price'), /190\.00/);
  assert.match(await page.textContent('#d-chg'), /\+2\.50 \(\+1\.33%\)today/);
  for (const r of ['5D', '1M', '6M', '1Y', '5Y', '1D']) {
    await page.click(`#d-ranges button[data-range="${r}"]`);
    await page.waitForFunction((rr) => document.querySelector(`#d-ranges button[aria-pressed="true"]`).dataset.range === rr && document.querySelector('#d-msg').hidden, r);
    assert.ok(await page.$('#d-chart canvas'), `chart for ${r}`);
  }
  // Touch-scrub the chart: the readout should show a historical point with a time.
  const over = await page.$('#d-chart .u-over');
  const box = await over.boundingBox();
  await page.dispatchEvent('#d-chart .u-over', 'pointermove', { pointerType: 'touch', clientX: box.x + box.width * 0.3, clientY: box.y + 50 });
  assert.doesNotMatch(await page.textContent('#d-chg'), /today/);
  await page.dispatchEvent('#d-chart .u-over', 'pointerup', { pointerType: 'touch', clientX: 0, clientY: 0 });
  assert.match(await page.textContent('#d-chg'), /today/);
  assert.match(await page.textContent('#d-stats'), /52-week range/);
  await page.click('#d-back');
  await page.waitForSelector('#detail', { state: 'hidden' });
  assert.ok(await page.$('.row[data-sym="AAPL"]'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('price alert fires on refresh, then shows as triggered', async () => {
  const { ctx, page, errors } = await newPage();
  await mockData(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  await page.click('.tabbar a[data-tab="alerts"]');
  await page.click('#first-alert');
  await page.fill('#alert-form input[name="symbol"]', 'aapl');
  await page.click('#cond button[data-cond="above"]');
  await page.fill('#alert-form input[name="price"]', '185');
  await page.click('#alert-form button[type="submit"]');
  await page.waitForSelector('.alert-item .pill.armed');
  // A second alert that must not fire.
  await page.click('#new-alert');
  await page.fill('#alert-form input[name="symbol"]', 'TSLA');
  await page.click('#cond button[data-cond="below"]');
  await page.fill('#alert-form input[name="price"]', '100');
  // Saving an alert for an untracked symbol triggers a refresh, which evaluates all alerts.
  await page.click('#alert-form button[type="submit"]');
  await page.waitForSelector('.toast.alert:has-text("AAPL")');
  await page.waitForSelector('.alert-item .pill.fired');
  assert.equal((await page.$$('.pill.fired')).length, 1);
  assert.equal((await page.$$('.pill.armed')).length, 1);
  assert.match(await page.textContent('#alert-list'), /Hit 190\.00/);
  // Re-arm with the toggle.
  await page.click('.alert-item:has(.pill.fired) .switch');
  await page.waitForFunction(() => document.querySelectorAll('.pill.armed').length === 2 || document.querySelectorAll('.pill.fired').length === 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('falls back to the next proxy and remembers it', async () => {
  const { ctx, page, errors } = await newPage();
  const calls = await mockData(page, { failProxies: ['ziggy.g1011010.workers.dev'] });
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('ziggy:settings')));
  assert.equal(s.lastGoodProxy, 'allorigins');
  assert.ok(calls.includes('ziggy.g1011010.workers.dev') && calls.includes('api.allorigins.win'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('shows cached prices as stale when data is unavailable', async () => {
  const { ctx, page, errors } = await newPage();
  await mockData(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockData(page, { offline: true });
  await page.reload();
  await page.waitForSelector('#status:has-text("Data unavailable")');
  assert.equal(await page.textContent('.row[data-sym="AAPL"] .px b'), '190.00');
  assert.ok(await page.$('.row[data-sym="AAPL"] .badge.stale'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('swipe left reveals delete; edit mode reorders and removes', async () => {
  const { ctx, page, errors } = await newPage({ ...devices['Desktop Chrome'], viewport: { width: 400, height: 800 } });
  await mockData(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  const row = await page.$('.row[data-sym="MSFT"] .row-inner');
  const b = await row.boundingBox();
  await page.mouse.move(b.x + b.width - 20, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 140, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector('.row.open[data-sym="MSFT"]');
  await page.click('.row[data-sym="MSFT"] .row-del');
  await page.waitForFunction(() => !document.querySelector('.row[data-sym="MSFT"]'));

  await page.click('#edit-btn');
  const h = await (await page.$('.row[data-sym="^GSPC"] .handle')).boundingBox();
  const target = await (await page.$('.row[data-sym="AAPL"]')).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, target.y + target.height * 0.9, { steps: 12 });
  await page.mouse.up();
  const order = await page.evaluate(() => JSON.parse(localStorage.getItem('ziggy:watchlist')));
  assert.deepEqual(order, ['^IXIC', 'AAPL', '^GSPC', 'NVDA', 'GOOGL', 'ANT', 'EURUSD=X', 'BTC-USD', 'ETH-USD']);
  await page.click('.row[data-sym="BTC-USD"] .rm');
  await page.waitForFunction(() => !document.querySelector('.row[data-sym="BTC-USD"]'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('settings: export/import round-trip and unknown symbol handling', async () => {
  const { ctx, page, errors } = await newPage({ acceptDownloads: true });
  await mockData(page);
  await page.goto(base + '#/settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const data = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.equal(data.app, 'ziggy');
  assert.equal(data.watchlist.length, 10);
  data.watchlist = ['AAPL', 'NOPE123'];
  const tmp = path.join(require('node:os').tmpdir(), `ziggy-import-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data));
  await page.setInputFiles('#import-file', tmp);
  await page.waitForSelector('.toast:has-text("2 symbols")');
  await page.click('.tabbar a[data-tab="watchlist"]');
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  // Unknown symbol stays listed without a price, and nothing crashes.
  assert.equal(await page.textContent('.row[data-sym="NOPE123"] .px b'), '—');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('existing saved watchlists get new symbols merged in once', async () => {
  const { ctx, page, errors } = await newPage();
  await mockData(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('ziggy:watchlist', JSON.stringify(['TSLA', 'AAPL']));
    }
  });
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="ETH-USD"]');
  let syms = await page.$$eval('.row', (rs) => rs.map((r) => r.dataset.sym));
  assert.deepEqual(syms, ['TSLA', 'AAPL', 'NVDA', 'GOOGL', 'BTC-USD', 'ETH-USD', '^IXIC', 'ANT']);
  // A removed symbol does not come back.
  await page.click('#edit-btn');
  await page.click('.row[data-sym="NVDA"] .rm');
  await page.reload();
  await page.waitForSelector('.row[data-sym="ETH-USD"]');
  syms = await page.$$eval('.row', (rs) => rs.map((r) => r.dataset.sym));
  assert.ok(!syms.includes('NVDA'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('manual refresh fetches fresh data, reports it, and survives a stalled proxy', async () => {
  const { ctx, page, errors } = await newPage();
  const prices = { AAPL: [190, 187.5] };
  await mockData(page, { prices });
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  prices.AAPL = [191.25, 187.5];
  await page.click('#refresh-btn');
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("191.25")');
  await page.waitForSelector('.toast:has-text("Prices updated")');

  // A proxy that sends headers then never finishes the body must time out, not hang.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(/workers\.dev|corsproxy\.io|allorigins\.win|codetabs\.com/, () => { /* never fulfilled */ });
  await page.click('#refresh-btn');
  await page.waitForSelector('#refresh-btn.spinning');
  await page.click('#refresh-btn');
  await page.waitForSelector('.toast:has-text("Refreshing")');
  await page.waitForSelector('.toast:has-text("Refresh failed")', { timeout: 120000 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  prices.AAPL = [192.5, 187.5];
  await mockData(page, { prices });
  await page.click('#refresh-btn');
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("192.50")');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('requests carry a cache-busting parameter', async () => {
  const { ctx, page } = await newPage();
  const urls = [];
  page.on('request', (r) => { if (r.url().includes('workers.dev')) urls.push(new URL(new URL(r.url()).searchParams.get('url'))); });
  await mockData(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  assert.ok(urls.length && urls.every((u) => u.searchParams.has('_')));
  await ctx.close();
});

test('watchlist uses one batched request; misses fall back per symbol', async () => {
  const { ctx, page, errors } = await newPage();
  const calls = await mockData(page, { sparkSkips: ['MSFT'] });
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="MSFT"] .px b:text("420.00")');
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  const paths = calls.targets.map((t) => t.pathname);
  assert.equal(paths.filter((p) => p.includes('/spark')).length, 1);
  assert.deepEqual(paths.filter((p) => p.includes('/chart/')).map((p) => decodeURIComponent(p.split('/').pop())), ['MSFT']);
  // Names from the richer per-symbol response survive later lean batch refreshes.
  await page.click('#refresh-btn');
  await page.waitForSelector('.toast:has-text("Prices updated")');
  assert.equal(await page.textContent('.row[data-sym="MSFT"] .sym small'), 'MSFT Test Co');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('falls back to per-symbol requests when batching is rejected', async () => {
  const { ctx, page, errors } = await newPage();
  const calls = await mockData(page, { noSpark: true });
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="ETH-USD"] .px b:text("3,400.00")');
  await page.click('#refresh-btn');
  await page.waitForSelector('.toast:has-text("Prices updated")');
  // After one rejected batch, the app stops trying batches this session.
  assert.equal(calls.targets.filter((t) => t.pathname.includes('/spark')).length, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a stalled proxy is overtaken by the next one within seconds', async () => {
  const { ctx, page, errors } = await newPage();
  await mockData(page, { stallProxies: ['ziggy.g1011010.workers.dev'] });
  const t0 = Date.now();
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  const ms = Date.now() - t0;
  assert.ok(ms < 6000, `took ${ms} ms`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('1D chart appears instantly from watchlist data even if the network stalls', async () => {
  const { ctx, page, errors } = await newPage();
  await mockData(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(/workers\.dev|corsproxy\.io|allorigins\.win|codetabs\.com/, () => { /* never answers */ });
  await page.click('.row[data-sym="AAPL"] .sym');
  await page.waitForSelector('#d-chart canvas', { timeout: 1500 });
  assert.ok(await page.$eval('#d-msg', (m) => m.hidden));
  assert.deepEqual(errors, []);
  await ctx.close();
});

async function withKey(page, key = 'test-key') {
  await page.addInitScript((k) => {
    if (!sessionStorage.getItem('keyed')) {
      sessionStorage.setItem('keyed', '1');
      localStorage.setItem('ziggy:settings', JSON.stringify({ finnhubKey: k }));
    }
  }, key);
}

test('finnhub: US stocks and crypto priced from Finnhub, indices/FX from Yahoo', async () => {
  const { ctx, page, errors } = await newPage();
  await withKey(page);
  const yahoo = await mockData(page);
  const fh = await mockFinnhub(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("191.11")');
  await page.waitForSelector('.row[data-sym="BTC-USD"] .px b:text("97,111.00")');
  await page.waitForSelector('.row[data-sym="^GSPC"] .px b:text("5,900.00")');
  await page.waitForSelector('.row[data-sym="EURUSD=X"] .px b:text("1.0832")');
  // Yahoo's batch was only asked for what Finnhub doesn't cover (plus the background sparkline backfill).
  const firstSpark = yahoo.targets.find((t) => t.pathname.includes('/spark'));
  assert.deepEqual(firstSpark.searchParams.get('symbols').split(','), ['^GSPC', '^IXIC', 'EURUSD=X']);
  assert.ok(fh.includes('/api/v1/quote?BINANCE:ETHUSDT'));
  // Company names come from Finnhub profiles; sparklines get backfilled from Yahoo.
  await page.waitForSelector('.row[data-sym="NVDA"] .sym small:text("NVDA Finnhub Inc")');
  await page.waitForFunction(() => document.querySelectorAll('.row[data-sym="AAPL"] svg.spark path').length === 1);
  // Live Finnhub price is kept after the Yahoo backfill.
  assert.equal(await page.textContent('.row[data-sym="AAPL"] .px b'), '191.11');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('finnhub: chart falls back to Yahoo when candles are not in the plan', async () => {
  const { ctx, page, errors } = await newPage();
  await withKey(page);
  await mockData(page);
  const fh = await mockFinnhub(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("191.11")');
  await page.click('.row[data-sym="AAPL"] .sym');
  await page.click('#d-ranges button[data-range="1Y"]');
  await page.waitForFunction(() => document.querySelector('#d-msg').hidden && document.querySelector('#d-chart canvas'));
  await page.click('#d-ranges button[data-range="5Y"]');
  await page.waitForFunction(() => document.querySelector('#d-msg').hidden && document.querySelector('#d-chart canvas'));
  // After the first 403, Finnhub candles aren't requested again.
  assert.equal(fh.filter((c) => c.includes('/candle')).length, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('finnhub: candles used when the plan allows them', async () => {
  const { ctx, page, errors } = await newPage();
  await withKey(page);
  const yahoo = await mockData(page);
  await mockFinnhub(page, { candles: 'ok' });
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("191.11")');
  await page.click('.row[data-sym="AAPL"] .sym');
  await page.click('#d-ranges button[data-range="1M"]');
  await page.waitForFunction(() => document.querySelector('#d-msg').hidden && document.querySelector('#d-chart canvas'));
  assert.ok(!yahoo.targets.some((t) => t.pathname.endsWith('/AAPL') && t.searchParams.get('range') === '1mo'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('finnhub: invalid key falls back to Yahoo and Settings reports it', async () => {
  const { ctx, page, errors } = await newPage();
  await withKey(page, 'bad');
  await mockData(page);
  await mockFinnhub(page, { invalid: true });
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  await page.click('.tabbar a[data-tab="settings"]');
  await page.click('#test-fh');
  await page.waitForSelector('#fh-out:has-text("invalid API key")');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('finnhub: key is saved from Settings, used, and never exported', async () => {
  const { ctx, page, errors } = await newPage({ acceptDownloads: true });
  await mockData(page);
  await mockFinnhub(page);
  await page.goto(base + '#/settings');
  await page.fill('#set-fh', 'secret-key');
  await page.click('#test-fh');
  await page.waitForSelector('#fh-out:has-text("Finnhub works")');
  await page.click('.tabbar a[data-tab="watchlist"]');
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("191.11")');
  await page.click('.tabbar a[data-tab="settings"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.ok(!text.includes('secret-key'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('own relay is preferred even if another proxy worked last time', async () => {
  const { ctx, page, errors } = await newPage();
  await page.addInitScript(() => { if (!sessionStorage.s) { sessionStorage.s = 1; localStorage.setItem('ziggy:settings', JSON.stringify({ lastGoodProxy: 'allorigins' })); } });
  const calls = await mockData(page);
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  assert.ok(calls.length && calls.every((h) => h === 'ziggy.g1011010.workers.dev'), calls.join(','));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('own relay: bare address is accepted and used exclusively', async () => {
  const { ctx, page, errors } = await newPage();
  const calls = await mockData(page);
  await page.goto(base);
  const tpl = await page.evaluate(async () => {
    const { proxyTemplate } = await import('./js/api.js');
    return [proxyTemplate('https://ziggy.me.workers.dev'), proxyTemplate('https://ziggy.me.workers.dev/'), proxyTemplate('https://x.dev/?url={url}'), proxyTemplate('ziggy.me.workers.dev')];
  });
  assert.deepEqual(tpl, ['https://ziggy.me.workers.dev/?url={url}', 'https://ziggy.me.workers.dev/?url={url}', 'https://x.dev/?url={url}', null]);
  await page.goto(base + '#/settings');
  await page.selectOption('#set-proxy', 'custom');
  await page.fill('#set-custom', 'https://api.allorigins.win/raw');
  await page.click('#test-proxy');
  await page.waitForSelector('#test-out:has-text("Working via Your relay")');
  calls.length = 0;
  await page.click('.tabbar a[data-tab="watchlist"]');
  await page.click('#refresh-btn');
  await page.waitForSelector('.toast:has-text("Prices updated")');
  assert.ok(calls.length && calls.every((h) => h === 'api.allorigins.win'), calls.join(','));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('manifest and service worker are valid', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src);
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/^\s+'([^']+)',$/gm)].map((x) => x[1]).filter((x) => x !== './');
  for (const f of shell) assert.ok(fs.existsSync(path.join(ROOT, f)), `sw shell file ${f}`);

  // Registers and caches the shell when allowed.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await mockData(page);
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cached = await page.evaluate(async () => (await (await caches.open('ziggy-v8')).keys()).length);
  assert.ok(cached >= shell.length, `cached ${cached}`);
  await ctx.close();
});
