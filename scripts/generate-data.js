import fs from "node:fs/promises";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = String(a).match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"];
}));

const OUT_DIR = path.resolve(argv.out || process.env.OUT_DIR || "data");
const API = String(argv.api || process.env.WORKER_API || "https://loichuamoingay.gioankminhcssr.workers.dev").replace(/\/+$/, "");
const YEARS = parseYears(argv.years || process.env.DATA_YEARS || String(new Date().getFullYear()));
const CONCURRENCY = clamp(Number(argv.concurrency || process.env.CONCURRENCY || 4), 1, 8);
const STRICT = String(argv.strict ?? process.env.STRICT ?? "1") !== "0";
const RETRIES = clamp(Number(argv.retries || process.env.RETRIES || 3), 1, 6);
const WRITE_PARTIAL = String(argv["write-partial"] ?? process.env.WRITE_PARTIAL ?? "1") !== "0";

await fs.mkdir(OUT_DIR, { recursive: true });

const report = {
  success: true,
  api: API,
  years: YEARS,
  strict: STRICT,
  write_partial: WRITE_PARTIAL,
  mode: "full-year-by-date",
  generated_at: new Date().toISOString(),
  months: [],
  missing_calendar: [],
  missing_gospel: [],
  errors: []
};

for (const year of YEARS) {
  const yearDays = [];

  for (let month = 1; month <= 12; month++) {
    const monthKey = `${year}-${pad(month)}`;
    const expected = expectedDates(year, month);
    console.log(`[month] ${monthKey} | expected=${expected.length}`);

    const calendarMap = await loadCalendarMap(year, month);
    const missingCalendar = expected.filter(date => !calendarMap.has(date));
    if (missingCalendar.length) report.missing_calendar.push(...missingCalendar);

    const days = await mapLimit(expected, CONCURRENCY, async (date) => {
      const fallback = calendarMap.get(date) || emptyDay(date, { calendar_status: "missing" });
      try {
        const full = await getJson(`${API}/api/date/${encodeURIComponent(date)}?fresh=1&_=${Date.now()}`);
        const normalized = normalizeDay(full?.data?.date ? full.data : full) || fallback;
        return mergeCalendarFallback(normalized, fallback);
      } catch (e) {
        const msg = `${date}: ${e?.message || String(e)}`;
        report.errors.push(msg);
        return fallback;
      }
    });

    const normalized = uniqueByDate(days).sort((a, b) => a.date.localeCompare(b.date));
    const missingDates = expected.filter(date => !normalized.some(d => d.date === date));
    const missingGospel = normalized.filter(d => !hasGospel(d)).map(d => d.date);

    if (missingDates.length) {
      const msg = `Thiếu ngày trong JSON ${monthKey}: ${missingDates.join(", ")}`;
      report.errors.push(msg);
      if (STRICT) throw new Error(msg);
    }

    if (missingGospel.length) {
      report.missing_gospel.push(...missingGospel);
      const msg = `Thiếu Tin Mừng ${monthKey}: ${missingGospel.join(", ")}`;
      report.errors.push(msg);
      if (STRICT) throw new Error(msg);
    }

    const monthJson = {
      success: missingGospel.length === 0 && missingDates.length === 0,
      year,
      month,
      month_key: monthKey,
      count: normalized.length,
      expected_count: expected.length,
      complete_days: normalized.length === expected.length,
      full_readings: missingGospel.length === 0,
      missing_calendar: missingCalendar,
      missing_gospel: missingGospel,
      source: mergeSource(normalized),
      updated: new Date().toISOString(),
      days: normalized
    };

    if (monthJson.success || WRITE_PARTIAL) {
      await writeJson(`month-${monthKey}.json`, monthJson);
    }

    report.months.push({
      month_key: monthKey,
      count: normalized.length,
      expected_count: expected.length,
      missing_calendar: missingCalendar.length,
      missing_gospel: missingGospel.length
    });
    yearDays.push(...normalized);
  }

  const yearExpected = Array.from({ length: 12 }, (_, i) => expectedDates(year, i + 1)).flat();
  const yearUnique = uniqueByDate(yearDays).sort((a, b) => a.date.localeCompare(b.date));
  const yearMissingDates = yearExpected.filter(date => !yearUnique.some(d => d.date === date));
  const yearMissingGospel = yearUnique.filter(d => !hasGospel(d)).map(d => d.date);

  await writeJson(`year-${year}.json`, {
    success: yearMissingDates.length === 0 && yearMissingGospel.length === 0,
    year,
    count: yearUnique.length,
    expected_count: yearExpected.length,
    complete_days: yearUnique.length === yearExpected.length,
    full_readings: yearMissingGospel.length === 0,
    missing_dates: yearMissingDates,
    missing_gospel: yearMissingGospel,
    updated: new Date().toISOString(),
    days: yearUnique
  });
}

report.missing_calendar = [...new Set(report.missing_calendar)].sort();
report.missing_gospel = [...new Set(report.missing_gospel)].sort();
report.success = report.errors.length === 0 && report.missing_gospel.length === 0;
await writeJson("years.json", { success: true, years: YEARS, updated: new Date().toISOString() });
await writeJson("build-report.json", report);
console.log(`[done] ${YEARS.join(", ")} | missing_calendar=${report.missing_calendar.length} | missing_gospel=${report.missing_gospel.length} | strict=${STRICT}`);

async function loadCalendarMap(year, month) {
  const map = new Map();
  const urls = [
    `${API}/api/month?y=${year}&m=${month}`,
    `${API}/api/month?y=${year}&m=${pad(month)}`,
    `${API}/api/month?year=${year}&month=${pad(month)}`,
    `${API}/api/month/${year}/${pad(month)}`
  ];
  try {
    const payload = await tryJson(urls);
    for (const item of normalizeDays(payload)) {
      if (String(item.date || "").startsWith(`${year}-${pad(month)}`)) map.set(item.date, item);
    }
  } catch (e) {
    report.errors.push(`Không nạp được lịch tháng ${year}-${pad(month)}: ${e?.message || String(e)}`);
  }
  return map;
}

async function tryJson(urls) {
  let last;
  for (const url of urls) {
    try { return await getJson(url); } catch (e) { last = e; }
  }
  throw last || new Error("Không nạp được JSON");
}

async function getJson(url) {
  let last;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const textBody = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${textBody.slice(0, 300)}`);
      return JSON.parse(textBody);
    } catch (e) {
      last = e;
      await sleep(700 * (i + 1));
    }
  }
  throw last;
}

async function writeJson(name, data) {
  await fs.writeFile(path.join(OUT_DIR, name), JSON.stringify(data, null, 2), "utf8");
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function normalizeDays(payload) {
  const d = payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
  if (Array.isArray(d)) return d.map(normalizeDay).filter(Boolean);
  if (Array.isArray(d?.days)) return d.days.map(normalizeDay).filter(Boolean);
  if (Array.isArray(d?.items)) return d.items.map(normalizeDay).filter(Boolean);
  if (Array.isArray(d?.records)) return d.records.map(normalizeDay).filter(Boolean);
  if (d && typeof d === "object") {
    return Object.keys(d)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .map(k => normalizeDay(typeof d[k] === "object" ? { date: k, ...d[k] } : { date: k, text: d[k] }))
      .filter(Boolean);
  }
  return [];
}

function normalizeDay(x) {
  if (!x || typeof x !== "object") return null;
  const d = x.data && x.data.date ? x.data : x;
  if (!d.date) return null;
  const l = d.liturgy || {};
  const saint = typeof l.saint === "string" ? { name: l.saint } : (l.saint || {});
  const r = d.readings || {};
  return {
    date: text(d.date),
    weekday: text(d.weekday) || weekdayOf(text(d.date)),
    liturgy: {
      season: text(l.season || d.season),
      week: text(l.week || d.week),
      year_cycle: text(l.year_cycle || d.year_cycle),
      celebration: text(l.celebration || d.celebration || d.title),
      rank: text(l.rank || d.rank),
      color: text(l.color || d.color),
      saint: { name: text(saint.name), image: "", wiki: "" }
    },
    readings: {
      reading1: normReading(r.reading1 || d.reading1),
      reading2: normReading(r.reading2 || d.reading2),
      psalm: normPsalm(r.psalm || d.psalm),
      gospel_acclamation: text(r.gospel_acclamation || r.acclamation || d.gospel_acclamation),
      gospel: normReading(r.gospel || d.gospel)
    },
    reflection: { title: "", content: "" },
    notes: Array.isArray(d.notes) ? d.notes.map(text).filter(Boolean) : [],
    source: d.source || {},
    updated: d.updated || new Date().toISOString()
  };
}

function emptyDay(date, source = {}) {
  return {
    date,
    weekday: weekdayOf(date),
    liturgy: { season: "", week: "", year_cycle: "", celebration: "", rank: "", color: "", saint: { name: "", image: "", wiki: "" } },
    readings: { reading1: { reference: "", text: "" }, reading2: { reference: "", text: "" }, psalm: { reference: "", response: "" }, gospel_acclamation: "", gospel: { reference: "", text: "" } },
    reflection: { title: "", content: "" },
    notes: [],
    source,
    updated: new Date().toISOString()
  };
}

function mergeCalendarFallback(day, fallback) {
  const out = normalizeDay(day) || fallback;
  const fb = normalizeDay(fallback);
  if (!fb) return out;
  if (!out.liturgy?.celebration && fb.liturgy?.celebration) out.liturgy = fb.liturgy;
  out.source = Object.assign({}, fb.source || {}, out.source || {});
  return out;
}

function normReading(v) {
  if (!v) return { reference: "", text: "" };
  if (typeof v !== "object") return { reference: "", text: text(v) };
  return { reference: text(v.reference || v.ref || v.title), text: text(v.text || v.content || v.paragraphs || v.html) };
}

function normPsalm(v) {
  if (!v) return { reference: "", response: "" };
  if (typeof v !== "object") return { reference: "", response: text(v) };
  return { reference: text(v.reference || v.ref || v.title), response: text(v.response || v.text || v.content || v.paragraphs || v.html) };
}

function hasGospel(day) {
  return !!(day?.readings?.gospel && (text(day.readings.gospel.reference) || text(day.readings.gospel.text)));
}

function expectedDates(year, month) {
  const max = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: max }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`);
}

function mergeSource(days) {
  const source = {};
  for (const d of days) Object.assign(source, d.source || {});
  return source;
}

function uniqueByDate(arr) {
  return [...new Map((arr || []).filter(Boolean).map(d => [d.date, d])).values()];
}

function parseYears(v) {
  const current = new Date().getFullYear();
  const textValue = String(v || current).trim().toLowerCase();
  if (textValue === "auto" || textValue === "current") return [current];
  const plus = textValue.match(/^current\+(\d+)$/);
  if (plus) return range(current, current + Number(plus[1]));
  const rg = textValue.match(/^(\d{4})-(\d{4})$/);
  if (rg) return range(Number(rg[1]), Number(rg[2]));
  const list = textValue.split(",").map(x => Number(x.trim())).filter(Number.isInteger);
  return list.length ? [...new Set(list)].sort((a, b) => a - b) : [current];
}

function weekdayOf(date) {
  const d = new Date(`${date}T00:00:00+07:00`);
  return ["Chúa Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"][d.getDay()] || "";
}

function range(a, b) { const out = []; for (let y = a; y <= b; y++) out.push(y); return out; }
function clamp(n, min, max) { return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }
function text(v) { return String(v == null ? "" : Array.isArray(v) ? v.join("\n") : v).replace(/\^\{([^}]+)\}/g, "$1").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").trim(); }
function pad(n) { return String(n).padStart(2, "0"); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
