// Ziggy's own CORS proxy — a Cloudflare Worker (free tier is plenty).
//
// Deploy: dash.cloudflare.com → Workers & Pages → Create → "Hello World"
// worker → Edit code → paste this file → Deploy. Then in Ziggy:
// Settings → Data source → Custom, and enter
//   https://<your-worker>.<your-subdomain>.workers.dev/?url={url}
//
// It only forwards requests to Yahoo Finance, so it can't be abused as an
// open proxy.

const ALLOWED_HOSTS = new Set(['query1.finance.yahoo.com', 'query2.finance.yahoo.com']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS });

    let target;
    try {
      target = new URL(new URL(request.url).searchParams.get('url'));
    } catch {
      return new Response('Missing or invalid ?url=', { status: 400, headers: CORS });
    }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
      return new Response('Host not allowed', { status: 403, headers: CORS });
    }

    const upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZiggyProxy/1.0)', Accept: 'application/json' },
      cf: { cacheTtl: 10, cacheEverything: true }, // brief edge cache softens bursts
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  },
};
