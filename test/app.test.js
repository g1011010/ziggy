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

const { mockData } = require('./fixtures.js');

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
  assert.deepEqual(syms, ['^GSPC', '^IXIC', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'EURUSD=X', 'BTC-USD', 'ETH-USD']);
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
  assert.equal((await page.$$('.row')).length, 10);
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
  const calls = await mockData(page, { failProxies: ['corsproxy.io'] });
  await page.goto(base);
  await page.waitForSelector('.row[data-sym="AAPL"] .px b:text("190.00")');
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('ziggy:settings')));
  assert.equal(s.lastGoodProxy, 'allorigins');
  assert.ok(calls.includes('corsproxy.io') && calls.includes('api.allorigins.win'));
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
  assert.deepEqual(order, ['^IXIC', 'AAPL', '^GSPC', 'NVDA', 'GOOGL', 'EURUSD=X', 'BTC-USD', 'ETH-USD']);
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
  assert.equal(data.watchlist.length, 9);
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
  assert.deepEqual(syms, ['TSLA', 'AAPL', 'NVDA', 'GOOGL', 'BTC-USD', 'ETH-USD', '^IXIC']);
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
  const cached = await page.evaluate(async () => (await (await caches.open('ziggy-v2')).keys()).length);
  assert.ok(cached >= shell.length, `cached ${cached}`);
  await ctx.close();
});
