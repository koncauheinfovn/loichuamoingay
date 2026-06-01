const DEFAULT_DATA_BASE_URL = 'https://raw.githubusercontent.com/koncauheinfovn/loichuamoingay/main/data';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-requested-with',
  'cache-control': 'public, max-age=300, s-maxage=900'
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function normalizeBaseUrl(env) {
  const value = env?.DATA_BASE_URL || DEFAULT_DATA_BASE_URL;
  return String(value).replace(/\/+$/, '');
}

function resolveStaticFile(pathname) {
  if (pathname === '/api/today') return 'today.json';
  if (pathname === '/api/week') return 'week.json';
  if (pathname === '/api/month') return 'month.json';
  if (pathname === '/api/years') return 'years.json';
  const year = pathname.match(/^\/api\/year\/(\d{4})$/);
  if (year) return `year-${year[1]}.json`;
  return null;
}

function parseDatePath(pathname) {
  const match = pathname.match(/^\/api\/date\/(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { date: `${match[1]}-${match[2]}-${match[3]}`, year: match[1] };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'CatholicDailyWorker/2.0'
        },
        cf: {
          cacheEverything: true,
          cacheTtl: 900
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(Math.min(attempt * 250, 1000));
    }
  }
  throw lastError;
}

async function cachedJson(request, env, ctx, file) {
  const base = normalizeBaseUrl(env);
  const dataUrl = `${base}/${file}`;
  const cache = caches.default;
  const cacheKey = new Request(dataUrl, request);
  const cached = await cache.match(cacheKey);
  const url = new URL(request.url);

  if (cached && url.searchParams.get('bypassCache') !== 'true') {
    return new Response(cached.body, {
      status: cached.status,
      headers: { ...JSON_HEADERS, 'x-cache': 'HIT', 'x-source-url': dataUrl }
    });
  }

  const payload = await fetchJsonWithRetry(dataUrl, Number(env?.REQUEST_RETRIES || 3));
  const response = jsonResponse(payload, 200, { 'x-cache': 'MISS', 'x-source-url': dataUrl });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    if (url.pathname === '/' || url.pathname === '/api') {
      return jsonResponse({
        ok: true,
        data_base_url: normalizeBaseUrl(env),
        endpoints: [
          '/api/today',
          '/api/week',
          '/api/month',
          '/api/years',
          '/api/year/2026',
          '/api/date/2026-06-01'
        ]
      });
    }

    const datePath = parseDatePath(url.pathname);
    if (datePath) {
      try {
        const payload = await fetchJsonWithRetry(`${normalizeBaseUrl(env)}/year-${datePath.year}.json`, Number(env?.REQUEST_RETRIES || 3));
        const items = Array.isArray(payload) ? payload : payload?.items || [];
        const record = items.find(item => item.date === datePath.date);
        if (!record) return jsonResponse({ error: 'Date not found', date: datePath.date }, 404);
        return jsonResponse(record, 200, { 'x-source-file': `year-${datePath.year}.json` });
      } catch (error) {
        return jsonResponse({ error: 'Upstream data unavailable', message: error.message || String(error) }, 502, { 'cache-control': 'no-store' });
      }
    }

    const file = resolveStaticFile(url.pathname);
    if (!file) {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    try {
      return await cachedJson(request, env, ctx, file);
    } catch (error) {
      return jsonResponse({
        error: 'Upstream data unavailable',
        file,
        source: `${normalizeBaseUrl(env)}/${file}`,
        message: error.message || String(error)
      }, 502, { 'cache-control': 'no-store' });
    }
  }
};
