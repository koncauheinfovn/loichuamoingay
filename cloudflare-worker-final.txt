// ======================================================
// CLOUDFLARE WORKER - LỜI CHÚA + LỊCH PHỤNG VỤ
// Không cố định năm.
// Không xuất Suy niệm.
// Không tự tìm ảnh ngoài.
// Lịch: Augustino.
// Lời Chúa: Vatican News, tách đủ Bài đọc I, Bài đọc II, Đáp ca,
// Tung hô Tin Mừng, Tin Mừng.
// ======================================================

const CONFIG = {
  GITHUB_DATA_BASES: [
    "https://koncauheinfovn.github.io/loichuamoingay/data",
    "https://raw.githubusercontent.com/koncauheinfovn/loichuamoingay/main/data"
  ],
  AUGUSTINO_CALENDAR: "https://augustino.net/lich-phung-vu",
  VATICAN_READINGS: "https://www.vaticannews.va/vi/loi-chua-hang-ngay",
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
        return json({ success: false, error: "Method not allowed" }, 405, 60);
      }

      const url = new URL(request.url);
      const path = cleanPath(url.pathname);

      if (path === "/" && url.searchParams.has("date")) {
        return handleDate(url.searchParams.get("date"));
      }

      if (path === "/" || path === "/api") {
        return json({
          success: true,
          name: "Lời Chúa + Lịch phụng vụ Việt Nam",
          fixed_year: false,
          no_reflection: true,
          safe_image: true,
          sources: {
            calendar: CONFIG.AUGUSTINO_CALENDAR + "?y=YYYY&m=MM",
            readings: CONFIG.VATICAN_READINGS + "/YYYY/MM/DD.html"
          },
          endpoints: [
            "/api/today",
            "/api/date/2026-06-01",
            "/api/month?y=2026&m=6",
            "/api/year/2026"
          ],
          updated: new Date().toISOString()
        }, 200, 300);
      }

      if (path === "/api/health") {
        return json({
          success: true,
          ok: true,
          today_vietnam: todayVN(),
          updated: new Date().toISOString()
        }, 200, 60);
      }

      if (path === "/api/today") return handleDate(url.searchParams.get("date") || todayVN());
      if (path === "/api/date") return handleDate(url.searchParams.get("date"));
      if (path.startsWith("/api/date/")) return handleDate(decodeURIComponent(path.slice("/api/date/".length)));

      if (path === "/api/month") {
        const today = todayVN();
        const year = Number(url.searchParams.get("y") || url.searchParams.get("year") || today.slice(0, 4));
        const month = Number(url.searchParams.get("m") || url.searchParams.get("month") || today.slice(5, 7));
        return handleMonth(year, month);
      }

      if (path.startsWith("/api/year/")) {
        const year = Number(path.slice("/api/year/".length));
        return handleYear(year);
      }

      return json({ success: false, error: "Endpoint không tồn tại", path }, 404, 60);
    } catch (err) {
      return json({ success: false, error: err?.message || String(err) }, 500, 60);
    }
  }
};

async function handleDate(inputDate) {
  const date = normalizeDate(inputDate);
  if (!date) return json({ success: false, error: "Ngày không hợp lệ. Dùng YYYY-MM-DD." }, 400, 60);

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const monthData = await getMonthData(year, month);
  const day = monthData.days.find(item => item.date === date) || null;

  if (!day) return json({ success: false, error: "Không tìm thấy lịch phụng vụ cho ngày này.", date }, 404, 120);

  const readings = await getReadings(date).catch(() => null);
  if (readings && hasAnyReading(readings.readings)) {
    day.readings = mergeReadings(day.readings, readings.readings);
    day.source.gospel = readings.source || "";
  }

  day.reflection = { title: "", content: "" };
  if (day.liturgy?.saint) day.liturgy.saint.image = "";

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
  return json(await getMonthData(year, month), 200, CONFIG.CACHE.month);
}

async function handleYear(year) {
  if (!validYear(year)) return json({ success: false, error: "Năm không hợp lệ." }, 400, 60);

  const months = [];
  for (let month = 1; month <= 12; month++) {
    const data = await getMonthData(year, month);
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

// =========================
// CALENDAR
// =========================

async function getMonthData(year, month) {
  const monthKey = `${year}-${pad(month)}`;

  const monthFile = await loadJson(`month-${monthKey}.json`, CONFIG.CACHE.month).catch(() => null);
  if (monthFile?.days?.length) return normalizeMonth(year, month, monthFile.days, monthFile.source, monthFile.updated);

  const yearFile = await loadJson(`year-${year}.json`, CONFIG.CACHE.month).catch(() => null);
  if (yearFile?.days?.length) {
    const days = yearFile.days.filter(item => String(item.date || "").startsWith(monthKey));
    if (days.length) return normalizeMonth(year, month, days, yearFile.source, yearFile.updated);
  }

  const calendarUrl = `${CONFIG.AUGUSTINO_CALENDAR}?y=${year}&m=${pad(month)}`;
  const html = await fetchText(calendarUrl, CONFIG.CACHE.month);
  const days = parseAugustinoCalendar(html, year, month);

  return normalizeMonth(year, month, days, { calendar: calendarUrl }, new Date().toISOString());
}

function normalizeMonth(year, month, days, source = {}, updated = "") {
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

async function loadJson(filename, cacheSeconds) {
  const errors = [];

  for (const base of CONFIG.GITHUB_DATA_BASES) {
    const fileUrl = `${base.replace(/\/+$/, "")}/${filename}`;
    try {
      const res = await fetch(fileUrl, {
        headers: { "Accept": "application/json", "User-Agent": "CloudflareWorker loichuamoingay" },
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

  throw new Error(errors.join(" | "));
}

function parseAugustinoCalendar(html, year, month) {
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
    .filter(block => block.day >= 1 && block.day <= daysInMonth(year, month))
    .map(block => buildCalendarDay(block, year, month));
}

function buildCalendarDay(block, year, month) {
  const date = `${year}-${pad(month)}-${pad(block.day)}`;
  const readingIndex = block.lines.findIndex(line => /^Bài đọc:/i.test(line));
  const readingLine = readingIndex >= 0 ? block.lines[readingIndex].replace(/^Bài đọc:\s*/i, "").trim() : "";
  const before = readingIndex >= 0 ? block.lines.slice(0, readingIndex) : block.lines;
  const after = readingIndex >= 0 ? block.lines.slice(readingIndex + 1) : [];

  const celebrationLines = before
    .filter(line => !isInstruction(line))
    .filter(line => !/^MÙA\s+/i.test(line));

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
      reading2: { reference: "", text: "" },
      psalm: { reference: "", response: "" },
      gospel_acclamation: "",
      gospel: { reference: refs.gospel, text: "" }
    },
    reflection: { title: "", content: "" },
    notes: after.filter(line => !isNoise(line)),
    source: { calendar: `${CONFIG.AUGUSTINO_CALENDAR}?y=${year}&m=${pad(month)}`, gospel: "" },
    updated: new Date().toISOString()
  };
}

// =========================
// READINGS
// =========================

async function getReadings(date) {
  const [year, month, day] = date.split("-");
  const url = `${CONFIG.VATICAN_READINGS}/${year}/${month}/${day}.html`;
  const html = await fetchText(url, CONFIG.CACHE.date);
  return parseVaticanReadings(html, url);
}

function parseVaticanReadings(html, source) {
  let text = htmlToText(html);

  const start = findFirstIndex(text, ["Bài đọc ngày hôm nay", "Bài đọc 1", "Bài đọc I"]);
  if (start >= 0) text = text.slice(start);

  const end = findFirstIndex(text, [
    "Xin hỗ trợ sứ mạng",
    "Bản văn Kinh Thánh",
    "Gửi đi",
    "Thêm các sự kiện sắp tới",
    "Hoạt động của ĐGH",
    "Đức tin chúng ta",
    "Thông tin hữu ích",
    "Các mạng khác",
    "Vatican.va",
    "Copyright ©",
    "Dicasterium pro Communicatione"
  ]);
  if (end >= 0) text = text.slice(0, end);

  const lines = text
    .split("\n")
    .map(cleanLine)
    .filter(Boolean)
    .filter(line => !isNoise(line))
    .filter(line => !isCopyright(line))
    .filter(line => !isVaticanChrome(line));

  const readings = emptyReadings();
  const buckets = { reading1: [], reading2: [], psalm: [], acclamation: [], gospel: [] };
  let current = "";
  let hasStarted = false;

  for (const line of lines) {
    if (!line || isFooterStop(line)) break;
    if (isIntroOnlyLine(line)) continue;

    const header = detectReadingHeader(line);

    if (header) {
      current = header.type;
      hasStarted = true;

      if (header.reference) {
        if (current === "reading1") readings.reading1.reference = header.reference;
        if (current === "reading2") readings.reading2.reference = header.reference;
        if (current === "psalm") readings.psalm.reference = header.reference;
        if (current === "gospel") readings.gospel.reference = header.reference;
      }

      if (header.keepLine && current === "gospel") buckets.gospel.push(line);
      continue;
    }

    if (!hasStarted || !current) continue;
    buckets[current].push(line);
  }

  readings.reading1.text = cleanScriptureText(buckets.reading1.join("\n"));
  readings.reading2.text = cleanScriptureText(buckets.reading2.join("\n"));
  readings.psalm.response = cleanScriptureText(buckets.psalm.join("\n"));
  readings.gospel_acclamation = cleanScriptureText(buckets.acclamation.join("\n"));
  readings.gospel.text = cleanScriptureText(buckets.gospel.join("\n"));

  if (!readings.gospel.reference) {
    const ref = readings.gospel.text.match(/\b(Mt|Mc|Lc|Ga)\s+\d[\d,.\-–;abx\s]*/i);
    if (ref) readings.gospel.reference = ref[0].trim();
  }

  return { readings, reflection: { title: "", content: "" }, source };
}

function detectReadingHeader(line) {
  const value = cleanLine(line);
  const normalized = noAccent(value).toLowerCase();

  if (/^bai doc\s*(1|i)\b/.test(normalized)) return { type: "reading1", reference: extractReference(value), keepLine: false };
  if (/^bai doc\s*(2|ii)\b/.test(normalized)) return { type: "reading2", reference: extractReference(value), keepLine: false };

  if (/^dap ca\b/.test(normalized)) {
    return { type: "psalm", reference: extractReference(value) || value.replace(/^Đáp ca\s*/i, "").trim(), keepLine: false };
  }

  if (/^tung ho tin mung\b/.test(normalized)) {
    return { type: "acclamation", reference: extractReference(value) || value.replace(/^Tung hô Tin Mừng\s*/i, "").trim(), keepLine: false };
  }

  if (/^tin mung ngay hom nay\b/.test(normalized)) return { type: "gospel", reference: "", keepLine: false };

  if (/^(✠\s*)?tin mung\b/.test(normalized) || /^phuc am\b/.test(normalized)) {
    return { type: "gospel", reference: extractReference(value), keepLine: true };
  }

  return null;
}

function isIntroOnlyLine(line = "") {
  const normalized = noAccent(line).toLowerCase();
  if (/^bai doc ngay hom nay$/i.test(normalized)) return true;
  if (/^loi chua hang ngay$/i.test(normalized)) return true;
  if (/^chon ngay/i.test(normalized)) return true;
  if (/^your browser does not support/i.test(normalized)) return true;
  if (/^georg friedrich handel/i.test(normalized)) return true;
  if (/^chuong trinh$/i.test(normalized)) return true;
  if (/^podcast$/i.test(normalized)) return true;

  if (/^(thu hai|thu ba|thu tu|thu nam|thu sau|thu bay|chua nhat)\b/i.test(normalized) &&
      !/(bai doc|dap ca|tung ho|tin mung|phuc am)/i.test(normalized)) {
    return true;
  }

  return false;
}

function cleanScriptureText(value = "") {
  return String(value)
    .split("\n")
    .map(cleanLine)
    .filter(Boolean)
    .filter(line => !isNoise(line))
    .filter(line => !isCopyright(line))
    .filter(line => !isVaticanChrome(line))
    .filter(line => !isFooterStop(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// =========================
// HELPERS
// =========================

async function fetchText(url, cacheSeconds) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 CloudflareWorker loichuamoingay",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi,en;q=0.8"
    },
    cf: { cacheTtl: cacheSeconds, cacheEverything: true }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.text();
}

function normalizeDay(input) {
  if (!input || typeof input !== "object" || !input.date) return null;
  const liturgy = input.liturgy || {};
  const saint = typeof liturgy.saint === "string" ? { name: liturgy.saint } : (liturgy.saint || {});
  const readings = input.readings || emptyReadings();

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
      saint: { name: text(saint.name), image: "", wiki: "" }
    },
    readings: {
      reading1: readings.reading1 || { reference: "", text: "" },
      reading2: readings.reading2 || { reference: "", text: "" },
      psalm: readings.psalm || { reference: "", response: "" },
      gospel_acclamation: readings.gospel_acclamation || "",
      gospel: readings.gospel || { reference: "", text: "" }
    },
    reflection: { title: "", content: "" },
    notes: Array.isArray(input.notes) ? input.notes : [],
    source: input.source || { calendar: "", gospel: "" },
    updated: input.updated || ""
  };
}

function htmlToText(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function emptyReadings() {
  return {
    reading1: { reference: "", text: "" },
    reading2: { reference: "", text: "" },
    psalm: { reference: "", response: "" },
    gospel_acclamation: "",
    gospel: { reference: "", text: "" }
  };
}

function mergeReadings(base = emptyReadings(), extra = emptyReadings()) {
  return {
    reading1: { reference: extra.reading1?.reference || base.reading1?.reference || "", text: extra.reading1?.text || base.reading1?.text || "" },
    reading2: { reference: extra.reading2?.reference || base.reading2?.reference || "", text: extra.reading2?.text || base.reading2?.text || "" },
    psalm: { reference: extra.psalm?.reference || base.psalm?.reference || "", response: extra.psalm?.response || base.psalm?.response || "" },
    gospel_acclamation: extra.gospel_acclamation || base.gospel_acclamation || "",
    gospel: { reference: extra.gospel?.reference || base.gospel?.reference || "", text: extra.gospel?.text || base.gospel?.text || "" }
  };
}

function hasAnyReading(readings = {}) {
  return Boolean(readings.reading1?.text || readings.reading2?.text || readings.psalm?.response || readings.gospel_acclamation || readings.gospel?.text);
}

function extractReference(value = "") {
  const m = String(value).match(/\b(St|Xh|Lv|Ds|Đnl|Gs|Tl|R|1 Sm|2 Sm|1 V|2 V|Is|Gr|Ed|Đn|Hs|Ge|Am|Mk|Xp|Dcr|Ml|Cv|Rm|1 Cr|2 Cr|Gl|Ep|Pl|Cl|1 Tx|2 Tx|1 Tm|2 Tm|Tt|Dt|Hr|Gc|1 Pr|2 Pr|1 Ga|2 Ga|3 Ga|Gđ|Kh|Mt|Mc|Lc|Ga|Tv)\s+[\d,.\-–;abx\s]+/i);
  return m ? cleanLine(m[0]) : "";
}

function splitReadingReferences(value) {
  const line = String(value || "").replace(/\s+/g, " ").trim();
  const gospel = line.match(/\b(Mt|Mc|Lc|Ga)\s+\d[\d,.\-–;abx\s]*/i);
  if (!gospel) return { reading1: line, gospel: "" };
  return { reading1: line.slice(0, gospel.index).trim(), gospel: gospel[0].trim() };
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
  if (/tu dao|thuong kho|chua thanh than|tong do|le la|phero|phaolo|banaba|giustino|justino/.test(s)) return "Đỏ";
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

function isNoise(line = "") {
  return /Augustinô ©|Tôi tin để hiểu|Liên hệ:|Phi lợi nhuận|Vô vị lợi|Giới thiệu|Kinh Thánh|Giáo Huấn|Phụng Vụ|Cầu Nguyện|Công Cụ|Thomism|Tìm kiếm|Menu|Facebook|Instagram|Youtube|Podcast|Cookie|Bản văn Kinh Thánh|ktcgkpv\.org|Gửi đi|In trang này/i.test(line);
}

function isCopyright(line = "") {
  return /Bản văn Kinh Thánh|Nhóm Phiên Dịch Các Giờ Kinh Phụng Vụ|ktcgkpv\.org|Gửi đi|In trang này|In$/i.test(line);
}

function isVaticanChrome(line = "") {
  return /Xin hỗ trợ sứ mạng|Thêm các sự kiện sắp tới|Lịch trình của ĐGH|Các buổi tiếp kiến chung|Tất cả kinh nguyện|Hoạt động của ĐGH|Đức tin chúng ta|Thông tin hữu ích|Chúng tôi là ai|Liên lạc|Những câu hỏi thường gặp|Chú thích pháp luật|Privacy Policy|Các mạng khác|Vatican\.va|Vaticanstate\.va|Peter's Pence|Photo|Các kênh khác|Schedules|Short Waves|Tải chuyên nghiệp|Twitter|Rss|Copyright|Dicasterium pro Communicatione|Chọn ngày|Your browser does not support/i.test(line);
}

function isFooterStop(line = "") {
  return /Xin hỗ trợ sứ mạng|Bản văn Kinh Thánh|Gửi đi|Thêm các sự kiện sắp tới|Hoạt động của ĐGH|Đức tin chúng ta|Thông tin hữu ích|Các mạng khác|Vatican\.va|Copyright|Dicasterium pro Communicatione/i.test(line);
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

function findFirstIndex(text, needles) {
  const lower = noAccent(String(text || "")).toLowerCase();
  let best = -1;
  for (const needle of needles) {
    const idx = lower.indexOf(noAccent(needle).toLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

function normalizeDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return "";
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!validYear(y) || !validMonth(m) || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return "";
  return `${y}-${pad(m)}-${pad(d)}`;
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

function validYear(year) { return Number.isInteger(year) && year >= 1900 && year <= 2199; }
function validMonth(month) { return Number.isInteger(month) && month >= 1 && month <= 12; }
function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
function text(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function cleanLine(line = "") { return String(line).replace(/\^\{([^}]+)\}/g, "$1").replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim(); }
function noAccent(str = "") { return String(str).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D"); }
function cleanPath(pathname) { let path = String(pathname || "/").replace(/\/{2,}/g, "/"); if (path.length > 1) path = path.replace(/\/+$/, ""); return path || "/"; }
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
