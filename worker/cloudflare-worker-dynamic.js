const CONFIG = {
  DATA_BASES: [
    "https://koncauheinfovn.github.io/loichuamoingay/data",
    "https://raw.githubusercontent.com/koncauheinfovn/loichuamoingay/main/data"
  ],
  AUGUSTINO_CALENDAR: "https://augustino.net/lich-phung-vu",
  AUGUSTINO_READINGS: "https://www.augustino.net/loi-chua-hom-nay",
  VATICAN_READINGS: "https://www.vaticannews.va/vi/loi-chua-hang-ngay",
  TIMEZONE: "Asia/Ho_Chi_Minh",
  CACHE: {
    date: 300,
    month: 900,
    year: 3600,
    static: 3600
  }
};

export default {
  async fetch(request) {
    try {
      if (request.method === "OPTIONS") return cors("", 204);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ success: false, error: "Method not allowed" }, 405, 60);
      }

      const url = new URL(request.url);
      const path = cleanPath(url.pathname);

      if (path === "/" || path === "/api") {
        return json({
          success: true,
          name: "Lời Chúa + Lịch phụng vụ Việt Nam tự động",
          fixed_year: false,
          endpoints: [
            "/api/today",
            "/api/date/YYYY-MM-DD",
            "/api/month?y=YYYY&m=MM",
            "/api/year/YYYY",
            "/api/years?from=YYYY&to=YYYY"
          ],
          updated: new Date().toISOString()
        }, 200, CONFIG.CACHE.static);
      }

      if (path === "/api/health") {
        return json({
          success: true,
          ok: true,
          today_vietnam: todayVN(),
          fixed_year: false
        }, 200, 60);
      }

      if (path === "/api/today") return handleDate(url.searchParams.get("date") || todayVN());
      if (path === "/api/date") return handleDate(url.searchParams.get("date"));
      if (path.startsWith("/api/date/")) return handleDate(decodeURIComponent(path.slice("/api/date/".length)));

      if (path === "/api/month") {
        const today = todayVN();
        const y = Number(url.searchParams.get("y") || url.searchParams.get("year") || today.slice(0, 4));
        const m = Number(url.searchParams.get("m") || url.searchParams.get("month") || today.slice(5, 7));
        return handleMonth(y, m);
      }

      if (path.startsWith("/api/year/")) {
        const y = Number(path.slice("/api/year/".length));
        return handleYear(y, url.searchParams.get("live") === "1");
      }

      if (path === "/api/years") {
        const current = Number(todayVN().slice(0, 4));
        const from = Number(url.searchParams.get("from") || current);
        const to = Number(url.searchParams.get("to") || current + 5);
        return json({
          success: true,
          years: range(from, to),
          mode: "dynamic",
          fixed_year: false,
          updated: new Date().toISOString()
        }, 200, CONFIG.CACHE.static);
      }

      return json({ success: false, error: "Endpoint không tồn tại", path }, 404, 60);

    } catch (err) {
      return json({ success: false, error: err?.message || String(err) }, 500, 60);
    }
  }
};

async function handleDate(input) {
  const date = normalizeDate(input);
  if (!date) return json({ success: false, error: "Ngày không hợp lệ. Dùng YYYY-MM-DD." }, 400, 60);

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const monthData = await getMonth(year, month);
  let day = monthData.days.find(item => item.date === date) || null;

  if (!day) {
    return json({ success: false, error: "Không tìm thấy dữ liệu ngày này.", date }, 404, 120);
  }

  const readings = await fetchReadings(date).catch(() => null);
  if (readings) {
    day.readings = mergeReadings(day.readings, readings.readings);
    day.reflection = readings.reflection || day.reflection;
    day.source.gospel = readings.source || day.source.gospel;
  }

  if (day.liturgy?.saint && !day.liturgy.saint.image) {
    const query = day.liturgy.saint.name || day.liturgy.celebration || "";
    const image = await fetchImage(query).catch(() => null);
    if (image) day.liturgy.saint = { ...day.liturgy.saint, ...image, name: day.liturgy.saint.name || image.name || "" };
  }

  return json({
    success: true,
    ...day,
    data: day,
    updated: new Date().toISOString()
  }, 200, CONFIG.CACHE.date);
}

async function handleMonth(year, month) {
  if (!validYear(year) || !validMonth(month)) {
    return json({ success: false, error: "Năm hoặc tháng không hợp lệ." }, 400, 60);
  }

  const data = await getMonth(year, month);
  return json(data, 200, CONFIG.CACHE.month);
}

async function handleYear(year, forceLive) {
  if (!validYear(year)) return json({ success: false, error: "Năm không hợp lệ." }, 400, 60);

  if (!forceLive) {
    const cached = await loadJson(`year-${year}.json`, CONFIG.CACHE.year).catch(() => null);
    if (cached?.days) {
      return json({
        success: true,
        year,
        count: cached.days.length,
        days: cached.days,
        source: cached.source || {},
        updated: cached.updated || new Date().toISOString()
      }, 200, CONFIG.CACHE.year);
    }
  }

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const data = await getMonth(year, m, true);
    months.push(...data.days);
  }

  const days = [...new Map(months.map(item => [item.date, item])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));

  return json({
    success: true,
    year,
    count: days.length,
    days,
    source: { calendar: CONFIG.AUGUSTINO_CALENDAR },
    updated: new Date().toISOString()
  }, 200, CONFIG.CACHE.year);
}

async function getMonth(year, month, skipYearFile = false) {
  const monthKey = `${year}-${pad(month)}`;

  const monthFile = await loadJson(`month-${monthKey}.json`, CONFIG.CACHE.month).catch(() => null);
  if (monthFile?.days) return normalizeMonthResponse(year, month, monthFile.days, monthFile.source, monthFile.updated);

  if (!skipYearFile) {
    const yearFile = await loadJson(`year-${year}.json`, CONFIG.CACHE.month).catch(() => null);
    if (yearFile?.days) {
      const days = yearFile.days.filter(item => String(item.date || "").startsWith(monthKey));
      if (days.length) return normalizeMonthResponse(year, month, days, yearFile.source, yearFile.updated);
    }
  }

  const html = await fetchText(`${CONFIG.AUGUSTINO_CALENDAR}?y=${year}&m=${pad(month)}`);
  const days = parseCalendar(html, year, month);
  return normalizeMonthResponse(year, month, days, { calendar: `${CONFIG.AUGUSTINO_CALENDAR}?y=${year}&m=${pad(month)}` }, new Date().toISOString());
}

function normalizeMonthResponse(year, month, days, source = {}, updated = "") {
  return {
    success: true,
    year,
    month,
    month_key: `${year}-${pad(month)}`,
    count: days.length,
    source,
    updated: updated || new Date().toISOString(),
    days: days.map(normalizeDay).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date))
  };
}

function parseCalendar(html, year, month) {
  const text = htmlToText(html);
  const lines = text.split("\n").map(cleanLine).filter(Boolean).filter(line => !isNoise(line));

  const blocks = [];
  let current = null;

  for (const line of lines) {
    const header = line.match(/^(\d{1,2})\s+(Chúa Nhật|Thứ Hai|Thứ Ba|Thứ Tư|Thứ Năm|Thứ Sáu|Thứ Bảy)(?:[.\s]+)?(.*)$/i);
    if (header) {
      if (current) blocks.push(current);
      current = {
        day: Number(header[1]),
        weekday: canonicalWeekday(header[2]),
        title: cleanLine(header[3].replace(/\bChi tiết\b/gi, "")),
        lines: []
      };
      continue;
    }

    if (current) current.lines.push(line);
  }

  if (current) blocks.push(current);

  return blocks
    .filter(block => block.day >= 1 && block.day <= new Date(year, month, 0).getDate())
    .map(block => buildDay(block, year, month));
}

function buildDay(block, year, month) {
  const date = `${year}-${pad(month)}-${pad(block.day)}`;
  const readingIndex = block.lines.findIndex(line => /^Bài đọc:/i.test(line));
  const readingLine = readingIndex >= 0 ? block.lines[readingIndex].replace(/^Bài đọc:\s*/i, "").trim() : "";
  const before = readingIndex >= 0 ? block.lines.slice(0, readingIndex) : block.lines;
  const notes = readingIndex >= 0 ? block.lines.slice(readingIndex + 1) : [];
  const celebrationLines = before.filter(line => !isInstruction(line));
  const celebration = pickCelebration(block.title, celebrationLines);
  const rank = detectRank([celebration, block.title, ...celebrationLines].join(" "));
  const saintName = extractSaintName(celebrationLines.join(" ") || celebration);
  const season = detectSeason(block.title, celebrationLines.join(" "));
  const week = detectWeek(block.title);
  const color = detectColor(`${block.title} ${celebration} ${rank} ${season}`);
  const refs = splitReadingReferences(readingLine);

  return {
    date,
    weekday: block.weekday,
    liturgy: {
      season,
      week,
      year_cycle: detectYearCycle(year, month, block.day),
      celebration,
      rank,
      color,
      saint: { name: saintName, image: "", wiki: "" }
    },
    readings: {
      reading1: { reference: refs.reading1, text: "" },
      psalm: { reference: "", response: "" },
      gospel_acclamation: "",
      gospel: { reference: refs.gospel, text: "" }
    },
    reflection: { title: "", content: "" },
    notes: notes.filter(line => !isNoise(line)),
    source: { calendar: `${CONFIG.AUGUSTINO_CALENDAR}?y=${year}&m=${pad(month)}`, gospel: "" },
    updated: new Date().toISOString()
  };
}

async function fetchReadings(date) {
  const [year, month, day] = date.split("-").map(Number);

  const augustinoUrl = `${CONFIG.AUGUSTINO_READINGS}?d=${pad(day)}&m=${pad(month)}&y=${year}`;
  const augustino = await fetchText(augustinoUrl).then(html => parseReadings(html, augustinoUrl)).catch(() => null);
  if (augustino && hasAnyReading(augustino.readings)) return augustino;

  const vaticanUrl = `${CONFIG.VATICAN_READINGS}/${year}/${pad(month)}/${pad(day)}.html`;
  const vatican = await fetchText(vaticanUrl).then(html => parseReadings(html, vaticanUrl)).catch(() => null);
  if (vatican && hasAnyReading(vatican.readings)) return vatican;

  return null;
}

function parseReadings(html, source) {
  const lines = htmlToText(html)
    .split("\n")
    .map(cleanLine)
    .filter(Boolean)
    .filter(line => !isNoise(line))
    .filter(line => !/Bản văn Kinh Thánh|ktcgkpv\.org|Gửi đi|In trang này|In$/i.test(line));

  const sections = [];
  let current = { label: "Lời Chúa", reference: "", paragraphs: [] };

  for (const line of lines) {
    const header = detectReadingHeader(line);
    if (header) {
      if (current.paragraphs.length || current.reference) sections.push(current);
      current = { label: header.label, reference: header.reference, paragraphs: [] };
      continue;
    }

    if (!current.reference && looksLikeReference(line)) {
      current.reference = line;
      continue;
    }

    current.paragraphs.push(line);
  }

  if (current.paragraphs.length || current.reference) sections.push(current);

  const readings = {
    reading1: { reference: "", text: "" },
    psalm: { reference: "", response: "" },
    gospel_acclamation: "",
    gospel: { reference: "", text: "" }
  };
  const reflection = { title: "", content: "" };

  for (const section of sections) {
    const label = noAccent(section.label).toLowerCase();
    const content = section.paragraphs.join("\n").trim();
    if (/bai doc/.test(label) && !readings.reading1.text) readings.reading1 = { reference: section.reference, text: content };
    else if (/dap ca|thanh vinh/.test(label)) readings.psalm = { reference: section.reference, response: content };
    else if (/tung ho/.test(label)) readings.gospel_acclamation = content;
    else if (/tin mung|phuc am/.test(label)) readings.gospel = { reference: section.reference, text: content };
    else if (/suy niem|chia se/.test(label)) reflection.title = section.label, reflection.content = content;
  }

  return { readings, reflection, source };
}

async function fetchImage(query) {
  query = String(query || "").trim();
  if (!query) return null;

  const vi = await wikiImage("vi", query).catch(() => null);
  if (vi) return vi;

  const en = await wikiImage("en", query).catch(() => null);
  if (en) return en;

  return commonsImage(query).catch(() => null);
}

async function wikiImage(lang, query) {
  const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "1",
    prop: "pageimages|info",
    piprop: "original|thumbnail",
    pithumbsize: "900",
    inprop: "url",
    format: "json",
    origin: "*"
  });
  const data = await fetchJson(url);
  const pages = data?.query?.pages;
  if (!pages) return null;
  for (const page of Object.values(pages)) {
    const image = page?.original?.source || page?.thumbnail?.source || "";
    const wiki = page?.fullurl || "";
    if (https(image) || https(wiki)) return { name: page?.title || query, image: https(image) ? image : "", wiki: https(wiki) ? wiki : "" };
  }
  return null;
}

async function commonsImage(query) {
  const url = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
    action: "query",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: "1",
    gsrsearch: `${query} Catholic saint portrait`,
    prop: "imageinfo",
    iiprop: "url",
    format: "json",
    origin: "*"
  });
  const data = await fetchJson(url);
  const pages = data?.query?.pages;
  if (!pages) return null;
  for (const page of Object.values(pages)) {
    const image = page?.imageinfo?.[0]?.url || "";
    if (https(image)) return { name: page?.title || query, image, wiki: "" };
  }
  return null;
}

function normalizeDay(input) {
  if (!input || typeof input !== "object") return null;
  const liturgy = input.liturgy || {};
  const saint = typeof liturgy.saint === "string" ? { name: liturgy.saint } : (liturgy.saint || {});
  return {
    date: input.date,
    weekday: input.weekday || "",
    liturgy: {
      season: text(liturgy.season),
      week: text(liturgy.week),
      year_cycle: text(liturgy.year_cycle),
      celebration: text(liturgy.celebration),
      rank: text(liturgy.rank),
      color: text(liturgy.color),
      saint: {
        name: text(saint.name),
        image: safeUrl(saint.image),
        wiki: safeUrl(saint.wiki)
      }
    },
    readings: input.readings || {
      reading1: { reference: "", text: "" },
      psalm: { reference: "", response: "" },
      gospel_acclamation: "",
      gospel: { reference: "", text: "" }
    },
    reflection: input.reflection || { title: "", content: "" },
    notes: input.notes || [],
    source: input.source || { calendar: "", gospel: "" },
    updated: input.updated || ""
  };
}

async function loadJson(filename, cacheSeconds) {
  const errors = [];
  for (const base of CONFIG.DATA_BASES) {
    const url = `${base.replace(/\/+$/, "")}/${filename}`;
    try {
      const res = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "CloudflareWorker loichuamoingay-dynamic" },
        cf: { cacheTtl: cacheSeconds, cacheEverything: true }
      });
      if (!res.ok) {
        errors.push(`${url} HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      errors.push(`${url} ${err?.message || err}`);
    }
  }
  throw new Error(`Không tải được ${filename}: ${errors.join(" | ")}`);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 CloudflareWorker loichuamoingay-dynamic",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi,en;q=0.8"
    },
    cf: { cacheTtl: 900, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" }, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function htmlToText(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function detectReadingHeader(line) {
  const value = cleanLine(line);
  const normalized = noAccent(value).toLowerCase();
  const map = [
    [/^bai doc\s*(i|1)?\s*[-–:]?/i, "Bài đọc I"],
    [/^bai doc\s*ii\s*[-–:]?/i, "Bài đọc II"],
    [/^dap ca\s*[-–:]?/i, "Đáp ca"],
    [/^tung ho tin mung\s*[-–:]?/i, "Tung hô Tin Mừng"],
    [/^(tin mung|phuc am)\s*[-–:]?/i, "Tin Mừng"],
    [/^suy niem\s*[-–:]?/i, "Suy niệm"]
  ];
  for (const [re, label] of map) {
    if (re.test(normalized)) {
      const reference = value.replace(/^(Bài đọc\s*(I|II|1|2)?|Đáp ca|Tung hô Tin Mừng|Tin Mừng|Phúc Âm|Suy Niệm)\s*[-–:]?\s*/i, "").trim();
      return { label, reference };
    }
  }
  return null;
}

function splitReadingReferences(line) {
  const value = String(line || "").replace(/\s+/g, " ").trim();
  const gospel = value.match(/\b(Mt|Mc|Lc|Ga)\s+\d[\d,.\-–;ab\s]*/i);
  if (!gospel) return { reading1: value, gospel: "" };
  return { reading1: value.slice(0, gospel.index).trim(), gospel: gospel[0].trim() };
}

function pickCelebration(title, lines) {
  return lines.find(line => /lễ\s+(trọng|kính|nhớ)|Chúa|Đức Mẹ|Thánh/i.test(line)) || title || "";
}

function extractSaintName(value = "") {
  const match = String(value).match(/((?:Thánh|Thánh Nữ|Các Thánh|Đức Mẹ|Chúa)\s+[^.,;]+)/i);
  return match ? cleanLine(match[1]) : "";
}

function detectRank(value = "") {
  const s = noAccent(value).toLowerCase();
  if (/le trong/.test(s)) return "Lễ trọng";
  if (/le kinh/.test(s)) return "Lễ kính";
  if (/le nho/.test(s)) return "Lễ nhớ";
  if (/nho tu do/.test(s)) return "Lễ nhớ tự do";
  if (/chua nhat/.test(s)) return "Chúa nhật";
  return "Lễ thường";
}

function detectColor(value = "") {
  const s = noAccent(value).toLowerCase();
  if (/tu dao|thuong kho|chua thanh than|tong do|le la|phero|phaolo|banaba/.test(s)) return "Đỏ";
  if (/mua chay|mua vong/.test(s) && !/le trong|le kinh|duc me|thanh|chua giang sinh|truyen tin/.test(s)) return "Tím";
  if (/chua nhat iii mua vong|chua nhat iv mua chay/.test(s)) return "Hồng";
  if (/thanh|duc me|chua|le trong|le kinh|giang sinh|phuc sinh|truyen tin|thanh tam|trai tim/.test(s)) return "Trắng";
  return "Xanh";
}

function detectSeason(title = "", lines = "") {
  const s = `${title} ${lines}`;
  if (/Mùa Vọng/i.test(s)) return "Mùa Vọng";
  if (/Mùa Chay/i.test(s)) return "Mùa Chay";
  if (/Phục Sinh|Bát Nhật Phục Sinh/i.test(s)) return "Mùa Phục Sinh";
  if (/Giáng Sinh|Bát Nhật Giáng Sinh/i.test(s)) return "Mùa Giáng Sinh";
  if (/Thường Niên/i.test(s)) return "Mùa Thường Niên";
  return "";
}

function detectWeek(title = "") {
  const match = String(title).match(/Tuần\s+([0-9IVXLCDM]+)\s+([^,\n]+)/i);
  return match ? `Tuần ${match[1]} ${match[2]}`.replace(/\bChi tiết\b/gi, "").trim() : "";
}

function detectYearCycle(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const liturgicalYear = date >= firstAdventSunday(year) ? year + 1 : year;
  const mod = liturgicalYear % 3;
  return mod === 1 ? "A" : mod === 2 ? "B" : "C";
}

function firstAdventSunday(year) {
  const d = new Date(Date.UTC(year, 10, 27));
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d;
}

function mergeReadings(base = {}, extra = {}) {
  return {
    reading1: { reference: extra.reading1?.reference || base.reading1?.reference || "", text: extra.reading1?.text || base.reading1?.text || "" },
    psalm: { reference: extra.psalm?.reference || base.psalm?.reference || "", response: extra.psalm?.response || base.psalm?.response || "" },
    gospel_acclamation: extra.gospel_acclamation || base.gospel_acclamation || "",
    gospel: { reference: extra.gospel?.reference || base.gospel?.reference || "", text: extra.gospel?.text || base.gospel?.text || "" }
  };
}

function hasAnyReading(r = {}) {
  return Boolean(r.reading1?.text || r.psalm?.response || r.gospel_acclamation || r.gospel?.text);
}

function looksLikeReference(line = "") {
  return /\b(St|Xh|Lv|Ds|Đnl|Gs|Tl|R|1 Sm|2 Sm|1 V|2 V|Is|Gr|Ed|Đn|Hs|Ge|Am|Mk|Xp|Dcr|Ml|Cv|Rm|1 Cr|2 Cr|Gl|Ep|Pl|Cl|1 Tx|2 Tx|1 Tm|2 Tm|Tt|Dt|Hr|Gc|1 Pr|2 Pr|1 Ga|2 Ga|3 Ga|Gđ|Kh|Mt|Mc|Lc|Ga)\s+\d/i.test(line);
}

function isNoise(line = "") {
  return /Augustinô ©|Tôi tin để hiểu|Liên hệ:|Phi lợi nhuận|Vô vị lợi|Giới thiệu|Kinh Thánh|Giáo Huấn|Phụng Vụ|Cầu Nguyện|Công Cụ|Thomism|Tìm kiếm|Menu|Facebook|Instagram|Youtube|Podcast|Cookie|Bản văn Kinh Thánh|ktcgkpv\.org|Gửi đi|In trang này/i.test(line);
}

function isInstruction(line = "") {
  return /Không cử hành|Hướng dẫn|Cấm cử hành|Đọc Kinh|Hôm nay lần hạt|Ngày thế giới|Cha xứ|Quyên góp|thánh lễ cầu|luật giữ chay|MÙA\s+/i.test(line);
}

function canonicalWeekday(value = "") {
  const s = noAccent(value).toLowerCase();
  if (s.includes("chua nhat")) return "Chúa Nhật";
  if (s.includes("thu hai")) return "Thứ Hai";
  if (s.includes("thu ba")) return "Thứ Ba";
  if (s.includes("thu tu")) return "Thứ Tư";
  if (s.includes("thu nam")) return "Thứ Năm";
  if (s.includes("thu sau")) return "Thứ Sáu";
  if (s.includes("thu bay")) return "Thứ Bảy";
  return value;
}

function normalizeDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return "";
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return "";
  return `${y}-${pad(m)}-${pad(d)}`;
}

function validYear(y) { return Number.isInteger(y) && y >= 1900 && y <= 2199; }
function validMonth(m) { return Number.isInteger(m) && m >= 1 && m <= 12; }
function safeUrl(url = "") { return /^https:\/\//i.test(String(url)) ? String(url) : ""; }
function https(url = "") { return /^https:\/\//i.test(String(url)); }
function text(value) { return String(value || "").trim(); }
function cleanLine(line = "") { return String(line).replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim(); }
function noAccent(str = "") { return String(str).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D"); }
function cleanPath(pathname) { let path = String(pathname || "/").replace(/\/{2,}/g, "/"); if (path.length > 1) path = path.replace(/\/+$/, ""); return path || "/"; }
function todayVN() { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const get = t => parts.find(p => p.type === t)?.value || ""; return `${get("year")}-${get("month")}-${get("day")}`; }
function range(from, to) { const arr = []; for (let y = from; y <= to; y++) arr.push(y); return arr; }
function pad(n) { return String(n).padStart(2, "0"); }

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
