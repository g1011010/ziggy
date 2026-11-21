// Ziggy on Cloudflare Workers: serves the app AND acts as its Yahoo relay.
//
//   /?url=<encoded Yahoo URL>   → relay (CORS proxy, Yahoo hosts only)
//   everything else             → the app's static files (env.ASSETS)
//
// Deployed automatically from GitHub via wrangler.jsonc. It also still works
// pasted into the dashboard on its own (relay only, no app files).

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.has('url') || request.method === 'OPTIONS') return relay(request);
    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Missing or invalid ?url=', { status: 400, headers: CORS });
  },
};
