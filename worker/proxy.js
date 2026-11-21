// Ziggy on Cloudflare Workers: serves the app AND acts as its Yahoo relay.
//
//   /?url=<encoded Yahoo URL>   → relay (CORS proxy, Yahoo hosts only)
//   everything else             → the app's files, bundled into worker/site.js
//
// Deploy with `npx wrangler deploy` (wrangler.jsonc runs the bundling step).

import { FILES } from './site.js';

const ALLOWED_HOSTS = new Set(['query1.finance.yahoo.com', 'query2.finance.yahoo.com']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

async function relay(request) {
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

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZiggyProxy/1.0)', Accept: 'application/json' },
      cf: { cacheTtl: 10, cacheEverything: true }, // brief edge cache softens bursts
    });
  } catch (e) {
    // Keep CORS headers on errors so the app sees a real message, not a CORS failure.
    return new Response(JSON.stringify({ error: `Upstream fetch failed: ${e.message}` }), {
      status: 502, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...CORS,
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

const BYTES = new Map(); // decoded lazily, once per isolate

function serveFile(request, pathname) {
  const path = pathname === '/' ? '/index.html' : pathname;
  const f = FILES[path];
  if (!f) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const headers = {
    'Content-Type': f.type,
    ETag: f.etag,
    'Cache-Control': 'no-cache', // always revalidate; the service worker handles offline
    'X-Content-Type-Options': 'nosniff',
  };
  if (request.headers.get('If-None-Match') === f.etag) return new Response(null, { status: 304, headers });
  if (!BYTES.has(path)) BYTES.set(path, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
  return new Response(request.method === 'HEAD' ? null : BYTES.get(path), { headers });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.searchParams.has('url') || request.method === 'OPTIONS') return relay(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    return serveFile(request, url.pathname);
  },
};
