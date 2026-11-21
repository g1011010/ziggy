import { store } from './store.js';
import { getQuotes, getSpark, getChart, peekChart, isChartFresh, search, fetchJSON, proxyTemplate, PROXIES, RANGES } from './api.js';
import { hasFinnhub, toFinnhub, fhName, fhTest } from './finnhub.js';
import { evaluate, newAlert, notify, notificationState, requestNotifications } from './alerts.js';
import { sparkline, detailChart } from './chart.js';
import { esc, fmtPrice, fmtChange, fmtPct, fmtTime, fmtDateTime, isMarketOpen } from './format.js';

const MAX_WATCHLIST = 25;
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  quotes: {},          // symbol -> { quote, series, ts, stale }
  lastUpdated: null,
  lastError: null,
  refreshing: false,
  timer: null,
  editing: false,
  interacting: false,  // swipe/drag in progress: don't re-render the list
  detail: null,        // { symbol, range, destroy }
  navigated: false,    // true once an in-app navigation has happened
};

// ---------- Boot ----------

function init() {
  // Seed from cache so the list renders instantly (marked stale until refreshed).
  const cache = store.getCache();
  for (const [sym, entry] of Object.entries(cache)) state.quotes[sym] = { ...entry, stale: true };

  window.addEventListener('hashchange', () => { state.navigated = true; route(); });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', () => { renderStatus(); refresh(); });
  window.addEventListener('offline', renderStatus);
  setupPullToRefresh();

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }

  route();
  refresh();
}

function onVisibility() {
  if (document.hidden) {
    clearTimeout(state.timer);
  } else {
    refresh();
  }
}

function scheduleNext() {
  clearTimeout(state.timer);
  const secs = store.getSettings().refresh;
  if (secs > 0 && !document.hidden) state.timer = setTimeout(refresh, secs * 1000);
}

// ---------- Data refresh ----------

function trackedSymbols() {
  const alertSyms = store.getAlerts().filter((a) => a.active).map((a) => a.symbol);
  return [...new Set([...store.getWatchlist(), ...alertSyms])];
}

async function refresh({ manual = false } = {}) {
  if (state.refreshing) {
    if (manual) toast('Refreshing…', 'Still waiting on the data source.');
    return;
  }
  state.refreshing = true;
  renderStatus();
  setRefreshSpinner(true);

  const symbols = trackedSymbols();
  const prices = {};
  let okCount = 0;
  let firstErr = null;
  const applied = new Set();
  const apply = (r, sym) => {
    if (!r || applied.has(sym)) return;
    if (r.ok) {
      applied.add(sym);
      okCount++;
      applyQuote(sym, r.value);
      prices[sym] = r.value.quote.price;
    } else {
      firstErr = firstErr || r.error;
      if (state.quotes[sym]) state.quotes[sym].stale = true;
    }
  };

  const results = await getQuotes(symbols, {
    // Finnhub answers first: show those prices right away.
    onPartial: (partial) => {
      partial.forEach((r, i) => apply(r, symbols[i]));
      state.lastUpdated = Date.now();
      renderStatus();
      rerenderCurrent();
    },
  });
  results.forEach((r, i) => apply(r, symbols[i]));
  backfillFinnhub(symbols);

  if (okCount) state.lastUpdated = Date.now();
  state.lastError = symbols.length && !okCount ? firstErr : null;
  state.refreshing = false;

  for (const a of evaluate(prices)) {
    const msg = `${a.symbol} is ${a.cond} ${fmtPrice(a.price, a.symbol)} — now ${fmtPrice(a.triggeredPrice, a.symbol)}`;
    toast(`🔔 Alert: ${a.symbol}`, msg, 'alert', 12000);
    notify(`Ziggy alert: ${a.symbol}`, msg);
  }

  setRefreshSpinner(false);
  renderStatus();
  rerenderCurrent();
  scheduleNext();

  if (manual) {
    if (!symbols.length) toast('Nothing to refresh', 'Add a symbol first.');
    else if (!okCount) toast('Refresh failed', `${firstErr?.message || 'No data'}. Try another proxy in Settings.`, 'error', 5000);
    else if (okCount < symbols.length) toast('Partly updated', `${okCount} of ${symbols.length} symbols updated.`);
    else toast('Prices updated', `${okCount} symbols · ${fmtTime(state.lastUpdated)}`);
  }
}

/**
 * Store a fresh quote. Finnhub quotes come without an intraday series, so the
 * sparkline is kept going by appending each new price to today's trail.
 */
function applyQuote(sym, value) {
  const prev = state.quotes[sym];
  let series = value.series;
  if (!series) {
    const now = Math.floor(Date.now() / 1000);
    const old = prev?.series;
    const fresh = old?.t?.length && now - old.t[old.t.length - 1] < 12 * 3600;
    const base = fresh ? old : { t: [], v: [] };
    series = { t: [...base.t, now].slice(-400), v: [...base.v, value.quote.price].slice(-400) };
  }
  // Leaner responses (batch / Finnhub) must not wipe earlier details like names.
  const entry = { quote: mergeQuote(prev?.quote, value.quote), series, ts: Date.now() };
  state.quotes[sym] = { ...entry, stale: false };
  store.setCached(sym, entry);
  if (value.quote.name) store.setMeta(sym, { name: value.quote.name });
}

let lastBackfill = 0;
const nameTried = new Set();

/**
 * For Finnhub-priced symbols: fetch company names once, and every few minutes
 * pull Yahoo's intraday series in the background so sparklines show the whole
 * day. Never blocks the refresh.
 */
function backfillFinnhub(symbols) {
  if (!hasFinnhub()) return;
  const fh = symbols.filter((s) => toFinnhub(s));
  for (const s of fh) {
    if (store.getMeta()[s]?.name || nameTried.has(s)) continue;
    nameTried.add(s);
    fhName(s).then((name) => {
      if (!name) return;
      store.setMeta(s, { name });
      if (state.quotes[s]) state.quotes[s].quote = { ...state.quotes[s].quote, name };
      rerenderCurrent();
    }).catch(() => {});
  }
  if (Date.now() - lastBackfill < 5 * 60e3) return;
  lastBackfill = Date.now();
  getSpark(fh).then((found) => {
    for (const [s, y] of Object.entries(found)) {
      const cur = state.quotes[s];
      if (!cur) continue;
      // Keep the live Finnhub price; take Yahoo's series and extra details.
      const quote = mergeQuote(y.quote, cur.quote);
      const series = { t: [...y.series.t], v: [...y.series.v] };
      const last = series.t[series.t.length - 1];
      if (cur.ts / 1000 > last) { series.t.push(Math.floor(cur.ts / 1000)); series.v.push(cur.quote.price); }
      const entry = { quote, series, ts: cur.ts };
      state.quotes[s] = { ...entry, stale: cur.stale };
      store.setCached(s, entry);
    }
    if (Object.keys(found).length) rerenderCurrent();
  }).catch(() => {});
}

function mergeQuote(prev, next) {
  if (!prev) return next;
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) if (v != null && v !== '') out[k] = v;
  return out;
}

function setRefreshSpinner(on) {
  $('#refresh-btn')?.classList.toggle('spinning', on);
  const ptr = $('#ptr');
  if (!on && ptr) { ptr.classList.remove('loading', 'ready'); ptr.style.opacity = 0; ptr.style.transform = ''; }
}

// ---------- Routing ----------

function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/s\/(.+)$/);
  if (m) {
    openDetail(decodeURIComponent(m[1]));
    return;
  }
  closeDetail();
  const tab = hash.startsWith('#/alerts') ? 'alerts' : hash.startsWith('#/settings') ? 'settings' : 'watchlist';
  if (tab !== 'watchlist') state.editing = false;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.querySelectorAll('.tabbar a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === tab));
  renderView(tab);
  $('#view').scrollTop = 0;
}

function currentTab() {
  return document.querySelector('.tabbar a.active')?.dataset.tab || 'watchlist';
}

function renderView(tab) {
  if (tab === 'alerts') renderAlerts();
  else if (tab === 'settings') renderSettings();
  else renderWatchlist();
}

function rerenderCurrent() {
  if (state.detail) updateDetailHeader();
  const tab = currentTab();
  if (tab === 'watchlist' && !state.interacting) renderWatchlist();
  else if (tab === 'alerts') renderAlerts();
}

// ---------- Status line ----------

function renderStatus() {
  const el = $('#status');
  if (!el) return;
  const offline = !navigator.onLine;
  let text;
  if (offline) text = 'Offline — showing saved prices';
  else if (state.refreshing && !state.lastUpdated) text = 'Loading…';
  else if (state.lastError) text = 'Data unavailable — check Settings › Data source';
  else if (state.lastUpdated) text = `Updated ${fmtTime(state.lastUpdated)}`;
  else text = 'Not updated yet';
  el.innerHTML = `<span class="dot${offline || state.lastError ? ' offline' : ''}"></span>${esc(text)}`;
}

function setTopbar(title, actionsHtml) {
  $('#title').textContent = title;
  $('#actions').innerHTML = actionsHtml;
}

const ICON_REFRESH = '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';

// ---------- Watchlist ----------

function changeClass(v) {
  return v == null || !Number.isFinite(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down';
}

function rowHtml(sym) {
  const entry = state.quotes[sym];
  const q = entry?.quote;
  const meta = store.getMeta()[sym] || {};
  const name = q?.name || meta.name || '';
  const cls = changeClass(q?.changePct);
  const open = q ? isMarketOpen(q) : null;
  const badge = entry?.stale && q
    ? '<span class="badge stale">stale</span>'
    : open === false ? '<span class="badge">closed</span>' : '';
  const spark = entry?.series ? sparkline(entry.series.v, q?.prevClose, (q?.change ?? 0) >= 0) : sparkline([]);
  return `
    <li class="row${entry?.stale ? ' is-stale' : ''}" data-sym="${esc(sym)}">
      <button class="row-del" data-act="delete" tabindex="-1">Delete</button>
      <div class="row-inner">
        <div class="lead">
          <button class="rm" data-act="delete" aria-label="Remove ${esc(sym)}">−</button>
          <span class="handle" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="12" height="2" rx="1"/><rect x="2" y="7" width="12" height="2" rx="1"/><rect x="2" y="11" width="12" height="2" rx="1"/></svg>
          </span>
        </div>
        <div class="sym"><b>${esc(sym)}${badge}</b><small>${esc(name) || '&nbsp;'}</small></div>
        <div class="spark-cell">${spark}</div>
        <div class="px">
          <b class="num">${q ? fmtPrice(q.price, sym) : '<span class="muted">—</span>'}</b>
          <span class="chg num ${cls}" title="${q ? esc(fmtChange(q.change, null, sym)) : ''}">${q ? fmtPct(q.changePct) : '…'}</span>
        </div>
      </div>
    </li>`;
}

function renderWatchlist() {
  const list = store.getWatchlist();
  setTopbar('Watchlist', `
    <button class="text-btn" id="edit-btn">${state.editing ? 'Done' : 'Edit'}</button>
    <button class="icon-btn${state.refreshing ? ' spinning' : ''}" id="refresh-btn" aria-label="Refresh">${ICON_REFRESH}</button>
    <button class="icon-btn" id="add-btn" aria-label="Add symbol">${ICON_PLUS}</button>`);
  $('#edit-btn').onclick = () => { state.editing = !state.editing; renderWatchlist(); };
  $('#refresh-btn').onclick = () => refresh({ manual: true });
  $('#add-btn').onclick = openSearch;

  const view = $('#view');
  if (!list.length) {
    view.innerHTML = `
      <div class="empty">
        <p>Your watchlist is empty.</p>
        <button class="btn primary" id="empty-add">Add a symbol</button>
      </div>`;
    $('#empty-add').onclick = openSearch;
    return;
  }
  view.innerHTML = `
    <ul class="list${state.editing ? ' editing' : ''}" id="wl">${list.map(rowHtml).join('')}</ul>
    <p class="hint">${state.editing ? 'Drag ≡ to reorder · tap − to remove' : 'Tap for chart · swipe left to remove · pull down to refresh'}</p>`;
  bindListGestures($('#wl'));
}

function removeSymbol(sym) {
  store.setWatchlist(store.getWatchlist().filter((s) => s !== sym));
  renderWatchlist();
  toast('Removed', `${sym} removed from watchlist`);
}

function addSymbol(sym, info = {}) {
  sym = sym.trim().toUpperCase();
  if (!sym) return false;
  const list = store.getWatchlist();
  if (list.includes(sym)) return false;
  if (list.length >= MAX_WATCHLIST) {
    toast('Watchlist full', `Up to ${MAX_WATCHLIST} symbols keeps the free data source happy.`, 'error');
    return false;
  }
  store.setWatchlist([...list, sym]);
  if (info.name) store.setMeta(sym, { name: info.name });
  getQuotes([sym]).then(([r]) => {
    if (!r.ok) return;
    applyQuote(sym, r.value);
    backfillFinnhub([sym]);
    rerenderCurrent();
  });
  return true;
}

// Swipe-to-delete, tap-to-open, and drag-to-reorder (edit mode).
function bindListGestures(ul) {
  let g = null;   // active gesture
  const OPEN_X = -88;

  const closeOthers = (except) => {
    ul.querySelectorAll('.row.open').forEach((r) => {
      if (r !== except) { r.classList.remove('open'); $('.row-inner', r).style.transform = ''; }
    });
  };

  ul.addEventListener('click', (e) => {
    if (g?.moved) return; // this click ends a swipe/drag
    const btn = e.target.closest('[data-act="delete"]');
    const row = e.target.closest('.row');
    if (!row) return;
    if (btn) { removeSymbol(row.dataset.sym); return; }
    if (state.editing) return;
    if (ul.querySelector('.row.open')) { closeOthers(null); state.interacting = false; return; }
    location.hash = `#/s/${encodeURIComponent(row.dataset.sym)}`;
  });

  ul.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.target.closest('button')) return;
    const handle = e.target.closest('.handle');
    if (state.editing) {
      if (!handle) return;
      e.preventDefault();
      g = { type: 'drag', row, id: e.pointerId, startY: e.clientY, moved: false };
      row.classList.add('dragging');
      state.interacting = true;
      handle.setPointerCapture(e.pointerId);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    g = {
      type: 'swipe', row, id: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false,
      base: row.classList.contains('open') ? OPEN_X : 0, dx: 0,
    };
  });

  ul.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    if (g.type === 'drag') {
      const dy = e.clientY - g.startY;
      g.moved = true;
      $('.row-inner', g.row).style.transform = `translateY(${dy}px)`;
      // Swap with neighbour once the dragged row passes its midpoint.
      const prev = g.row.previousElementSibling;
      const next = g.row.nextElementSibling;
      if (next && e.clientY > next.getBoundingClientRect().top + next.offsetHeight / 2) {
        next.after(g.row); g.startY += next.offsetHeight;
        $('.row-inner', g.row).style.transform = `translateY(${e.clientY - g.startY}px)`;
      } else if (prev && e.clientY < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
        prev.before(g.row); g.startY -= prev.offsetHeight;
        $('.row-inner', g.row).style.transform = `translateY(${e.clientY - g.startY}px)`;
      }
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      g.moved = true;
      state.interacting = true;
      closeOthers(g.row);
      g.row.classList.add('swiping');
    }
    g.dx = Math.min(0, Math.max(OPEN_X * 1.4, g.base + dx));
    $('.row-inner', g.row).style.transform = `translateX(${g.dx}px)`;
  });

  const finish = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const done = g;
    if (done.type === 'drag') {
      done.row.classList.remove('dragging');
      $('.row-inner', done.row).style.transform = '';
      const order = [...ul.querySelectorAll('.row')].map((r) => r.dataset.sym);
      store.setWatchlist(order);
    } else if (done.moved) {
      done.row.classList.remove('swiping');
      const open = done.dx < OPEN_X / 2;
      done.row.classList.toggle('open', open);
      $('.row-inner', done.row).style.transform = open ? `translateX(${OPEN_X}px)` : '';
    }
    state.interacting = !!ul.querySelector('.row.open');
    // Keep g briefly so the click that follows a swipe is ignored.
    setTimeout(() => { if (g === done) g = null; }, 0);
  };
  ul.addEventListener('pointerup', finish);
  ul.addEventListener('pointercancel', (e) => {
    if (g?.type === 'swipe' && g.moved) finish(e);
    else if (g?.type === 'drag') finish(e);
    else g = null;
  });
}

// Pull-to-refresh on the main view (touch only).
function setupPullToRefresh() {
  const view = $('#view');
  const ptr = $('#ptr');
  const THRESHOLD = 70;
  let startY = null, pulling = false, dist = 0;

  view.addEventListener('touchstart', (e) => {
    if (view.scrollTop > 0 || state.editing || currentTab() !== 'watchlist') { startY = null; return; }
    startY = e.touches[0].clientY; pulling = false; dist = 0;
  }, { passive: true });

  view.addEventListener('touchmove', (e) => {
    if (startY == null || state.interacting) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0 || view.scrollTop > 0) { ptr.style.opacity = 0; pulling = false; return; }
    pulling = true;
    const d = Math.min(dist, THRESHOLD * 1.5);
    ptr.style.opacity = Math.min(1, d / THRESHOLD);
    ptr.style.transform = `translateY(${d / 2 - 20}px) rotate(${d * 4}deg)`;
    ptr.classList.toggle('ready', dist >= THRESHOLD);
  }, { passive: true });

  view.addEventListener('touchend', () => {
    if (pulling && dist >= THRESHOLD) {
      ptr.classList.add('loading');
      ptr.style.transform = 'translateY(16px)';
      refresh({ manual: true });
    } else {
      ptr.style.opacity = 0; ptr.style.transform = '';
    }
    startY = null; pulling = false;
  });
}

// ---------- Search sheet ----------

function openSearch() {
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="sheet-grab"></div>
      <h2>Add symbol <button class="text-btn" data-close>Done</button></h2>
      <input class="input" id="q" type="search" placeholder="Search: Apple, VOD.L, BTC, EURUSD…" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search">
      <ul class="results" id="results"></ul>
      <p class="hint">Examples: <b>AAPL</b> · <b>VOD.L</b> (London) · <b>7203.T</b> (Tokyo) · <b>^GSPC</b> (S&amp;P 500) · <b>EURUSD=X</b> · <b>BTC-USD</b></p>
    </div>`;
  const input = $('#q', sheet);
  const results = $('#results', sheet);
  let timer = null, seq = 0;

  const draw = (items, q) => {
    const wl = store.getWatchlist();
    const exact = q.trim().toUpperCase();
    const rows = items.map((r) => `
      <li><button data-sym="${esc(r.symbol)}" data-name="${esc(r.name)}">
        <span class="r-sym">${esc(r.symbol)}</span>
        <span class="r-name">${esc(r.name)}</span>
        <span class="r-meta">${wl.includes(r.symbol) ? '<span class="added">✓ Added</span>' : `${esc(r.type)}<br>${esc(r.exchange)}`}</span>
      </button></li>`);
    if (exact && !items.some((r) => r.symbol === exact)) {
      rows.push(`<li><button data-sym="${esc(exact)}">
        <span class="r-sym">Add “${esc(exact)}”</span>
        <span class="r-name">Use this exact ticker</span>
        <span class="r-meta">${wl.includes(exact) ? '<span class="added">✓ Added</span>' : ''}</span>
      </button></li>`);
    }
    results.innerHTML = rows.join('');
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    draw([], q);
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const items = await search(q, (partial) => { if (my === seq) draw(partial, q); });
        if (my === seq) draw(items, q);
      } catch {
        if (my === seq) draw([], q);
      }
    }, 300);
  });

  results.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sym]');
    if (!b) return;
    if (addSymbol(b.dataset.sym, { name: b.dataset.name })) {
      $('.r-meta', b).innerHTML = '<span class="added">✓ Added</span>';
      renderWatchlist();
    }
  });

  sheet.querySelector('[data-close]').onclick = () => sheet.close();
  sheet.onclick = (e) => { if (e.target === sheet) sheet.close(); };
  sheet.onclose = () => { if (currentTab() === 'watchlist') renderWatchlist(); };
  sheet.showModal();
  setTimeout(() => input.focus(), 50);
}

// ---------- Detail view ----------

function openDetail(symbol) {
  const el = $('#detail');
  if (state.detail?.symbol === symbol) return;
  closeDetail();
  state.detail = { symbol, range: '1D', destroy: null, series: null, quote: null };
  el.hidden = false;
  el.scrollTop = 0;
  const inList = store.getWatchlist().includes(symbol);
  el.innerHTML = `
    <div class="detail-head">
      <button class="back" id="d-back"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>Back</button>
    </div>
    <h2 class="d-sym">${esc(symbol)}</h2>
    <p class="d-name" id="d-name">&nbsp;</p>
    <p class="d-price num" id="d-price">—</p>
    <p class="d-chg num" id="d-chg">&nbsp;</p>
    <div class="seg" id="d-ranges" role="group" aria-label="Chart range">
      ${RANGES.map((r) => `<button data-range="${r.id}" aria-pressed="${r.id === '1D'}">${r.id}</button>`).join('')}
    </div>
    <div class="chart-wrap"><div id="d-chart"></div><div class="chart-msg" id="d-msg">Loading chart…</div></div>
    <div class="stats" id="d-stats"></div>
    <div class="detail-actions">
      <button class="btn primary" id="d-alert">🔔 Set alert</button>
      <button class="btn" id="d-watch">${inList ? 'Remove' : '+ Watchlist'}</button>
    </div>
    <p class="disclaimer">Prices from Finnhub &amp; Yahoo Finance. May be delayed — not for trading decisions.</p>`;

  $('#d-back').onclick = () => {
    // Go back if we got here from inside the app; otherwise (deep link) go home.
    if (state.navigated) history.back();
    else location.hash = '#/';
  };
  $('#d-ranges').onclick = (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b || !state.detail) return;
    state.detail.range = b.dataset.range;
    $('#d-ranges').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    loadDetailChart();
  };
  $('#d-alert').onclick = () => openAlertEditor({ symbol });
  $('#d-watch').onclick = () => {
    if (store.getWatchlist().includes(symbol)) {
      store.setWatchlist(store.getWatchlist().filter((s) => s !== symbol));
      $('#d-watch').textContent = '+ Watchlist';
    } else if (addSymbol(symbol)) {
      $('#d-watch').textContent = 'Remove';
    }
  };
  document.addEventListener('keydown', detailKeys);

  updateDetailHeader();
  loadDetailChart();
}

function detailKeys(e) {
  if (e.key === 'Escape' && state.detail && !$('#sheet').open) location.hash = '#/';
}

function closeDetail() {
  if (!state.detail) return;
  state.detail.destroy?.();
  state.detail = null;
  document.removeEventListener('keydown', detailKeys);
  const el = $('#detail');
  el.hidden = true;
  el.innerHTML = '';
  if (currentTab() === 'watchlist') renderWatchlist();
}

function detailQuote() {
  const d = state.detail;
  return state.quotes[d.symbol]?.quote || d.quote;
}

function updateDetailHeader(scrubIdx = null) {
  const d = state.detail;
  if (!d) return;
  const q = detailQuote();
  const sym = d.symbol;
  const nameEl = $('#d-name');
  if (!nameEl) return;
  nameEl.textContent = q ? [q.name, q.exchange].filter(Boolean).join(' · ') : (store.getMeta()[sym]?.name || ' ');

  const priceEl = $('#d-price');
  const chgEl = $('#d-chg');
  const s = d.series;
  const intraday = d.range === '1D' || d.range === '5D';

  if (scrubIdx != null && s && s.v[scrubIdx] != null) {
    const v = s.v[scrubIdx];
    const ref = d.range === '1D' && q?.prevClose != null ? q.prevClose : s.v[0];
    const ch = v - ref;
    priceEl.innerHTML = `${fmtPrice(v, sym)}<small>${esc(q?.currency || '')}</small>`;
    chgEl.className = `d-chg num ${changeClass(ch)}`;
    chgEl.innerHTML = `${fmtChange(ch, ref ? (ch / ref) * 100 : null, sym)}<span class="when">${esc(fmtDateTime(s.t[scrubIdx], intraday))}</span>`;
    return;
  }

  if (!q) return;
  priceEl.innerHTML = `${fmtPrice(q.price, sym)}<small>${esc(q.currency)}</small>`;
  let ch = q.change, pct = q.changePct, label = 'today';
  if (d.range !== '1D' && s && s.v.length > 1) {
    const first = s.v[0];
    ch = q.price - first; pct = first ? (ch / first) * 100 : null;
    label = { '5D': 'past 5 days', '1M': 'past month', '6M': 'past 6 months', '1Y': 'past year', '5Y': 'past 5 years' }[d.range];
  }
  chgEl.className = `d-chg num ${changeClass(ch)}`;
  chgEl.innerHTML = `${fmtChange(ch, pct, sym)}<span class="when">${label}</span>`;
  renderStats(q);
}

function rangeStat(label, lo, hi, cur, sym) {
  if (lo == null || hi == null) return `<div class="stat"><span>${label}</span><b class="num">—</b></div>`;
  const pos = hi > lo ? Math.max(0, Math.min(100, ((cur - lo) / (hi - lo)) * 100)) : 50;
  return `<div class="stat"><span>${label}</span><b class="num">${fmtPrice(lo, sym)} – ${fmtPrice(hi, sym)}</b>
    <div class="range-bar"><i style="left:${pos}%"></i></div></div>`;
}

function renderStats(q) {
  const sym = state.detail.symbol;
  const open = isMarketOpen(q);
  const age = state.quotes[sym]?.ts;
  $('#d-stats').innerHTML = `
    ${rangeStat('Day range', q.dayLow, q.dayHigh, q.price, sym)}
    ${rangeStat('52-week range', q.low52, q.high52, q.price, sym)}
    <div class="stat"><span>Previous close</span><b class="num">${fmtPrice(q.prevClose, sym)}</b></div>
    <div class="stat"><span>Market</span><b>${open == null ? '—' : open ? '<span class="up">Open</span>' : 'Closed'}</b></div>
    <div class="stat"><span>Last trade</span><b>${q.marketTime ? esc(fmtDateTime(q.marketTime, true)) : '—'}</b></div>
    <div class="stat"><span>Fetched</span><b>${age ? esc(fmtTime(age)) : '—'}</b></div>`;
}

async function loadDetailChart() {
  const d = state.detail;
  if (!d) return;
  const { symbol, range } = d;
  const msg = $('#d-msg');

  // 1) Show something immediately: a cached chart for this range, or for 1D
  //    the intraday series the watchlist already has.
  const cached = peekChart(symbol, range);
  const wl = state.quotes[symbol];
  const instant = cached?.data
    || (range === '1D' && wl?.series?.v?.length > 1 ? { quote: wl.quote, series: wl.series } : null);
  if (instant) showDetailData(d, range, instant);
  else { msg.hidden = false; msg.textContent = 'Loading chart…'; }

  // 2) Fetch fresh data if needed and redraw.
  if (isChartFresh(symbol, range)) return;
  try {
    const data = await getChart(symbol, range);
    if (state.detail !== d || d.range !== range) return; // user moved on
    showDetailData(d, range, data);
  } catch (e) {
    if (state.detail !== d || d.range !== range) return;
    if (!instant) { msg.hidden = false; msg.textContent = `Couldn't load chart. ${e.message || ''}`; }
  }
}

function showDetailData(d, range, data) {
  const msg = $('#d-msg');
  if (!state.quotes[d.symbol]) d.quote = data.quote;
  d.series = data.series;
  d.destroy?.();
  d.destroy = null;

  if (data.series.v.length < 2) {
    $('#d-chart').innerHTML = '';
    msg.hidden = false;
    msg.textContent = 'No chart data for this range.';
    updateDetailHeader();
    return;
  }
  msg.hidden = true;

  const q = detailQuote() || data.quote;
  const first = data.series.v[0];
  const last = data.series.v[data.series.v.length - 1];
  const baseline = range === '1D' ? q.prevClose : null;
  const up = range === '1D' && q.prevClose != null ? last >= q.prevClose : last >= first;

  const startChart = () => {
    if (state.detail !== d || d.range !== range) return;
    d.destroy?.();
    d.destroy = detailChart($('#d-chart'), data.series, {
      up, baseline, intraday: range === '1D' || range === '5D',
      onScrub: (idx) => updateDetailHeader(idx),
    });
  };
  if (window.uPlot) startChart();
  else window.addEventListener('load', startChart, { once: true });
  updateDetailHeader();
}

// ---------- Alerts ----------

function openAlertEditor(existing = {}) {
  const sheet = $('#sheet');
  const isEdit = !!existing.id;
  const sym = existing.symbol || '';
  const cur = state.quotes[sym]?.quote?.price ?? state.detail?.quote?.price;
  const defaultCond = existing.cond || 'above';
  const defaultPrice = existing.price ?? (cur != null ? +(cur * (defaultCond === 'above' ? 1.05 : 0.95)).toPrecision(6) : '');

  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="sheet-grab"></div>
      <h2>${isEdit ? 'Edit alert' : 'New alert'} <button class="text-btn" data-close>Cancel</button></h2>
      <form id="alert-form" novalidate>
        <label class="field"><span>Symbol</span>
          <input class="input" name="symbol" value="${esc(sym)}" required autocapitalize="characters" spellcheck="false" placeholder="e.g. AAPL">
        </label>
        <div class="field"><span>Notify me when the price goes</span>
          <div class="seg" id="cond">
            <button type="button" data-cond="above" aria-pressed="${defaultCond === 'above'}">▲ Above</button>
            <button type="button" data-cond="below" aria-pressed="${defaultCond === 'below'}">▼ Below</button>
          </div>
        </div>
        <label class="field"><span>Target price${cur != null ? ` · now <b class="num">${fmtPrice(cur, sym)}</b>` : ''}</span>
          <input class="input num" name="price" type="number" inputmode="decimal" step="any" value="${esc(defaultPrice)}" required>
        </label>
        <p class="notice" id="alert-err" hidden></p>
        <button class="btn primary block" type="submit">${isEdit ? 'Save alert' : 'Create alert'}</button>
      </form>
    </div>`;

  let cond = defaultCond;
  $('#cond', sheet).onclick = (e) => {
    const b = e.target.closest('button[data-cond]');
    if (!b) return;
    cond = b.dataset.cond;
    $('#cond', sheet).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  };

  $('#alert-form', sheet).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const symbol = f.symbol.value.trim().toUpperCase();
    const price = parseFloat(f.price.value);
    const err = $('#alert-err', sheet);
    if (!symbol || !Number.isFinite(price) || price <= 0) {
      err.hidden = false;
      err.textContent = 'Enter a symbol and a target price above 0.';
      return;
    }
    const alerts = store.getAlerts();
    if (isEdit) {
      const a = alerts.find((x) => x.id === existing.id);
      if (a) Object.assign(a, { symbol, cond, price, active: true, triggeredAt: null, triggeredPrice: null });
    } else {
      alerts.push(newAlert({ symbol, cond, price }));
    }
    store.setAlerts(alerts);
    sheet.close();
    toast(isEdit ? 'Alert updated' : 'Alert created', `${symbol} ${cond} ${fmtPrice(price, symbol)}`);
    // Asking from inside the user's tap keeps browsers happy.
    if (notificationState() === 'default') await requestNotifications();
    if (currentTab() === 'alerts') renderAlerts();
    if (!state.quotes[symbol]) refresh();
  };

  sheet.querySelector('[data-close]').onclick = () => sheet.close();
  sheet.onclick = (e) => { if (e.target === sheet) sheet.close(); };
  sheet.onclose = null;
  sheet.showModal();
}

function notificationCard() {
  const s = notificationState();
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let body;
  if (s === 'granted') body = '<p>✅ Notifications are on.</p>';
  else if (s === 'denied') body = '<p>Notifications are blocked. Enable them for this app in your phone’s settings to get alert pop-ups. In-app banners still work.</p>';
  else if (s === 'unsupported') {
    body = ios && !standalone
      ? '<p>To get notifications on iPhone, tap <b>Share → Add to Home Screen</b>, then open Ziggy from your home screen.</p>'
      : '<p>This browser doesn’t support notifications. In-app banners still work.</p>';
  } else body = '<p>Turn on notifications to get a pop-up when an alert fires.</p><button class="btn" id="notif-btn">Enable notifications</button>';
  return `<div class="card notice">${body}
    <p>Alerts are checked on every refresh <b>while Ziggy is open</b> (or recently in the background). They can’t fire while the app is closed.</p></div>`;
}

function renderAlerts() {
  setTopbar('Alerts', `<button class="icon-btn" id="new-alert" aria-label="New alert">${ICON_PLUS}</button>`);
  $('#new-alert').onclick = () => openAlertEditor();
  const alerts = store.getAlerts();
  const items = alerts
    .slice()
    .sort((a, b) => (b.active - a.active) || a.symbol.localeCompare(b.symbol))
    .map((a) => {
      const q = state.quotes[a.symbol]?.quote;
      const status = a.active
        ? '<span class="pill armed">Armed</span>'
        : a.triggeredAt ? '<span class="pill fired">Triggered</span>' : '<span class="pill off">Off</span>';
      const sub = a.triggeredAt && !a.active
        ? `Hit ${fmtPrice(a.triggeredPrice, a.symbol)} · ${new Date(a.triggeredAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : q ? `Now ${fmtPrice(q.price, a.symbol)}` : 'Waiting for price…';
      return `
        <div class="alert-item" data-id="${esc(a.id)}">
          <div>
            <div class="t">${esc(a.symbol)} ${a.cond === 'above' ? '▲ above' : '▼ below'} <span class="num">${fmtPrice(a.price, a.symbol)}</span></div>
            <div class="s">${status} &nbsp;${esc(sub)}</div>
          </div>
          <label class="switch" aria-label="${a.active ? 'Disarm' : 'Arm'} alert">
            <input type="checkbox" data-act="toggle" ${a.active ? 'checked' : ''}><span></span>
          </label>
          <div class="acts">
            <button class="text-btn" data-act="edit">Edit</button>
            <button class="text-btn danger" data-act="del">Delete</button>
          </div>
        </div>`;
    }).join('');

  $('#view').innerHTML = `
    ${notificationCard()}
    <h3 class="section-title">Your alerts</h3>
    ${alerts.length
      ? `<div class="card" id="alert-list">${items}</div>`
      : `<div class="card empty"><p>No alerts yet.</p><button class="btn primary" id="first-alert">Create an alert</button></div>`}`;

  $('#notif-btn')?.addEventListener('click', async () => { await requestNotifications(); renderAlerts(); });
  $('#first-alert')?.addEventListener('click', () => openAlertEditor());
  $('#alert-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('.alert-item');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!item || !act || act === 'toggle') return;
    const list = store.getAlerts();
    const a = list.find((x) => x.id === item.dataset.id);
    if (!a) return;
    if (act === 'edit') openAlertEditor(a);
    if (act === 'del') { store.setAlerts(list.filter((x) => x !== a)); renderAlerts(); }
  });
  $('#alert-list')?.addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    const id = e.target.closest('.alert-item').dataset.id;
    const list = store.getAlerts();
    const a = list.find((x) => x.id === id);
    if (!a) return;
    a.active = e.target.checked;
    if (a.active) { a.triggeredAt = null; a.triggeredPrice = null; }
    store.setAlerts(list);
    renderAlerts();
    if (a.active) refresh();
  });
}

// ---------- Settings ----------

function renderSettings() {
  setTopbar('Settings', '');
  const s = store.getSettings();
  $('#view').innerHTML = `
    <h3 class="section-title">Refresh</h3>
    <div class="card">
      <label class="field" style="margin:0"><span>Auto-refresh while open</span>
        <select class="input" id="set-refresh">
          ${[[30, 'Every 30 seconds'], [60, 'Every 60 seconds'], [120, 'Every 2 minutes'], [0, 'Manual only']]
            .map(([v, l]) => `<option value="${v}" ${s.refresh === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
    </div>

    <h3 class="section-title">Finnhub (fast prices)</h3>
    <div class="card">
      <label class="field"><span>API key</span>
        <input class="input" id="set-fh" type="password" value="${esc(s.finnhubKey || '')}" placeholder="Paste your free Finnhub key" spellcheck="false" autocapitalize="off" autocomplete="off">
      </label>
      <div class="btn-row"><button class="btn" id="test-fh">Save &amp; test</button></div>
      <p class="notice" id="fh-out" style="margin-top:10px">${s.finnhubKey ? 'Key saved on this device.' : ''}</p>
      <p class="notice">With a key, US stocks and crypto load fast and reliably from Finnhub. Indices, FX and non-US listings still use Yahoo below. Get a free key at <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io/register</a>. It’s stored only on this device and left out of backups.</p>
    </div>

    <h3 class="section-title">Yahoo data source</h3>
    <div class="card">
      <label class="field"><span>CORS proxy</span>
        <select class="input" id="set-proxy">
          <option value="auto" ${s.proxy === 'auto' ? 'selected' : ''}>Automatic (try each, remember what works)</option>
          ${PROXIES.map((p) => `<option value="${p.id}" ${s.proxy === p.id ? 'selected' : ''}>${esc(p.name)} only</option>`).join('')}
          <option value="custom" ${s.proxy === 'custom' ? 'selected' : ''}>My own relay (Cloudflare Worker)</option>
        </select>
      </label>
      <label class="field" id="custom-wrap" ${s.proxy === 'custom' ? '' : 'hidden'}><span>Relay address</span>
        <input class="input" id="set-custom" type="url" value="${esc(s.customProxy)}" placeholder="https://ziggy.yourname.workers.dev" spellcheck="false" autocapitalize="off" autocomplete="off">
      </label>
      <div class="btn-row"><button class="btn" id="test-proxy">Test connection</button></div>
      <p class="notice" id="test-out" style="margin-top:10px">${s.lastGoodProxy ? `Last working: ${esc(PROXIES.find((p) => p.id === s.lastGoodProxy)?.name || s.lastGoodProxy)}` : ''}</p>
      <p class="notice">Prices come from Yahoo Finance’s unofficial endpoints through a free public proxy. Only ticker symbols are sent. Proxies can be slow or go offline; if data stops loading, try another one.</p>
    </div>

    <h3 class="section-title">Backup</h3>
    <div class="card">
      <p class="notice">Your watchlist and alerts live only on this device. Export a backup to move them or keep them safe.</p>
      <div class="btn-row">
        <button class="btn" id="export">Export</button>
        <label class="btn" for="import-file">Import</label>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>
    </div>

    <h3 class="section-title">Reset</h3>
    <div class="card">
      <button class="btn danger block" id="clear">Clear all data</button>
    </div>

    <p class="disclaimer">Ziggy v1.1 · Market data may be delayed and is not investment advice.<br>Charts by uPlot (MIT).</p>`;

  $('#set-refresh').onchange = (e) => { store.setSettings({ refresh: +e.target.value }); scheduleNext(); };
  $('#set-fh').onchange = (e) => { store.setSettings({ finnhubKey: e.target.value.trim() }); };
  $('#test-fh').onclick = async () => {
    const key = $('#set-fh').value.trim();
    store.setSettings({ finnhubKey: key });
    const out = $('#fh-out');
    if (!key) { out.textContent = 'Key removed — using Yahoo only.'; return; }
    out.textContent = 'Testing…';
    const t0 = performance.now();
    try {
      const p = await fhTest();
      out.innerHTML = `✅ Finnhub works — AAPL ${fmtPrice(p)} (${Math.round(performance.now() - t0)} ms)`;
      refresh();
    } catch (e) {
      out.textContent = `❌ ${e.message}`;
    }
  };
  $('#set-proxy').onchange = (e) => {
    store.setSettings({ proxy: e.target.value });
    $('#custom-wrap').hidden = e.target.value !== 'custom';
  };
  $('#set-custom').onchange = (e) => {
    const v = e.target.value.trim();
    if (v && !proxyTemplate(v)) { toast('Check the address', 'It should start with https://', 'error'); return; }
    store.setSettings({ customProxy: v });
  };
  $('#test-proxy').onclick = async () => {
    const out = $('#test-out');
    out.textContent = 'Testing…';
    const t0 = performance.now();
    try {
      const j = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d');
      const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (p == null) throw new Error('Unexpected response');
      const used = store.getSettings().proxy === 'custom' ? 'Your relay' : (PROXIES.find((x) => x.id === store.getSettings().lastGoodProxy)?.name || 'proxy');
      out.innerHTML = `✅ Working via ${esc(used)} — AAPL ${fmtPrice(p)} (${Math.round(performance.now() - t0)} ms)`;
      refresh();
    } catch (e) {
      out.textContent = `❌ ${e.message}`;
    }
  };
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ziggy-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  $('#import-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      store.importData(JSON.parse(await file.text()));
      toast('Imported', `${store.getWatchlist().length} symbols, ${store.getAlerts().length} alerts`);
      refresh();
      renderSettings();
    } catch (err) {
      toast('Import failed', err.message, 'error');
    }
  };
  $('#clear').onclick = () => {
    if (!confirm('Delete your watchlist, alerts and settings from this device?')) return;
    store.clearAll();
    state.quotes = {};
    toast('Cleared', 'Ziggy has been reset.');
    renderSettings();
    refresh();
  };
}

// ---------- Toasts ----------

function toast(title, body, kind = '', ms = 2500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span>`;
  el.onclick = () => el.remove();
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

init();
