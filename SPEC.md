# Stock Tracker PWA: Spec v1

## 1. Summary
A dark-themed, installable Progressive Web App for tracking stocks, ETFs, indices, FX and crypto on a smartphone. It has no backend and no accounts, and all data stays on the device. Market data comes from Yahoo Finance's keyless endpoints through a public CORS proxy. It is hosted on GitHub Pages from a new, dedicated repository.

## 2. Decisions
| Area | Decision |
|---|---|
| Platform | PWA (iOS Safari 16.4+, Android Chrome), installable to the home screen |
| Stack | Vanilla HTML/CSS/JS (ES modules), no build step |
| Charts | uPlot (~50 KB), vendored into the repo so it works offline |
| Data | Yahoo Finance `v8/finance/chart` and `v1/finance/search` (keyless) |
| CORS | Public CORS proxy, with an ordered fallback list and a user-editable proxy URL |
| Storage | `localStorage` (watchlist, alerts, settings) on this device only |
| Refresh | Every 60 s while the app is visible, plus pull-to-refresh |
| Alerts | In-app only: checked on each refresh, shown as a banner and a local notification |
| Coverage | US stocks/ETFs, international stocks, indices, FX, crypto |
| Look | Dark finance style (green/red moves, dense list); also respects system light mode |
| Hosting | GitHub Pages, deployed by a GitHub Action on push to `main` |
| Repo | New separate repo (e.g. `stock-tracker`) |

## 3. Features (v1)

### 3.1 Watchlist (home screen)
- A list of tickers, each row showing the symbol, name, last price, absolute and % change, and a small intraday sparkline.
- Change is shown in green or red. A "market closed" or "delayed" badge appears where it applies.
- **Add**: a search box (Yahoo search) shows matches with exchange and type (Equity, ETF, Index, Currency, Crypto).
- **Remove**: swipe left, or use edit mode. **Reorder**: drag handle in edit mode.
- Starter list on first launch: `^GSPC`, `^IXIC`, `AAPL`, `MSFT`, `EURUSD=X`, `BTC-USD`.
- The header shows a "Last updated hh:mm:ss" label and an offline indicator.

### 3.2 Stock detail and price chart
- Tapping a row opens the detail view: large price, change, day range, 52-week range (where available), currency and exchange.
- Chart ranges and their intervals:
  - **1D**: 5 m
  - **5D**: 15 m
  - **1M**: 1 d
  - **6M**: 1 d
  - **1Y**: 1 d
  - **5Y**: 1 wk
- A touch crosshair shows the price and time at the finger position.
- The line is green if the price is up over the range and red if it is down.
- A "Set alert" button is on this view.

### 3.3 Price alerts
- Each alert has a symbol, a condition (`above` / `below`) and a target price.
- Each alert is one-shot: it fires once, then is marked "triggered" and can be re-armed.
- Alerts are evaluated on every refresh. When one fires:
  - an in-app banner appears;
  - the phone vibrates (where supported);
  - a local `Notification` is shown if permission was granted.
- **iOS limitation**: notifications only work when the app is installed to the home screen and running or recently backgrounded. There are no alerts while the app is closed. The Alerts screen states this.
- An Alerts tab lists all alerts, each with toggle, edit and delete.

### 3.4 Settings
- Refresh interval (default 60 s; options 30 / 60 / 120 / manual).
- CORS proxy: choose from the built-in list or enter a custom URL template.
- Export and import of the watchlist and alerts as JSON, as a backup since data is device-only.
- Clear all data.

## 4. Data layer
- **Quote and chart** (one endpoint for all asset types):
  `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={r}&interval={i}`
  - Price is read from `meta.regularMarketPrice`. Change is computed against `meta.chartPreviousClose` or `previousClose`.
- **Search**: `https://query1.finance.yahoo.com/v1/finance/search?q={text}&quotesCount=10&newsCount=0`
- **Symbol formats**:
  - US: `AAPL`
  - London: `VOD.L`
  - Tokyo: `7203.T`
  - Index: `^GSPC`
  - FX: `EURUSD=X`
  - Crypto: `BTC-USD`
- **Proxy**: each request is wrapped as `proxyTemplate.replace('{url}', encodeURIComponent(target))`.
  - On a failure or non-JSON response, the client tries the next proxy in the list and remembers the last one that worked.
- **Batching**: one chart request per symbol per refresh, at most 4 in parallel. A soft limit of about 25 watchlist items keeps the load on the proxy reasonable.
- **Caching**: the last good quote per symbol is kept in `localStorage`, so the app shows stale data (greyed, with a timestamp) when offline or when the proxy fails.
- **Visibility**: polling pauses when `document.hidden` and resumes with an immediate refresh when the app becomes visible again.

## 5. PWA details
- `manifest.webmanifest`: name, icons (192/512 plus maskable), `display: standalone`, dark `theme_color`.
- Service worker:
  - cache-first for the app shell (HTML/CSS/JS/uPlot/icons);
  - network-only for market data, with the app's own stale-data fallback.
- iOS meta tags: `apple-mobile-web-app-capable` and `apple-touch-icon`, plus safe-area insets for the notch and home bar.
- Layout is mobile-first (360–430 px wide) with bottom tab bar navigation: **Watchlist · Alerts · Settings**.

## 6. File layout
```
index.html
manifest.webmanifest
sw.js
css/app.css
js/app.js          – routing, refresh loop, UI wiring
js/api.js          – Yahoo + proxy fallback
js/store.js        – localStorage persistence
js/alerts.js       – evaluation + notifications
js/chart.js        – uPlot wrapper, sparklines
vendor/uplot/…
icons/…
.github/workflows/pages.yml
README.md
```

## 7. Known risks
- **Public CORS proxies** can be slow, rate-limited, or shut down without warning, and they can see your requests (ticker symbols only; no personal data is sent). This is mitigated by the fallback list and the user-editable proxy setting. Moving to your own Cloudflare Worker later is a one-line settings change.
- **Yahoo's endpoints are unofficial** and may change or throttle. Data is usually delayed 15+ minutes for many exchanges. This app is not for trading decisions.
- **No background alerts**: alerts only fire while the app is open.

## 8. Out of scope (v1)
Portfolio and cost basis, cloud sync and accounts, server push alerts, news, fundamentals, and options.

## 9. Acceptance criteria
1. The app installs to the home screen on iOS and Android and launches standalone.
2. Adding tickers from each asset class (US, international, index, FX, crypto) shows live prices and a sparkline.
3. The detail chart renders all six ranges with a working touch crosshair.
4. An alert set just above or below the current price triggers on refresh, with a banner and a notification (when permitted).
5. The watchlist and alerts survive an app restart. The last data shows (marked stale) when offline.
6. Pushing to `main` deploys to GitHub Pages automatically.
