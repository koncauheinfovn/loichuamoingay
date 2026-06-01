const CONFIG = {
  DATA_BASES: [
    "https://koncauheinfovn.github.io/loichuamoingay/data",
    "https://raw.githubusercontent.com/koncauheinfovn/loichuamoingay/main/data"
  ],
  YEAR: 2026,
  TIMEZONE: "Asia/Ho_Chi_Minh",
  CACHE: {
    date: 300,
    month: 900,
    year: 3600
  }
};

export default {
  async fetch(request) {
    try {
      if (request.method === "OPTIONS") return cors("", 204);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ success: false, error: "Method not allowed" }, 405);
      }

      const url = new URL(request.url);
      const path = cleanPath(url.pathname);

      if (path === "/" || path === "/api") {
        return json({
          success: true,
          name: "Lời Chúa + Lịch phụng vụ Việt Nam 2026",
          endpoints: [
            "/api/health",
            "/api/today",
            "/api/date/2026-06-01",
            "/api/month?y=2026&m=6",
            "/api/year/2026"
          ],
          source: "Augustino + GitHub JSON",
          updated: new Date().toISOString()
        }, 200, 300);
      }

      if (path === "/api/health") {
        return json({
          success: true,
          ok: true,
          today_vietnam: todayVN(),
          year: CONFIG.YEAR
        }, 200, 60);
      }

      if (path === "/api/today") {
        return handleDate(url.searchParams.get("date") || todayVN());
      }

      if (path === "/api/date") {
        return handleDate(url.searchParams.get("date"));
      }

      if (path.startsWith("/api/date/")) {
        return handleDate(decodeURIComponent(path.slice("/api/date/".length)));
      }

      if (path === "/api/month") {
        const y = Number(url.searchParams.get("y") || url.searchParams.get("year") || CONFIG.YEAR);
        const m = Number(url.searchParams.get("m") || url.searchParams.get("month") || todayVN().slice(5, 7));
        return handleMonth(y, m);
      }

      if (path === "/api/year/2026" || path === "/api/year") {
        return handleYear(CONFIG.YEAR);
      }

      return json({ success: false, error: "Endpoint không tồn tại", path }, 404);

    } catch (err) {
      return json({
        success: false,
        error: err?.message || String(err)
      }, 500, 60);
    }
  }
};

async function handleDate(input) {
  const date = normalizeDate(input);
  if (!date) {
    return json({ success: false, error: "Ngày không hợp lệ. Dùng YYYY-MM-DD." }, 400, 60);
  }

  if (Number(date.slice(0, 4)) !== CONFIG.YEAR) {
    return json({ success: false, error: "Worker này chỉ dùng cho năm 2026.", date }, 400, 60);
  }

  const yearData = await loadJson(`year-${CONFIG.YEAR}.json`, CONFIG.CACHE.date);
  const day = normalizeDays(yearData).find(item => item.date === date) || null;

  if (!day) {
    return json({ success: false, error: "Không tìm thấy dữ liệu ngày này.", date }, 404, 120);
  }

  return json({
    success: true,
    ...day,
    data: day,
    updated: day.updated || yearData.updated || new Date().toISOString()
  }, 200, CONFIG.CACHE.date);
}

async function handleMonth(year, month) {
  if (year !== CONFIG.YEAR) {
    return json({ success: false, error: "Worker này chỉ dùng cho năm 2026." }, 400, 60);
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return json({ success: false, error: "Tháng không hợp lệ." }, 400, 60);
  }

  const monthKey = `${year}-${pad(month)}`;
  let monthData = null;

  try {
    monthData = await loadJson(`month-${monthKey}.json`, CONFIG.CACHE.month);
  } catch (_) {
    monthData = null;
  }

  if (monthData?.days) {
    return json({
      success: true,
      year,
      month,
      month_key: monthKey,
      count: monthData.days.length,
      days: monthData.days,
      updated: monthData.updated || new Date().toISOString()
    }, 200, CONFIG.CACHE.month);
  }

  const yearData = await loadJson(`year-${year}.json`, CONFIG.CACHE.month);
  const days = normalizeDays(yearData).filter(item => item.date.startsWith(monthKey));

  return json({
    success: true,
    year,
    month,
    month_key: monthKey,
    count: days.length,
    days,
    updated: yearData.updated || new Date().toISOString()
  }, 200, CONFIG.CACHE.month);
}

async function handleYear(year) {
  if (year !== CONFIG.YEAR) {
    return json({ success: false, error: "Worker này chỉ dùng cho năm 2026." }, 400, 60);
  }

  const data = await loadJson(`year-${year}.json`, CONFIG.CACHE.year);
  const days = normalizeDays(data);

  return json({
    success: true,
    year,
    count: days.length,
    days,
    updated: data.updated || new Date().toISOString()
  }, 200, CONFIG.CACHE.year);
}

async function loadJson(filename, cacheSeconds) {
  const errors = [];

  for (const base of CONFIG.DATA_BASES) {
    const fileUrl = `${base.replace(/\/+$/, "")}/${filename}`;
    try {
      const res = await fetch(fileUrl, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "CloudflareWorker loichuamoingay 2026"
        },
        cf: { cacheTtl: cacheSeconds, cacheEverything: true }
      });

      if (!res.ok) {
        errors.push(`${fileUrl} HTTP ${res.status}`);
        continue;
      }

      return await res.json();
    } catch (err) {
      errors.push(`${fileUrl} ${err?.message || err}`);
    }
  }

  throw new Error(`Không tải được ${filename}: ${errors.join(" | ")}`);
}

function normalizeDays(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.days)) return data.days;
  if (Array.isArray(data.data)) return data.data;
  if (data.data && Array.isArray(data.data.days)) return data.data.days;
  return Object.keys(data)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .map(k => ({ date: k, ...data[k] }));
}

function normalizeDate(value) {
  const m = String(value || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== mo || date.getUTCDate() !== d) return "";
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function todayVN() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function cleanPath(pathname) {
  let path = String(pathname || "/").replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function json(data, status = 200, maxAge = 300) {
  return cors(JSON.stringify(data, null, 2), status, {
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=86400`
  });
}

function cors(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...extraHeaders,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Max-Age": "86400",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
