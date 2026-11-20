# Ziggy

A lightweight market tracker for your phone. It's an installable PWA with no backend, no account and no build step.

- **Watchlist**: US and international stocks, ETFs, indices, FX and crypto, each with its live price, % change and an intraday sparkline. Swipe to delete, drag to reorder, pull to refresh.
- **Charts**: 1D / 5D / 1M / 6M / 1Y / 5Y ranges. Drag a finger across the chart to see the price and time at any point.
- **Price alerts**: get a banner, a vibration and a notification when a price goes above or below your target. Alerts are checked on each refresh while the app is open.
- **Offline**: the app shell is cached, and the last known prices are shown (marked stale) when there's no connection.
- **Device-only data**: everything is stored in `localStorage`. You can export and import a JSON backup in Settings.

See [SPEC.md](SPEC.md) for the full v1 spec.

## Install on your phone

1. Open the GitHub Pages URL (e.g. `https://<user>.github.io/ziggy/`).
2. **iPhone (Safari):** tap Share, then **Add to Home Screen**. Notifications need iOS 16.4+ and only work when the app is opened from the home screen.
3. **Android (Chrome):** tap ⋮, then **Install app** (or **Add to Home screen**).

## Deploy

Every push to `main` deploys via `.github/workflows/pages.yml`. Before the first deploy, set this once in the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Run locally

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

## Data source

### Finnhub (recommended)

Add a free key from [finnhub.io/register](https://finnhub.io/register) in **Settings → Finnhub**. This gets you:
- **Fast prices:** US stocks and crypto load quickly and reliably straight from Finnhub, with no relay in between.
- **Names and search:** company names and search results come from Finnhub too.
- **Charts, if your plan allows:** charts use Finnhub when your plan includes candles, and fall back to Yahoo otherwise.

The key is stored only on the device and is never included in backups. Indices (`^GSPC`), FX (`EURUSD=X`) and non-US listings (`VOD.L`) aren't on Finnhub's free plan, so they still come from Yahoo. Sparklines keep a live trail of Finnhub prices and are backfilled from Yahoo every few minutes.

### Yahoo

Quotes and charts come from Yahoo Finance's unofficial `v8/finance/chart` and `v1/finance/search` endpoints. Yahoo doesn't send CORS headers, so requests go through a public CORS proxy. The app uses allorigins.win and codetabs.com, and remembers whichever one last worked. (corsproxy.io now requires an API key, so it was removed.)

Public proxies can be slow or disappear. You can enter your own proxy in **Settings → Data source → Custom** as a URL template containing `{url}`, for example a Cloudflare Worker at `https://my-proxy.workers.dev/?url={url}`.

To keep relays from rate-limiting the app, the whole watchlist is fetched in one batched request. If a relay hasn't answered after 2.5 seconds, the next one starts in parallel, and relays that fail are benched for a few minutes. Charts are cached, and the 1D chart opens instantly from the watchlist's own data.

### Your own proxy (fastest and most reliable)

`worker/proxy.js` is a ready-made Cloudflare Worker that only forwards requests to Yahoo. To set it up:

1. Go to **dash.cloudflare.com → Workers & Pages → Create → Hello World**.
2. Click **Edit code**, paste in `worker/proxy.js`, then click **Deploy**.
3. In Ziggy, go to **Settings → Data source → Custom** and enter `https://<name>.<subdomain>.workers.dev/?url={url}`.

Data is often delayed and is **not suitable for trading decisions**.

## Tests

```sh
cd test && npm install && npm test
```

The tests drive the app in headless Chromium against recorded Yahoo-style responses, so they need no network access.

## Project layout

```
index.html, manifest.webmanifest, sw.js
css/app.css
js/app.js       routing, views, refresh loop, gestures
js/api.js       Yahoo + proxy fallback
js/store.js     localStorage persistence
js/alerts.js    alert evaluation + notifications
js/chart.js     sparklines + uPlot detail chart
js/format.js    formatting helpers
vendor/uplot/   uPlot 1.6.31 (MIT)
```
