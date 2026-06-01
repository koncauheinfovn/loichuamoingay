import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import { fetchSaintImage } from "./image-fetcher.js";

const YEAR = Number(process.env.YEAR || 2026);
const OUT_DIR = path.resolve("data");
const AUGUSTINO_CALENDAR = "https://augustino.net/lich-phung-vu";
const AUGUSTINO_READINGS = "https://www.augustino.net/loi-chua-hom-nay";
const VATICAN_READINGS = "https://www.vaticannews.va/vi/loi-chua-hang-ngay";
const UA = process.env.USER_AGENT || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const TZ = "Asia/Ho_Chi_Minh";

main().catch(err => {
  console.error(err);
  process.exit(1);
});

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const months = [];
  for (let month = 1; month <= 12; month++) {
    console.log(`[augustino] crawl ${YEAR}-${pad(month)}`);
    const html = await requestText(`${AUGUSTINO_CALENDAR}?y=${YEAR}&m=${pad(month)}`);
    const monthDays = parseAugustinoCalendar(html, YEAR, month);
    months.push(...monthDays);
  }

  const byDate = new Map();
  for (const day of months) {
    byDate.set(day.date, day);
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  for (const day of days) {
    const saintQuery = day.liturgy.saint.name || day.liturgy.celebration || "";
    if (saintQuery && !day.liturgy.saint.image) {
      const imageInfo = await fetchSaintImage(saintQuery);
      day.liturgy.saint = {
        name: day.liturgy.saint.name || imageInfo.name || "",
        image: imageInfo.image || "",
        wiki: imageInfo.wiki || ""
      };
    }

    const readings = await fetchReadingsForDate(day.date).catch(() => null);
    if (readings) {
      day.readings = mergeReadings(day.readings, readings.readings);
      day.reflection = readings.reflection || day.reflection;
      day.source.gospel = readings.source || day.source.gospel;
    }

    day.updated = new Date().toISOString();
  }

  const yearJson = {
    success: true,
    year: YEAR,
    count: days.length,
    source: {
      calendar: AUGUSTINO_CALENDAR,
      readings_primary: AUGUSTINO_READINGS,
      readings_fallback: VATICAN_READINGS,
      images: ["Wikipedia API", "Wikimedia Commons API"]
    },
    updated: new Date().toISOString(),
    days
  };

  await writeJson(`year-${YEAR}.json`, yearJson);
  await writeJson("years.json", {
    success: true,
    years: [YEAR],
    updated: new Date().toISOString()
  });

  for (let month = 1; month <= 12; month++) {
    const monthKey = `${YEAR}-${pad(month)}`;
    const monthDays = days.filter(d => d.date.startsWith(monthKey));
    await writeJson(`month-${monthKey}.json`, {
      success: true,
      year: YEAR,
      month,
      month_key: monthKey,
      count: monthDays.length,
      source: yearJson.source,
      updated: yearJson.updated,
      days: monthDays
    });
  }

  const today = todayVN();
  const todayDay = days.find(d => d.date === today) || days[0] || null;
  await writeJson("today.json", {
    success: Boolean(todayDay),
    date: today,
    data: todayDay,
    updated: new Date().toISOString()
  });

  const monthNow = today.slice(0, 7);
  const monthNowDays = days.filter(d => d.date.startsWith(monthNow));
  await writeJson("month.json", {
    success: true,
    month_key: monthNow,
    days: monthNowDays,
    updated: new Date().toISOString()
  });

  const weekDates = getWeekDates(today);
  await writeJson("week.json", {
    success: true,
    start: weekDates[0],
    end: weekDates[6],
    days: days.filter(d => weekDates.includes(d.date)),
    updated: new Date().toISOString()
  });

  console.log(`[done] data/year-${YEAR}.json: ${days.length} days`);
}

function parseAugustinoCalendar(html, year, month) {
  const $ = cheerio.load(html);
  const text = normalizeText($("main").text() || $("body").text());
  const lines = text
    .split("\n")
    .map(s => cleanLine(s))
    .filter(Boolean)
    .filter(line => !isSiteNoise(line));

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
    .map(block => buildDay(block, year, month));
}

function buildDay(block, year, month) {
  const date = `${year}-${pad(month)}-${pad(block.day)}`;
  const sourceUrl = `${AUGUSTINO_CALENDAR}?y=${year}&m=${pad(month)}`;

  const readingIndex = block.lines.findIndex(line => /^Bài đọc:/i.test(line));
  const beforeReadings = readingIndex >= 0 ? block.lines.slice(0, readingIndex) : block.lines;
  const afterReadings = readingIndex >= 0 ? block.lines.slice(readingIndex + 1) : [];

  const readingLine = readingIndex >= 0 ? block.lines[readingIndex].replace(/^Bài đọc:\s*/i, "").trim() : "";
  const celebrationLines = beforeReadings
    .filter(line => !isCalendarGuide(line))
    .filter(line => !/^MÙA\s+/i.test(line));

  const celebration = pickCelebration(block.title, celebrationLines);
  const rank = detectRank([celebration, ...celebrationLines, block.title].join(" "));
  const saintName = extractSaintName(celebrationLines.join(" ") || celebration);
  const season = detectSeason(block.title, celebrationLines.join(" "));
  const week = detectWeek(block.title);
  const yearCycle = detectYearCycle(year, month, block.day);
  const color = detectColor({ title: block.title, celebration, rank, season, readingLine });

  const refs = splitReadingReferences(readingLine);

  return {
    date,
    weekday: block.weekday,
    liturgy: {
      season,
      week,
      year_cycle: yearCycle,
      celebration,
      rank,
      color,
      saint: {
        name: saintName,
        image: "",
        wiki: ""
      }
    },
    readings: {
      reading1: { reference: refs.reading1, text: "" },
      psalm: { reference: "", response: "" },
      gospel_acclamation: "",
      gospel: { reference: refs.gospel, text: "" }
    },
    reflection: {
      title: "",
      content: ""
    },
    notes: afterReadings.filter(line => !isSiteNoise(line)),
    source: {
      calendar: sourceUrl,
      gospel: ""
    },
    updated: new Date().toISOString()
  };
}

async function fetchReadingsForDate(date) {
  const [year, month, day] = date.split("-").map(Number);

  const augustinoUrl = `${AUGUSTINO_READINGS}?d=${pad(day)}&m=${pad(month)}&y=${year}`;
  const augustino = await requestText(augustinoUrl)
    .then(html => parseAugustinoReadings(html, augustinoUrl))
    .catch(() => null);

  if (augustino && hasAnyReading(augustino.readings)) return augustino;

  const vaticanUrl = `${VATICAN_READINGS}/${year}/${pad(month)}/${pad(day)}.html`;
  const vatican = await requestText(vaticanUrl)
    .then(html => parseVaticanReadings(html, vaticanUrl))
    .catch(() => null);

  if (vatican && hasAnyReading(vatican.readings)) return vatican;
  return null;
}

function parseAugustinoReadings(html, url) {
  const $ = cheerio.load(html);
  const text = normalizeText($("main").text() || $("article").text() || $("body").text());
  const lines = text
    .split("\n")
    .map(cleanLine)
    .filter(Boolean)
    .filter(line => !isSiteNoise(line))
    .filter(line => !isCopyrightLine(line));

  return sectionsToReadings(lines, url);
}

function parseVaticanReadings(html, url) {
  const $ = cheerio.load(html);
  const text = normalizeText($("article").text() || $("main").text() || $("body").text());
  const lines = text
    .split("\n")
    .map(cleanLine)
    .filter(Boolean)
    .filter(line => !isSiteNoise(line))
    .filter(line => !isCopyrightLine(line));

  return sectionsToReadings(lines, url);
}

function sectionsToReadings(lines, source) {
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

  for (const sec of sections) {
    const label = removeAccents(sec.label).toLowerCase();
    const content = sec.paragraphs.join("\n").trim();

    if (/bai doc/.test(label) && !readings.reading1.text) {
      readings.reading1 = { reference: sec.reference, text: content };
    } else if (/dap ca|thanh vinh/.test(label)) {
      readings.psalm = { reference: sec.reference, response: content };
    } else if (/tung ho/.test(label)) {
      readings.gospel_acclamation = content;
    } else if (/tin mung/.test(label)) {
      readings.gospel = { reference: sec.reference, text: content };
    } else if (/suy niem|chia se/.test(label)) {
      reflection.title = sec.label;
      reflection.content = content;
    }
  }

  return { readings, reflection, sections, source };
}

function detectReadingHeader(line) {
  const value = cleanLine(line);
  const normalized = removeAccents(value).toLowerCase();

  const patterns = [
    { re: /^bai doc\s*(i|1)?\s*[-–:]?\s*(.*)$/i, label: "Bài đọc I" },
    { re: /^bai doc\s*ii\s*[-–:]?\s*(.*)$/i, label: "Bài đọc II" },
    { re: /^dap ca\s*[-–:]?\s*(.*)$/i, label: "Đáp ca" },
    { re: /^tung ho tin mung\s*[-–:]?\s*(.*)$/i, label: "Tung hô Tin Mừng" },
    { re: /^(?:phuc am|tin mung)\s*[-–:]?\s*(.*)$/i, label: "Tin Mừng" },
    { re: /^suy niem\s*[-–:]?\s*(.*)$/i, label: "Suy niệm" }
  ];

  for (const p of patterns) {
    const m = normalized.match(p.re);
    if (m) {
      const ref = value.replace(new RegExp("^" + value.split(/[-–:]/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[-–:]?", "i"), "").trim();
      return { label: p.label, reference: ref };
    }
  }

  return null;
}

function splitReadingReferences(line) {
  const parts = String(line || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+(?=(Mt|Mc|Lc|Ga)\s+\d)/);

  if (parts.length >= 2) {
    return {
      reading1: parts[0].trim(),
      gospel: parts.slice(1).join(" ").trim()
    };
  }

  const gospel = line.match(/\b(Mt|Mc|Lc|Ga)\s+\d[\d,.\-–;ab\s]*/i);
  if (gospel) {
    return {
      reading1: line.slice(0, gospel.index).trim(),
      gospel: gospel[0].trim()
    };
  }

  return { reading1: line || "", gospel: "" };
}

function pickCelebration(title, lines) {
  const ranked = lines.find(line => /lễ\s+(trọng|kính|nhớ)|Chúa|Đức Mẹ|Thánh/i.test(line));
  if (ranked) return ranked;
  if (title && !/^Tuần\s+\d+/i.test(title)) return title;
  return title || "";
}

function extractSaintName(text = "") {
  const value = String(text).trim();
  const match = value.match(/((?:Thánh|Thánh Nữ|Các Thánh|Đức Mẹ|Chúa)\s+[^.,;]+)/i);
  return match ? cleanLine(match[1]) : "";
}

function detectRank(text = "") {
  const t = removeAccents(text).toLowerCase();
  if (/le trong/.test(t)) return "Lễ trọng";
  if (/le kinh/.test(t)) return "Lễ kính";
  if (/le nho/.test(t)) return "Lễ nhớ";
  if (/nho tu do/.test(t)) return "Lễ nhớ tự do";
  if (/chua nhat/.test(t)) return "Chúa nhật";
  return "Lễ thường";
}

function detectColor({ title = "", celebration = "", rank = "", season = "" }) {
  const t = removeAccents(`${title} ${celebration} ${rank} ${season}`).toLowerCase();

  if (/tu dao|thuong kho|chua thanh than|tong do|le la|phero|phaolo|banaba/.test(t)) return "Đỏ";
  if (/mua chay|mua vong/.test(t) && !/le trong|le kinh|duc me|thanh|chua giang sinh|truyen tin/.test(t)) return "Tím";
  if (/chua nhat iii mua vong|chua nhat iv mua chay/.test(t)) return "Hồng";
  if (/thanh|duc me|chua|le trong|le kinh|giang sinh|phuc sinh|truyen tin|thanh tam|trai tim/.test(t)) return "Trắng";
  return "Xanh";
}

function detectSeason(title = "", lines = "") {
  const t = `${title} ${lines}`;
  if (/Mùa Vọng/i.test(t)) return "Mùa Vọng";
  if (/Mùa Chay/i.test(t)) return "Mùa Chay";
  if (/Phục Sinh|Bát Nhật Phục Sinh/i.test(t)) return "Mùa Phục Sinh";
  if (/Giáng Sinh|Bát Nhật Giáng Sinh/i.test(t)) return "Mùa Giáng Sinh";
  if (/Thường Niên/i.test(t)) return "Mùa Thường Niên";
  return "";
}

function detectWeek(title = "") {
  const m = title.match(/Tuần\s+([0-9IVXLCDM]+)\s+([^\n,]+)/i);
  return m ? `Tuần ${m[1]} ${m[2]}`.replace(/\bChi tiết\b/gi, "").trim() : "";
}

function detectYearCycle(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const effectiveYear = date >= firstAdventSunday(year) ? year + 1 : year;
  const mod = effectiveYear % 3;
  return mod === 1 ? "A" : mod === 2 ? "B" : "C";
}

function firstAdventSunday(year) {
  const d = new Date(Date.UTC(year, 10, 27));
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d;
}

function mergeReadings(base, extra) {
  return {
    reading1: {
      reference: extra?.reading1?.reference || base?.reading1?.reference || "",
      text: extra?.reading1?.text || base?.reading1?.text || ""
    },
    psalm: {
      reference: extra?.psalm?.reference || base?.psalm?.reference || "",
      response: extra?.psalm?.response || base?.psalm?.response || ""
    },
    gospel_acclamation: extra?.gospel_acclamation || base?.gospel_acclamation || "",
    gospel: {
      reference: extra?.gospel?.reference || base?.gospel?.reference || "",
      text: extra?.gospel?.text || base?.gospel?.text || ""
    }
  };
}

function hasAnyReading(readings = {}) {
  return Boolean(
    readings.reading1?.text ||
    readings.psalm?.response ||
    readings.gospel_acclamation ||
    readings.gospel?.text
  );
}

async function requestText(url, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await axios.get(url, {
        responseType: "text",
        timeout: 20000,
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "vi,en;q=0.8"
        },
        validateStatus: status => status >= 200 && status < 500
      });

      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return res.data;
    } catch (err) {
      lastError = err;
      await sleep(500 * (i + 1));
    }
  }
  throw lastError;
}

async function writeJson(filename, data) {
  await fs.writeFile(path.join(OUT_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

function normalizeText(htmlText = "") {
  return String(htmlText)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function cleanLine(line = "") {
  return String(line)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function isSiteNoise(line = "") {
  return /Augustinô ©|Tôi tin để hiểu|Liên hệ:|Phi lợi nhuận|Vô vị lợi|Giới thiệu|Kinh Thánh|Giáo Huấn|Phụng Vụ|Cầu Nguyện|Công Cụ|Thomism|Tìm kiếm|Menu|Facebook|Instagram|Youtube|Podcast|Cookie|Bản văn Kinh Thánh|ktcgkpv\.org|Gửi đi|In trang này/i.test(line);
}

function isCopyrightLine(line = "") {
  return /Bản văn Kinh Thánh|Nhóm Phiên Dịch Các Giờ Kinh Phụng Vụ|ktcgkpv\.org|Gửi đi|In$/i.test(line);
}

function isCalendarGuide(line = "") {
  return /Không cử hành|Hướng dẫn|Cấm cử hành|Đọc Kinh|Hôm nay lần hạt|Ngày thế giới|Cha xứ|Quyên góp|thánh lễ cầu|luật giữ chay|MÙA\s+/i.test(line);
}

function looksLikeReference(line = "") {
  return /\b(St|Xh|Lv|Ds|Đnl|Gs|Tl|R|1 Sm|2 Sm|1 V|2 V|Is|Gr|Ed|Đn|Hs|Ge|Am|Mk|Xp|Dcr|Ml|Cv|Rm|1 Cr|2 Cr|Gl|Ep|Pl|Cl|1 Tx|2 Tx|1 Tm|2 Tm|Tt|Dt|Hr|Gc|1 Pr|2 Pr|1 Ga|2 Ga|3 Ga|Gđ|Kh|Mt|Mc|Lc|Ga)\s+\d/i.test(line);
}

function canonicalWeekday(value = "") {
  const t = removeAccents(value).toLowerCase();
  if (t.includes("chua nhat")) return "Chúa Nhật";
  if (t.includes("thu hai")) return "Thứ Hai";
  if (t.includes("thu ba")) return "Thứ Ba";
  if (t.includes("thu tu")) return "Thứ Tư";
  if (t.includes("thu nam")) return "Thứ Năm";
  if (t.includes("thu sau")) return "Thứ Sáu";
  if (t.includes("thu bay")) return "Thứ Bảy";
  return value;
}

function removeAccents(str = "") {
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function getWeekDates(dateString) {
  const d = new Date(`${dateString}T00:00:00Z`);
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() + mondayOffset);

  return Array.from({ length: 7 }, (_, i) => {
    const item = new Date(start);
    item.setUTCDate(start.getUTCDate() + i);
    return `${item.getUTCFullYear()}-${pad(item.getUTCMonth() + 1)}-${pad(item.getUTCDate())}`;
  });
}

function todayVN() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
