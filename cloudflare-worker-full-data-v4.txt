// Cloudflare Worker full data v4.
// Mục tiêu: endpoint ngày luôn lấy đủ Bài đọc, Đáp ca, Tung hô Tin Mừng và Tin Mừng từ Vatican News;
// endpoint tháng/năm giữ lịch phụng vụ từ Augustinô và có tuỳ chọn include=readings để tạo JSON đầy đủ.
// API: /api/today, /api/date/YYYY-MM-DD, /api/day?date=YYYY-MM-DD, /api/month?y=YYYY&m=MM, /api/month?y=YYYY&m=MM&include=readings, /api/year/YYYY?include=readings

const CONFIG = {
  GITHUB_DATA_BASES: [
    "https://koncauheinfovn.github.io/loichuamoingay/data",
    "https://raw.githubusercontent.com/koncauheinfovn/loichuamoingay/main/data"
  ],
  AUGUSTINO: "https://augustino.net/lich-phung-vu",
  VATICAN: "https://www.vaticannews.va/vi/loi-chua-hang-ngay",
  TZ: "Asia/Ho_Chi_Minh",
  CACHE: { date: 300, month: 900, monthFull: 300, year: 3600 },
  MONTH_READING_CONCURRENCY: 3
};

export default {
  async fetch(req) {
    try {
      if (req.method === "OPTIONS") return cors("", 204);
      if (req.method !== "GET" && req.method !== "HEAD") return j({ success: false, error: "Method not allowed" }, 405, 60);

      const u = new URL(req.url);
      const p = cleanPath(u.pathname);

      if (p === "/" && u.searchParams.has("date")) return dateHandler(u.searchParams.get("date"));
      if (p === "/" || p === "/api") return j({
        success: true,
        name: "Lời Chúa + Lịch phụng vụ Việt Nam",
        full_readings: true,
        no_reflection: true,
        sources: { calendar: CONFIG.AUGUSTINO, readings: CONFIG.VATICAN },
        endpoints: [
          "/api/today",
          "/api/date/2026-06-01",
          "/api/day?date=2026-06-01",
          "/api/month?y=2026&m=1",
          "/api/month?y=2026&m=1&include=readings",
          "/api/year/2026",
          "/api/year/2026?include=readings"
        ],
        updated: new Date().toISOString()
      }, 200, 300);

      if (p === "/api/health") return j({ success: true, ok: true, today_vietnam: todayVN(), updated: new Date().toISOString() }, 200, 60);
      if (p === "/api/today") return dateHandler(u.searchParams.get("date") || todayVN());
      if (p === "/api/date") return dateHandler(u.searchParams.get("date"));
      if (p.startsWith("/api/date/")) return dateHandler(decodeURIComponent(p.slice("/api/date/".length)));
      if (p === "/api/day") return dateHandler(u.searchParams.get("date"));

      if (p === "/api/month") {
        const t = todayVN();
        const y = Number(u.searchParams.get("y") || u.searchParams.get("year") || t.slice(0, 4));
        const m = Number(u.searchParams.get("m") || u.searchParams.get("month") || t.slice(5, 7));
        const includeReadings = wantsReadings(u.searchParams.get("include")) || wantsReadings(u.searchParams.get("full"));
        return monthHandler(y, m, { includeReadings });
      }

      const monthPath = p.match(/^\/api\/month\/(\d{4})\/(\d{1,2})$/);
      if (monthPath) return monthHandler(Number(monthPath[1]), Number(monthPath[2]), { includeReadings: wantsReadings(u.searchParams.get("include")) });

      if (p.startsWith("/api/year/")) {
        const y = Number(p.slice("/api/year/".length));
        const includeReadings = wantsReadings(u.searchParams.get("include")) || wantsReadings(u.searchParams.get("full"));
        return yearHandler(y, { includeReadings });
      }

      return j({ success: false, error: "Endpoint không tồn tại", path: p }, 404, 60);
    } catch (e) {
      return j({ success: false, error: e?.message || String(e), updated: new Date().toISOString() }, 500, 60);
    }
  }
};

async function dateHandler(v) {
  const date = normDate(v);
  if (!date) return j({ success: false, error: "Ngày không hợp lệ. Dùng YYYY-MM-DD." }, 400, 60);

  let day = null;
  let calendarError = "";
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));

  try {
    const month = await getCalendarMonth(y, m);
    day = month.days.find(d => d.date === date) || null;
  } catch (e) {
    calendarError = e?.message || String(e);
  }

  if (!day) day = emptyDay(date, { calendar_error: calendarError });

  const full = await enrichDayWithReadings(day, { force: true });
  return j({ success: true, ...full, data: full, updated: new Date().toISOString() }, 200, CONFIG.CACHE.date);
}

async function monthHandler(y, m, opts = {}) {
  if (!validYear(y) || !validMonth(m)) return j({ success: false, error: "Năm hoặc tháng không hợp lệ." }, 400, 60);
  const month = completeMonth(await getCalendarMonth(y, m), y, m);
  if (opts.includeReadings) {
    month.days = await mapLimit(month.days, CONFIG.MONTH_READING_CONCURRENCY, d => enrichDayWithReadings(d, { force: true }).catch(() => normDay(d) || emptyDay(d?.date)));
    month.count = month.days.length;
    month.full_readings = true;
    month.missing_gospel = month.days.filter(d => !hasGospel(d.readings)).map(d => d.date);
    month.updated = new Date().toISOString();
    return j(month, 200, CONFIG.CACHE.monthFull);
  }
  return j(month, 200, CONFIG.CACHE.month);
}

async function yearHandler(y, opts = {}) {
  if (!validYear(y)) return j({ success: false, error: "Năm không hợp lệ." }, 400, 60);
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(completeMonth(await getCalendarMonth(y, m), y, m));

  if (opts.includeReadings) {
    const fullMonths = [];
    for (const month of months) {
      const days = await mapLimit(month.days, CONFIG.MONTH_READING_CONCURRENCY, d => enrichDayWithReadings(d, { force: true }).catch(() => normDay(d) || emptyDay(d?.date)));
      fullMonths.push(Object.assign({}, month, { days, count: days.length, full_readings: true, missing_gospel: days.filter(d => !hasGospel(d.readings)).map(d => d.date), updated: new Date().toISOString() }));
    }
    const fullDays = uniqueByDate(fullMonths.flatMap(m => m.days)).sort((a, b) => a.date.localeCompare(b.date));
    return j({
      success: true,
      year: y,
      count: fullDays.length,
      full_readings: true,
      missing_gospel: fullDays.filter(d => !hasGospel(d.readings)).map(d => d.date),
      days: fullDays,
      source: { calendar: CONFIG.AUGUSTINO, readings: CONFIG.VATICAN },
      updated: new Date().toISOString()
    }, 200, CONFIG.CACHE.monthFull);
  }

  const days = uniqueByDate(months.flatMap(m => m.days)).sort((a, b) => a.date.localeCompare(b.date));
  return j({
    success: true,
    year: y,
    count: days.length,
    full_readings: days.some(d => hasGospel(d.readings)),
    note: "Endpoint năm trả đủ ngày trong 12 tháng. Thêm ?include=readings để lấy bản văn Lời Chúa đầy đủ.",
    days,
    source: { calendar: CONFIG.AUGUSTINO },
    updated: new Date().toISOString()
  }, 200, CONFIG.CACHE.year);
}

async function getCalendarMonth(y, m) {
  const key = `${y}-${pad(m)}`;
  const monthFile = await loadJson(`month-${key}.json`, CONFIG.CACHE.month).catch(() => null);
  if (Array.isArray(monthFile?.days) && monthFile.days.length) return normMonth(y, m, monthFile.days, monthFile.source, monthFile.updated);

  const yearFile = await loadJson(`year-${y}.json`, CONFIG.CACHE.month).catch(() => null);
  if (Array.isArray(yearFile?.days) && yearFile.days.length) {
    const days = yearFile.days.filter(d => String(d.date || "").startsWith(key));
    if (days.length) return normMonth(y, m, days, yearFile.source, yearFile.updated);
  }

  const url = `${CONFIG.AUGUSTINO}?m=${pad(m)}&y=${y}`;
  const html = await fetchText(url, CONFIG.CACHE.month);
  const parsed = parseCalendar(html, y, m);
  return normMonth(y, m, parsed, { calendar: url }, new Date().toISOString());
}

function normMonth(y, m, days, source = {}, updated = "") {
  const normalized = uniqueByDate((days || []).map(normDay).filter(Boolean)).sort((a, b) => a.date.localeCompare(b.date));
  return {
    success: true,
    year: y,
    month: m,
    month_key: `${y}-${pad(m)}`,
    count: normalized.length,
    full_readings: normalized.some(d => hasGospel(d.readings)),
    source,
    updated: updated || new Date().toISOString(),
    days: normalized
  };
}

function completeMonth(month, y, m) {
  const base = month && typeof month === "object" ? month : normMonth(y, m, [], {}, new Date().toISOString());
  const byDate = new Map((base.days || []).map(d => [d.date, d]));
  const days = expectedDates(y, m).map(date => byDate.get(date) || emptyDay(date, { calendar_status: "missing" }));
  return Object.assign({}, base, {
    year: y,
    month: m,
    month_key: `${y}-${pad(m)}`,
    count: days.length,
    days,
    complete_days: true,
    missing_calendar: days.filter(d => d?.source?.calendar_status === "missing").map(d => d.date),
    updated: base.updated || new Date().toISOString()
  });
}

function expectedDates(year, month) {
  const max = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: max }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`);
}

function parseCalendar(html, y, m) {
  const text = htmlToText(html);
  const lines = text.split("\n").map(clean).filter(Boolean).filter(x => !calendarNoise(x));
  const blocks = [];
  let cur = null;

  for (const line of lines) {
    const h = line.match(/^(\d{1,2})\s+(Chúa Nhật|Thứ Hai|Thứ Ba|Thứ Tư|Thứ Năm|Thứ Sáu|Thứ Bảy)\s*(.*)$/i);
    if (h) {
      if (cur) blocks.push(cur);
      cur = { day: Number(h[1]), weekday: weekday(h[2]), title: clean(h[3].replace(/\bChi tiết\b/gi, "")), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);

  const max = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return blocks.filter(b => b.day >= 1 && b.day <= max).map(b => buildCalendarDay(b, y, m));
}

function buildCalendarDay(b, y, m) {
  const date = `${y}-${pad(m)}-${pad(b.day)}`;
  const ri = b.lines.findIndex(x => /^Bài đọc:/i.test(x));
  const rline = ri >= 0 ? b.lines[ri].replace(/^Bài đọc:\s*/i, "").trim() : "";
  const before = ri >= 0 ? b.lines.slice(0, ri) : b.lines;
  const after = ri >= 0 ? b.lines.slice(ri + 1) : [];
  const cLines = before.filter(x => !calendarInstruction(x)).filter(x => !/^MÙA\s+/i.test(x));
  const celebration = cLines.find(x => /lễ\s+(trọng|kính|nhớ)|Chúa|Đức Mẹ|Thánh/i.test(x)) || b.title || "";
  const rank = rankOf([celebration, b.title, ...cLines].join(" "));
  const saint = saintName(cLines.join(" ") || celebration);
  const refs = splitRefs(rline);

  return {
    date,
    weekday: b.weekday,
    liturgy: {
      season: seasonOf(b.title, cLines.join(" ")),
      week: weekOf(b.title),
      year_cycle: cycleOf(y, m, b.day),
      celebration,
      rank,
      color: colorOf(`${b.title} ${celebration} ${rank}`),
      saint: { name: saint, image: "", wiki: "" }
    },
    readings: emptyReadings(refs),
    reflection: { title: "", content: "" },
    notes: after.filter(x => !calendarNoise(x) && !calendarInstruction(x)),
    source: { calendar: `${CONFIG.AUGUSTINO}?m=${pad(m)}&y=${y}`, gospel: "" },
    updated: new Date().toISOString()
  };
}

async function enrichDayWithReadings(day, opts = {}) {
  const normalized = normDay(day) || emptyDay(day?.date || todayVN());
  if (!opts.force && hasGospel(normalized.readings)) return normalized;

  const full = await getVaticanReadings(normalized.date).catch(e => ({ readings: null, source: "", error: e?.message || String(e) }));
  if (full?.readings && hasAnyReading(full.readings)) {
    const refs = normalized.readings || emptyReadings();
    const merged = mergeReadings(refs, full.readings);
    normalized.readings = merged;
    normalized.source = Object.assign({}, normalized.source || {}, { gospel: full.source, readings: full.source });
    normalized.readings_status = hasGospel(merged) ? "ok" : "partial";
  } else {
    normalized.readings_status = "missing";
    normalized.readings_error = full?.error || "Không lấy được bản văn Lời Chúa từ Vatican News.";
  }

  normalized.reflection = { title: "", content: "" };
  if (!normalized.liturgy) normalized.liturgy = emptyDay(normalized.date).liturgy;
  if (!normalized.liturgy.saint || typeof normalized.liturgy.saint !== "object") normalized.liturgy.saint = { name: text(normalized.liturgy.saint), image: "", wiki: "" };
  normalized.liturgy.saint.image = "";
  normalized.liturgy.saint.wiki = "";
  normalized.updated = new Date().toISOString();
  return normalized;
}

async function getVaticanReadings(date) {
  const [y, m, d] = date.split("-");
  const url = `${CONFIG.VATICAN}/${y}/${m}/${d}.html`;
  const html = await fetchText(url, CONFIG.CACHE.date);
  return { readings: parseVatican(html), source: url };
}

function parseVatican(html) {
  let text = htmlToText(html);
  const start = firstIndex(text, ["Bài đọc ngày hôm nay", "Bài đọc 1", "Bài đọc I"]);
  if (start >= 0) text = text.slice(start);
  const end = firstIndex(text, [
    "Xin hỗ trợ sứ mạng", "Bản văn Kinh Thánh", "Gửi đi", "Thêm các sự kiện sắp tới",
    "Hoạt động của ĐGH", "Đức tin chúng ta", "Thông tin hữu ích", "Các mạng khác",
    "Vatican.va", "Copyright ©", "Dicasterium pro Communicatione"
  ]);
  if (end >= 0) text = text.slice(0, end);

  const lines = text.split("\n")
    .map(clean)
    .filter(Boolean)
    .filter(x => !vaticanNoise(x) && !vaticanChrome(x) && !copyrightLine(x));

  const r = emptyReadings();
  const bucket = { reading1: [], reading2: [], psalm: [], acclamation: [], gospel: [] };
  let cur = "";

  for (const line of lines) {
    if (footerStop(line)) break;
    if (introOnly(line)) continue;

    const h = readingHeader(line);
    if (h) {
      cur = h.type;
      if (h.ref) setReadingReference(r, cur, h.ref);
      if (h.keepLine) bucket[cur].push(h.keepText || line);
      continue;
    }

    if (cur && bucket[cur]) bucket[cur].push(line);
  }

  r.reading1.text = scripture(bucket.reading1.join("\n"));
  r.reading2.text = scripture(bucket.reading2.join("\n"));
  r.psalm.response = scripture(bucket.psalm.join("\n"));
  r.gospel_acclamation = scripture(bucket.acclamation.join("\n"));
  r.gospel.text = scripture(bucket.gospel.join("\n"));

  inferReferences(r);
  return r;
}

function readingHeader(line) {
  const v = clean(line).replace(/^#+\s*/, "");
  const n = noAccent(v).toLowerCase();

  if (/^bai doc\s*(1|i)\b/.test(n)) return { type: "reading1", ref: refOf(v) };
  if (/^bai doc\s*(2|ii)\b/.test(n)) return { type: "reading2", ref: refOf(v) };
  if (/^dap ca\b/.test(n)) return { type: "psalm", ref: refOf(v) || v.replace(/^Đáp ca\s*/i, "").trim() };
  if (/^tung ho tin mung\b/.test(n)) return { type: "acclamation", ref: refOf(v) || v.replace(/^Tung hô Tin Mừng\s*/i, "").trim() };
  if (/^tin mung ngay hom nay\b/.test(n)) return { type: "gospel", ref: "" };
  if (/^(✠\s*)?tin mung\b/.test(n) || /^phuc am\b/.test(n)) return { type: "gospel", ref: refOf(v), keepLine: true };

  return null;
}

function setReadingReference(r, type, ref) {
  if (type === "reading1") r.reading1.reference = ref;
  if (type === "reading2") r.reading2.reference = ref;
  if (type === "psalm") r.psalm.reference = ref;
  if (type === "gospel") r.gospel.reference = ref;
}

function inferReferences(r) {
  if (!r.reading1.reference) r.reading1.reference = refOf(r.reading1.text);
  if (!r.reading2.reference) r.reading2.reference = refOf(r.reading2.text);
  if (!r.psalm.reference) r.psalm.reference = refOf(r.psalm.response);
  if (!r.gospel.reference) r.gospel.reference = refOf(r.gospel.text);
}

function mergeReadings(base, full) {
  const b = normalizeReadings(base);
  const f = normalizeReadings(full);
  return {
    reading1: {
      reference: text(f.reading1.reference || b.reading1.reference),
      text: clean(f.reading1.text || b.reading1.text)
    },
    reading2: {
      reference: text(f.reading2.reference || b.reading2.reference),
      text: clean(f.reading2.text || b.reading2.text)
    },
    psalm: {
      reference: text(f.psalm.reference || b.psalm.reference),
      response: clean(f.psalm.response || b.psalm.response)
    },
    gospel_acclamation: clean(f.gospel_acclamation || b.gospel_acclamation),
    gospel: {
      reference: text(f.gospel.reference || b.gospel.reference),
      text: clean(f.gospel.text || b.gospel.text)
    }
  };
}

function normalizeReadings(r = {}) {
  return {
    reading1: normReading(r.reading1),
    reading2: normReading(r.reading2),
    psalm: normPsalm(r.psalm),
    gospel_acclamation: clean(r.gospel_acclamation || r.acclamation || ""),
    gospel: normReading(r.gospel)
  };
}

function normDay(x) {
  if (!x || typeof x !== "object" || !x.date) return null;
  const l = x.liturgy || {};
  const saint = typeof l.saint === "string" ? { name: l.saint } : (l.saint || {});
  const r = normalizeReadings(x.readings || {});
  return {
    date: x.date,
    weekday: text(x.weekday) || weekdayFromDate(x.date),
    liturgy: {
      season: text(l.season),
      week: text(l.week),
      year_cycle: text(l.year_cycle),
      celebration: text(l.celebration || x.celebration || x.title),
      rank: text(l.rank),
      color: text(l.color),
      saint: { name: text(saint.name), image: "", wiki: "" }
    },
    readings: r,
    reflection: { title: "", content: "" },
    notes: Array.isArray(x.notes) ? x.notes.map(text).filter(Boolean) : [],
    source: x.source || { calendar: "", gospel: "" },
    updated: x.updated || ""
  };
}

function emptyDay(date, extraSource = {}) {
  const d = normDate(date) || todayVN();
  const [y, m, dd] = d.split("-").map(Number);
  return {
    date: d,
    weekday: weekdayFromDate(d),
    liturgy: {
      season: "",
      week: "",
      year_cycle: cycleOf(y, m, dd),
      celebration: "",
      rank: "",
      color: "",
      saint: { name: "", image: "", wiki: "" }
    },
    readings: emptyReadings(),
    reflection: { title: "", content: "" },
    notes: [],
    source: Object.assign({ calendar: "", gospel: "" }, extraSource),
    updated: new Date().toISOString()
  };
}

function emptyReadings(refs = {}) {
  return {
    reading1: { reference: refs.reading1 || "", text: "" },
    reading2: { reference: refs.reading2 || "", text: "" },
    psalm: { reference: refs.psalm || "", response: "" },
    gospel_acclamation: "",
    gospel: { reference: refs.gospel || "", text: "" }
  };
}

function normReading(v) {
  if (!v) return { reference: "", text: "" };
  if (typeof v !== "object") return { reference: "", text: clean(v) };
  return { reference: text(v.reference || v.ref || v.title), text: clean(v.text || v.content || v.paragraphs || v.html) };
}

function normPsalm(v) {
  if (!v) return { reference: "", response: "" };
  if (typeof v !== "object") return { reference: "", response: clean(v) };
  return { reference: text(v.reference || v.ref || v.title), response: clean(v.response || v.text || v.content || v.paragraphs || v.html) };
}

function htmlToText(html = "") {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h1|h2|h3|h4|h5|tr|td|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim());
}

function decodeEntities(v = "") {
  const named = {
    nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
    agrave: "à", aacute: "á", acirc: "â", atilde: "ã", egrave: "è", eacute: "é", ecirc: "ê", igrave: "ì", iacute: "í", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ugrave: "ù", uacute: "ú", yacute: "ý", ccedil: "ç",
    Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Egrave: "È", Eacute: "É", Ecirc: "Ê", Igrave: "Ì", Iacute: "Í", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ugrave: "Ù", Uacute: "Ú", Yacute: "Ý", Ccedil: "Ç"
  };
  return String(v)
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, n) => Object.prototype.hasOwnProperty.call(named, n) ? named[n] : m);
}

function safeCodePoint(n) {
  try { return Number.isFinite(n) ? String.fromCodePoint(n) : ""; }
  catch { return ""; }
}

async function loadJson(name, ttl) {
  const errors = [];
  for (const base of CONFIG.GITHUB_DATA_BASES) {
    const url = `${base.replace(/\/+$/, "")}/${name}`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "CloudflareWorker loichuamoingay" }, cf: { cacheTtl: ttl, cacheEverything: true } });
      if (!res.ok) { errors.push(`${url} HTTP ${res.status}`); continue; }
      return await res.json();
    } catch (e) { errors.push(`${url} ${e?.message || e}`); }
  }
  throw new Error(errors.join(" | "));
}

async function fetchText(url, ttl) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 CloudflareWorker loichuamoingay",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi,en;q=0.8"
    },
    cf: { cacheTtl: ttl, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.text();
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

function scripture(v) {
  return String(v)
    .split("\n")
    .map(clean)
    .filter(Boolean)
    .filter(x => !vaticanNoise(x) && !vaticanChrome(x) && !copyrightLine(x) && !footerStop(x))
    .join("\n")
    .trim();
}

function hasAnyReading(r = {}) { return !!(r.reading1?.text || r.reading2?.text || r.psalm?.response || r.gospel_acclamation || r.gospel?.text); }
function hasGospel(r = {}) { return !!(r.gospel && (text(r.gospel.reference) || clean(r.gospel.text))); }

function refOf(v = "") {
  const m = String(v).match(/\b(?:x\.\s*)?(St|Xh|Lv|Ds|Đnl|Gs|Tl|R|1 Sm|2 Sm|1 V|2 V|Is|Gr|Ed|Đn|Hs|Ge|Am|Mk|Xp|Dcr|Ml|Cv|Rm|1 Cr|2 Cr|Gl|Ep|Pl|Cl|1 Tx|2 Tx|1 Tm|2 Tm|Tt|Dt|Hr|Gc|1 Pr|2 Pr|1 Ga|2 Ga|3 Ga|Gđ|Kh|Mt|Mc|Lc|Ga|Tv)\s+[\d,.\-–;abxcd\s]+/i);
  return m ? clean(m[0]) : "";
}

function splitRefs(v) {
  const line = String(v || "").replace(/\s+/g, " ").trim();
  const refs = line.match(/(?:^|\s)(St|Xh|Lv|Ds|Đnl|Gs|Tl|R|1 Sm|2 Sm|1 V|2 V|Is|Gr|Ed|Đn|Hs|Ge|Am|Mk|Xp|Dcr|Ml|Cv|Rm|1 Cr|2 Cr|Gl|Ep|Pl|Cl|1 Tx|2 Tx|1 Tm|2 Tm|Tt|Dt|Hr|Gc|1 Pr|2 Pr|1 Ga|2 Ga|3 Ga|Gđ|Kh|Mt|Mc|Lc|Ga|Tv)\s+[\d,.\-–;abxcd\s]+/gi) || [];
  const gospelIndex = refs.findIndex(x => /\b(Mt|Mc|Lc|Ga)\b/i.test(x));
  return {
    reading1: gospelIndex > 0 ? refs.slice(0, gospelIndex).join(" ").trim() : (gospelIndex === 0 ? "" : line),
    gospel: gospelIndex >= 0 ? refs[gospelIndex].trim() : ""
  };
}

function rankOf(v = "") { const s = noAccent(v).toLowerCase(); if (/le trong/.test(s)) return "Lễ trọng"; if (/le kinh/.test(s)) return "Lễ kính"; if (/le nho/.test(s)) return "Lễ nhớ"; if (/nho tu do/.test(s)) return "Lễ nhớ tự do"; if (/chua nhat/.test(s)) return "Chúa nhật"; return "Lễ thường"; }
function colorOf(v = "") { const s = noAccent(v).toLowerCase(); if (/tu dao|thuong kho|chua thanh than|tong do|le la|phero|phaolo|banaba|giustino|justino/.test(s)) return "Đỏ"; if (/mua chay|mua vong/.test(s) && !/le trong|le kinh|duc me|thanh|chua giang sinh|truyen tin/.test(s)) return "Tím"; if (/chua nhat iii mua vong|chua nhat iv mua chay/.test(s)) return "Hồng"; if (/thanh|duc me|chua|le trong|le kinh|giang sinh|phuc sinh|truyen tin|thanh tam|trai tim/.test(s)) return "Trắng"; return "Xanh"; }
function seasonOf(t = "", l = "") { const s = `${t} ${l}`; if (/Mùa Vọng/i.test(s)) return "Mùa Vọng"; if (/Mùa Chay/i.test(s)) return "Mùa Chay"; if (/Phục Sinh|Bát Nhật Phục Sinh/i.test(s)) return "Mùa Phục Sinh"; if (/Giáng Sinh|Bát Nhật Giáng Sinh/i.test(s)) return "Mùa Giáng Sinh"; if (/Thường Niên/i.test(s)) return "Mùa Thường Niên"; return ""; }
function weekOf(t = "") { const m = String(t).match(/Tuần\s+([0-9IVXLCDM]+)\s+([^,\n]+)/i); return m ? `Tuần ${m[1]} ${m[2]}`.replace(/\bChi tiết\b/gi, "").trim() : ""; }
function saintName(v = "") { const m = String(v).match(/((?:Thánh|Thánh Nữ|Các Thánh|Đức Mẹ|Chúa)\s+[^.,;]+)/i); return m ? clean(m[1]) : ""; }
function cycleOf(y, m, d) { const date = new Date(Date.UTC(y, m - 1, d)); const ly = date >= advent(y) ? y + 1 : y; const mod = ly % 3; return mod === 1 ? "A" : mod === 2 ? "B" : "C"; }
function advent(y) { const d = new Date(Date.UTC(y, 10, 27)); d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7)); return d; }
function weekday(v = "") { const s = noAccent(v).toLowerCase(); if (s.includes("chua nhat")) return "Chúa Nhật"; if (s.includes("thu hai")) return "Thứ Hai"; if (s.includes("thu ba")) return "Thứ Ba"; if (s.includes("thu tu")) return "Thứ Tư"; if (s.includes("thu nam")) return "Thứ Năm"; if (s.includes("thu sau")) return "Thứ Sáu"; if (s.includes("thu bay")) return "Thứ Bảy"; return v; }
function weekdayFromDate(date) { const d = new Date(`${date}T00:00:00Z`); return ["Chúa Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"][d.getUTCDay()] || ""; }

function introOnly(x = "") {
  const n = noAccent(clean(x)).toLowerCase();
  return /^bai doc ngay hom nay$/.test(n) || /^loi chua hang ngay$/.test(n) || /^chon ngay/.test(n) || /^your browser does not support/.test(n) || (/^(thu hai|thu ba|thu tu|thu nam|thu sau|thu bay|chua nhat)\b/.test(n) && !/(bai doc|dap ca|tung ho|tin mung|phuc am)/.test(n));
}
function calendarNoise(x = "") { return /Augustinô ©|Tôi tin để hiểu|Liên hệ:|Phi lợi nhuận|Vô vị lợi|Giới thiệu|Kinh Thánh|Giáo Huấn|Phụng Vụ|Cầu Nguyện|Công Cụ|Thomism|Tìm kiếm|Menu|Facebook|Instagram|Youtube|Podcast|Cookie/i.test(x); }
function calendarInstruction(x = "") { return /Không cử hành|Hướng dẫn|Cấm cử hành|Đọc Kinh|Hôm nay lần hạt|Ngày thế giới|Cha xứ|Quyên góp|thánh lễ cầu|luật giữ chay|MÙA\s+/i.test(x); }
function vaticanNoise(x = "") { return /Menu|Tìm kiếm|Facebook|Twitter|Youtube|Instagram|Rss|Cookie|I AGREE|Chọn ngôn ngữ|English|Italiano|Français|Deutsch|Español|Português|Polski|tiếng việt/i.test(x); }
function vaticanChrome(x = "") { return /Xin hỗ trợ sứ mạng|Thêm các sự kiện sắp tới|Lịch trình của ĐGH|Các buổi tiếp kiến chung|Tất cả kinh nguyện|Hoạt động của ĐGH|Đức tin chúng ta|Thông tin hữu ích|Chúng tôi là ai|Liên lạc|Những câu hỏi thường gặp|Chú thích pháp luật|Privacy Policy|Các mạng khác|Vatican\.va|Vaticanstate\.va|Peter's Pence|Photo|Các kênh khác|Schedules|Short Waves|Tải chuyên nghiệp|Copyright|Dicasterium pro Communicatione/i.test(x); }
function copyrightLine(x = "") { return /Bản văn Kinh Thánh|Nhóm Phiên Dịch Các Giờ Kinh Phụng Vụ|ktcgkpv\.org|Gửi đi|^In$/i.test(x); }
function footerStop(x = "") { return /Xin hỗ trợ sứ mạng|Bản văn Kinh Thánh|Gửi đi|Thêm các sự kiện sắp tới|Hoạt động của ĐGH|Đức tin chúng ta|Thông tin hữu ích|Các mạng khác|Vatican\.va|Copyright|Dicasterium pro Communicatione/i.test(x); }

function firstIndex(text, arr) { const low = noAccent(String(text || "")).toLowerCase(); let best = -1; for (const n of arr) { const i = low.indexOf(noAccent(n).toLowerCase()); if (i >= 0 && (best < 0 || i < best)) best = i; } return best; }
function uniqueByDate(arr) { return [...new Map((arr || []).filter(Boolean).map(d => [d.date, d])).values()]; }
function wantsReadings(v) { return /^(1|true|yes|full|readings)$/i.test(String(v || "")); }
function normDate(v) { const m = String(v || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (!m) return ""; const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]); if (!validYear(y) || !validMonth(mo) || d < 1 || d > 31) return ""; const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : ""; }
function todayVN() { const p = new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const g = t => p.find(x => x.type === t)?.value || ""; return `${g("year")}-${g("month")}-${g("day")}`; }
function validYear(y) { return Number.isInteger(y) && y >= 1900 && y <= 2199; }
function validMonth(m) { return Number.isInteger(m) && m >= 1 && m <= 12; }
function text(v) { return clean(v); }
function clean(v = "") { return decodeEntities(String(v == null ? "" : Array.isArray(v) ? v.join("\n") : v)).replace(/\^\{([^}]+)\}/g, "$1").replace(/\s+([,.;:!?])/g, "$1").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").trim(); }
function noAccent(s = "") { return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D"); }
function cleanPath(p) { p = String(p || "/").replace(/\/{2,}/g, "/"); if (p.length > 1) p = p.replace(/\/+$/, ""); return p || "/"; }
function pad(n) { return String(n).padStart(2, "0"); }
function j(data, status = 200, maxAge = 300) { return cors(JSON.stringify(data, null, 2), status, { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=86400` }); }
function cors(body, status = 200, h = {}) { return new Response(body, { status, headers: { ...h, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With", "Access-Control-Max-Age": "86400", "X-Content-Type-Options": "nosniff" } }); }
