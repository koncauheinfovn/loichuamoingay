import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import { fetchSaintImage } from "./image-fetcher.js";

const OUT_DIR = path.resolve("data");
const AUGUSTINO_CALENDAR = "https://augustino.net/lich-phung-vu";
const AUGUSTINO_READINGS = "https://www.augustino.net/loi-chua-hom-nay";
const VATICAN_READINGS = "https://www.vaticannews.va/vi/loi-chua-hang-ngay";
const TZ = "Asia/Ho_Chi_Minh";
const UA = process.env.USER_AGENT || "Mozilla/5.0 loichuamoingay-dynamic/3.0";

main().catch(err => {
  console.error(err);
  process.exit(1);
});

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const years = resolveYears(process.env.DATA_YEARS || "auto");
  const allYears = [];

  for (const year of years) {
    const yearData = await buildYear(year);
    allYears.push({
      year,
      count: yearData.days.length,
      file: `year-${year}.json`
    });
    await writeJson(`year-${year}.json`, yearData);

    for (let month = 1; month <= 12; month++) {
      const monthKey = `${year}-${pad(month)}`;
      const days = yearData.days.filter(item => item.date.startsWith(monthKey));
      await writeJson(`month-${monthKey}.json`, {
        success: true,
        year,
        month,
        month_key: monthKey,
        count: days.length,
        source: yearData.source,
        updated: yearData.updated,
        days
      });
    }
  }

  await writeJson("years.json", {
    success: true,
    mode: process.env.DATA_YEARS || "auto",
    years: allYears.map(item => item.year),
    files: allYears,
    updated: new Date().toISOString()
  });

  const today = todayVN();
  const todayYear = Number(today.slice(0, 4));
  const todayData = years.includes(todayYear)
    ? JSON.parse(await fs.readFile(path.join(OUT_DIR, `year-${todayYear}.json`), "utf8"))
    : null;
  const todayDay = todayData?.days?.find(item => item.date === today) || null;

  await writeJson("today.json", {
    success: Boolean(todayDay),
    date: today,
    data: todayDay,
    updated: new Date().toISOString()
  });

  if (todayData?.days) {
    const monthKey = today.slice(0, 7);
    const weekDates = getWeekDates(today);
    await writeJson("month.json", {
      success: true,
      month_key: monthKey,
      days: todayData.days.filter(item => item.date.startsWith(monthKey)),
      updated: new Date().toISOString()
    });
    await writeJson("week.json", {
      success: true,
      start: weekDates[0],
      end: weekDates[6],
      days: todayData.days.filter(item => weekDates.includes(item.date)),
      updated: new Date().toISOString()
    });
  }

  console.log(`[done] years: ${years.join(", ")}`);
}

async function buildYear(year) {
  const days = [];

  for (let month = 1; month <= 12; month++) {
    console.log(`[calendar] ${year}-${pad(month)}`);
    const html = await requestText(`${AUGUSTINO_CALENDAR}?y=${year}&m=${pad(month)}`);
    const monthDays = parseAugustinoCalendar(html, year, month);
    days.push(...monthDays);
  }

  const uniqueDays = [...new Map(days.map(item => [item.date, item])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));

  const fullReadings = truthy(process.env.FULL_READINGS || "");
  const fullImages = truthy(process.env.FULL_IMAGES || "1");

  for (const day of uniqueDays) {
    if (fullImages) {
      const query = day.liturgy.saint.name || day.liturgy.celebration || "";
      if (query && !day.liturgy.saint.image) {
        const image = await fetchSaintImage(query).catch(() => null);
        if (image) {
          day.liturgy.saint = {
            name: day.liturgy.saint.name || image.name || "",
            image: image.image || "",
            wiki: image.wiki || ""
          };
        }
      }
    }

    if (fullReadings) {
      const readings = await fetchReadings(day.date).catch(() => null);
      if (readings) {
        day.readings = mergeReadings(day.readings, readings.readings);
        day.reflection = readings.reflection || day.reflection;
        day.source.gospel = readings.source || day.source.gospel;
      }
    }

    day.updated = new Date().toISOString();
  }

  return {
    success: true,
    year,
    count: uniqueDays.length,
    source: {
      calendar: AUGUSTINO_CALENDAR,
      readings_primary: AUGUSTINO_READINGS,
      readings_fallback: VATICAN_READINGS,
      images: ["Wikipedia API", "Wikimedia Commons API"]
    },
    updated: new Date().toISOString(),
    days: uniqueDays
  };
}

function resolveYears(value) {
  const current = Number(todayVN().slice(0, 4));
  const text = String(value || "auto").trim().toLowerCase();

  if (text === "auto") {
    const ahead = Number(process.env.YEARS_AHEAD || 5);
    const behind = Number(process.env.YEARS_BEHIND || 0);
    return range(current - behind, current + ahead);
  }

  if (text === "current") return [current];

  const plus = text.match(/^current\+(\d+)$/);
  if (plus) return range(current, current + Number(plus[1]));

  const minusPlus = text.match(/^current-(\d+)\+(\d+)$/);
  if (minusPlus) return range(current - Number(minusPlus[1]), current + Number(minusPlus[2]));

  const rangeMatch = text.match(/^(\d{4})-(\d{4})$/);
  if (rangeMatch) return range(Number(rangeMatch[1]), Number(rangeMatch[2]));

  const years = text
    .split(",")
    .map(v => Number(v.trim()))
    .filter(Number.isInteger);

  if (years.length) return [...new Set(years)].sort((a, b) => a - b);

  return range(current, current + 5);
}

function parseAugustinoCalendar(html, year, month) {
  const $ = cheerio.load(html);
  const bodyText = normalizeText($("main").text() || $("body").text());
  const lines = bodyText
    .split("\n")
    .map(cleanLine)
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
    .map(block => buildCalendarDay(block, year, month));
}

function buildCalendarDay(block, year, month) {
  const date = `${year}-${pad(month)}-${pad(block.day)}`;
  const sourceUrl = `${AUGUSTINO_CALENDAR}?y=${year}&m=${pad(month)}`;

  const readingIndex = block.lines.findIndex(line => /^Bài đọc:/i.test(line));
  const readingLine = readingIndex >= 0 ? block.lines[readingIndex].replace(/^Bài đọc:\s*/i, "").trim() : "";
  const before = readingIndex >= 0 ? block.lines.slice(0, readingIndex) : block.lines;
  const notes = readingIndex >= 0 ? block.lines.slice(readingIndex + 1) : [];

  const celebrationLines = before
    .filter(line => !isInstruction(line))
    .filter(line => !/^MÙA\s+/i.test(line));

  const celebration = pickCelebration(block.title, celebrationLines);
  const rank = detectRank([celebration, block.title, ...celebrationLines].join(" "));
  const saintName = extractSaintName(celebrationLines.join(" ") || celebration);
  const season = detectSeason(block.title, celebrationLines.join(" "));
  const week = detectWeek(block.title);
  const yearCycle = detectYearCycle(year, month, block.day);
  const color = detectColor({ title: block.title, celebration, rank, season });
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
    reflection: { title: "", content: "" },
    notes: notes.filter(line => !isSiteNoise(line)),
    source: { calendar: sourceUrl, gospel: "" },
    updated: new Date().toISOString()
  };
}

async function fetchReadings(date) {
  const [year, month, day] = date.split("-").map(Number);

  const augustinoUrl = `${AUGUSTINO_READINGS}?d=${pad(day)}&m=${pad(month)}&y=${year}`;
  const augustino = await requestText(augustinoUrl)
    .then(html => parseReadings(html, augustinoUrl))
    .catch(() => null);

  if (augustino && hasAnyReading(augustino.readings)) return augustino;

  const vaticanUrl = `${VATICAN_READINGS}/${year}/${pad(month)}/${pad(day)}.html`;
  const vatican = await requestText(vaticanUrl)
    .then(html => parseReadings(html, vaticanUrl))
    .catch(() => null);

  if (vatican && hasAnyReading(vatican.readings)) return vatican;

  return null;
}

function parseReadings(html, source) {
  const $ = cheerio.load(html);
  const text = normalizeText($("main").text() || $("article").text() || $("body").text());
  const lines = text
    .split("\n")
    .map(cleanLine)
    .filter(Boolean)
    .filter(line => !isSiteNoise(line))
    .filter(line => !isCopyrightLine(line));

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
    const label = removeAccents(section.label).toLowerCase();
    const content = section.paragraphs.join("\n").trim();

    if (/bai doc/.test(label) && !readings.reading1.text) {
      readings.reading1 = { reference: section.reference, text: content };
    } else if (/dap ca|thanh vinh/.test(label)) {
      readings.psalm = { reference: section.reference, response: content };
    } else if (/tung ho/.test(label)) {
      readings.gospel_acclamation = content;
    } else if (/tin mung|phuc am/.test(label)) {
      readings.gospel = { reference: section.reference, text: content };
    } else if (/suy niem|chia se/.test(label)) {
      reflection.title = section.label;
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
    { re: /^(tin mung|phuc am)\s*[-–:]?\s*(.*)$/i, label: "Tin Mừng" },
    { re: /^suy niem\s*[-–:]?\s*(.*)$/i, label: "Suy niệm" }
  ];

  for (const item of patterns) {
    const match = normalized.match(item.re);
    if (match) {
      const reference = value.replace(/^(Bài đọc\s*(I|II|1|2)?|Đáp ca|Tung hô Tin Mừng|Tin Mừng|Phúc Âm|Suy Niệm)\s*[-–:]?\s*/i, "").trim();
      return { label: item.label, reference };
    }
  }

  return null;
}

function splitReadingReferences(line) {
  const value = String(line || "").replace(/\s+/g, " ").trim();
  const gospel = value.match(/\b(Mt|Mc|Lc|Ga)\s+\d[\d,.\-–;ab\s]*/i);
  if (!gospel) return { reading1: value, gospel: "" };
  return {
    reading1: value.slice(0, gospel.index).trim(),
    gospel: gospel[0].trim()
  };
}

function pickCelebration(title, lines) {
  const ranked = lines.find(line => /lễ\s+(trọng|kính|nhớ)|Chúa|Đức Mẹ|Thánh/i.test(line));
  if (ranked) return ranked;
  return title || "";
}

function extractSaintName(value = "") {
  const match = String(value).match(/((?:Thánh|Thánh Nữ|Các Thánh|Đức Mẹ|Chúa)\s+[^.,;]+)/i);
  return match ? cleanLine(match[1]) : "";
}

function detectRank(value = "") {
  const text = removeAccents(value).toLowerCase();
  if (/le trong/.test(text)) return "Lễ trọng";
  if (/le kinh/.test(text)) return "Lễ kính";
  if (/le nho/.test(text)) return "Lễ nhớ";
  if (/nho tu do/.test(text)) return "Lễ nhớ tự do";
  if (/chua nhat/.test(text)) return "Chúa nhật";
  return "Lễ thường";
}

function detectColor({ title = "", celebration = "", rank = "", season = "" }) {
  const text = removeAccents(`${title} ${celebration} ${rank} ${season}`).toLowerCase();

  if (/tu dao|thuong kho|chua thanh than|tong do|le la|phero|phaolo|banaba/.test(text)) return "Đỏ";
  if (/mua chay|mua vong/.test(text) && !/le trong|le kinh|duc me|thanh|chua giang sinh|truyen tin/.test(text)) return "Tím";
  if (/chua nhat iii mua vong|chua nhat iv mua chay/.test(text)) return "Hồng";
  if (/thanh|duc me|chua|le trong|le kinh|giang sinh|phuc sinh|truyen tin|thanh tam|trai tim/.test(text)) return "Trắng";
  return "Xanh";
}

function detectSeason(title = "", lines = "") {
  const text = `${title} ${lines}`;
  if (/Mùa Vọng/i.test(text)) return "Mùa Vọng";
  if (/Mùa Chay/i.test(text)) return "Mùa Chay";
  if (/Phục Sinh|Bát Nhật Phục Sinh/i.test(text)) return "Mùa Phục Sinh";
  if (/Giáng Sinh|Bát Nhật Giáng Sinh/i.test(text)) return "Mùa Giáng Sinh";
  if (/Thường Niên/i.test(text)) return "Mùa Thường Niên";
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
    reading1: {
      reference: extra.reading1?.reference || base.reading1?.reference || "",
      text: extra.reading1?.text || base.reading1?.text || ""
    },
    psalm: {
      reference: extra.psalm?.reference || base.psalm?.reference || "",
      response: extra.psalm?.response || base.psalm?.response || ""
    },
    gospel_acclamation: extra.gospel_acclamation || base.gospel_acclamation || "",
    gospel: {
      reference: extra.gospel?.reference || base.gospel?.reference || "",
      text: extra.gospel?.text || base.gospel?.text || ""
    }
  };
}

function hasAnyReading(readings = {}) {
  return Boolean(readings.reading1?.text || readings.psalm?.response || readings.gospel_acclamation || readings.gospel?.text);
}

async function requestText(url, tries = 3) {
  let error;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await axios.get(url, {
        responseType: "text",
        timeout: 25000,
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
      error = err;
      await sleep(500 * (i + 1));
    }
  }
  throw error;
}

async function writeJson(filename, data) {
  await fs.writeFile(path.join(OUT_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

function normalizeText(value = "") {
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function cleanLine(line = "") {
  return String(line).replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

function isSiteNoise(line = "") {
  return /Augustinô ©|Tôi tin để hiểu|Liên hệ:|Phi lợi nhuận|Vô vị lợi|Giới thiệu|Kinh Thánh|Giáo Huấn|Phụng Vụ|Cầu Nguyện|Công Cụ|Thomism|Tìm kiếm|Menu|Facebook|Instagram|Youtube|Podcast|Cookie|Bản văn Kinh Thánh|ktcgkpv\.org|Gửi đi|In trang này/i.test(line);
}

function isCopyrightLine(line = "") {
  return /Bản văn Kinh Thánh|Nhóm Phiên Dịch Các Giờ Kinh Phụng Vụ|ktcgkpv\.org|Gửi đi|In$/i.test(line);
}

function isInstruction(line = "") {
  return /Không cử hành|Hướng dẫn|Cấm cử hành|Đọc Kinh|Hôm nay lần hạt|Ngày thế giới|Cha xứ|Quyên góp|thánh lễ cầu|luật giữ chay|MÙA\s+/i.test(line);
}

function looksLikeReference(line = "") {
  return /\b(St|Xh|Lv|Ds|Đnl|Gs|Tl|R|1 Sm|2 Sm|1 V|2 V|Is|Gr|Ed|Đn|Hs|Ge|Am|Mk|Xp|Dcr|Ml|Cv|Rm|1 Cr|2 Cr|Gl|Ep|Pl|Cl|1 Tx|2 Tx|1 Tm|2 Tm|Tt|Dt|Hr|Gc|1 Pr|2 Pr|1 Ga|2 Ga|3 Ga|Gđ|Kh|Mt|Mc|Lc|Ga)\s+\d/i.test(line);
}

function canonicalWeekday(value = "") {
  const text = removeAccents(value).toLowerCase();
  if (text.includes("chua nhat")) return "Chúa Nhật";
  if (text.includes("thu hai")) return "Thứ Hai";
  if (text.includes("thu ba")) return "Thứ Ba";
  if (text.includes("thu tu")) return "Thứ Tư";
  if (text.includes("thu nam")) return "Thứ Năm";
  if (text.includes("thu sau")) return "Thứ Sáu";
  if (text.includes("thu bay")) return "Thứ Bảy";
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
  const offset = day === 0 ? -6 : 1 - day;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() + offset);

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

function range(start, end) {
  const out = [];
  for (let y = start; y <= end; y++) out.push(y);
  return out;
}

function truthy(value = "") {
  return /^(1|true|yes|y)$/i.test(String(value));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
