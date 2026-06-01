import axios from 'axios';
import * as cheerio from 'cheerio';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const CACHE_DIR = path.join(ROOT_DIR, '.cache');
export const HTML_CACHE_DIR = path.join(CACHE_DIR, 'html');

const USER_AGENT = process.env.USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const SOURCES = Object.freeze({
  calendarBase: process.env.GCATHOLIC_CALENDAR_BASE || 'https://gcatholic.org/calendar',
  vaticanDailyBase: process.env.VATICAN_DAILY_BASE || 'https://www.vaticannews.va/vi/loi-chua-hang-ngay'
});

const MONTHS_VI = new Map([
  ['Tháng Giêng', 1],
  ['Tháng Một', 1],
  ['Tháng Hai', 2],
  ['Tháng Ba', 3],
  ['Tháng Tư', 4],
  ['Tháng Năm', 5],
  ['Tháng Sáu', 6],
  ['Tháng Bảy', 7],
  ['Tháng Tám', 8],
  ['Tháng Chín', 9],
  ['Tháng Mười', 10],
  ['Tháng Mười Một', 11],
  ['Tháng Mười Hai', 12]
]);

const FOOTER_MARKERS = [
  '##### Thêm các sự kiện sắp tới',
  'Thêm các sự kiện sắp tới',
  'Hoạt động của ĐGH',
  'Đức tin chúng ta',
  'Thông tin hữu ích',
  'Các mạng khác',
  'Copyright ©'
];

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function normalizeSpaces(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .trim();
}

export function normalizeTextBlock(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripDiacritics(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function toDateString(date) {
  if (typeof date === 'string') return date.slice(0, 10);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseDateString(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new Error(`Sai định dạng ngày: ${dateStr}`);
  const [, yyyy, mm, dd] = match;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

export function getTodayInTimeZone(timeZone = 'Asia/Ho_Chi_Minh') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date()).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonFile(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

function cacheKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

export async function requestText(url, options = {}) {
  const retries = Number(options.retries ?? process.env.REQUEST_RETRIES ?? 3);
  const timeoutMs = Number(options.timeoutMs ?? process.env.REQUEST_TIMEOUT_MS ?? 20000);
  const headers = {
    'user-agent': USER_AGENT,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'vi,en;q=0.8',
    ...(options.headers || {})
  };

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.get(url, {
        responseType: 'text',
        timeout: timeoutMs,
        headers,
        validateStatus: status => status >= 200 && status < 500
      });
      if (response.status === 404) return '';
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
      return String(response.data || '');
    } catch (axiosError) {
      lastError = axiosError;
      try {
        const { controller, timer } = withTimeout(timeoutMs);
        const response = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timer);
        if (response.status === 404) return '';
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (fetchError) {
        lastError = fetchError;
      }
      await sleep(Math.min(750 * attempt, 4000));
    }
  }
  throw new Error(`Không thể tải ${url}: ${lastError?.message || lastError}`);
}

export async function requestJson(url, options = {}) {
  const retries = Number(options.retries ?? process.env.REQUEST_RETRIES ?? 3);
  const timeoutMs = Number(options.timeoutMs ?? process.env.REQUEST_TIMEOUT_MS ?? 20000);
  const headers = {
    'user-agent': USER_AGENT,
    'accept': 'application/json,text/plain,*/*',
    'accept-language': 'vi,en;q=0.8',
    ...(options.headers || {})
  };

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const { controller, timer } = withTimeout(timeoutMs);
      const response = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (fetchError) {
      lastError = fetchError;
      try {
        const response = await axios.get(url, {
          responseType: 'json',
          timeout: timeoutMs,
          headers,
          validateStatus: status => status >= 200 && status < 500
        });
        if (response.status === 404) return null;
        if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
        return response.data;
      } catch (axiosError) {
        lastError = axiosError;
      }
      await sleep(Math.min(750 * attempt, 4000));
    }
  }
  throw new Error(`Không thể tải JSON ${url}: ${lastError?.message || lastError}`);
}

export async function getCachedText(url, ttlMs = Number(process.env.HTML_CACHE_TTL_MS || 21600000)) {
  await ensureDir(HTML_CACHE_DIR);
  const filePath = path.join(HTML_CACHE_DIR, `${cacheKey(url)}.html`);
  try {
    const stat = await fs.stat(filePath);
    const age = Date.now() - stat.mtimeMs;
    if (age < ttlMs && process.env.BYPASS_HTML_CACHE !== 'true') {
      return await fs.readFile(filePath, 'utf8');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const html = await requestText(url);
  if (html) await fs.writeFile(filePath, html, 'utf8');
  return html;
}

function linesFromHtml(html, selector = 'body') {
  const $ = cheerio.load(html || '');
  $('script,style,noscript,svg,iframe').remove();
  const target = $(selector).length ? $(selector) : $('body');
  const inner = cheerio.load(`<root>${target.html() || $.root().html() || ''}</root>`, { decodeEntities: true });
  inner('br,p,div,section,article,header,footer,h1,h2,h3,h4,h5,h6,li,tr,td,th').append('\n');
  return inner.root().text()
    .split('\n')
    .map(normalizeSpaces)
    .filter(Boolean);
}

function findLineIndex(lines, patterns, start = 0) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (let index = start; index < lines.length; index += 1) {
    const normalized = stripDiacritics(lines[index]);
    if (list.some(pattern => {
      if (pattern instanceof RegExp) return pattern.test(lines[index]) || pattern.test(normalized);
      return normalized.includes(stripDiacritics(pattern));
    })) {
      return index;
    }
  }
  return -1;
}

function nextSectionIndex(lines, start, markers) {
  const found = markers
    .map(marker => findLineIndex(lines, marker, start))
    .filter(index => index >= 0);
  return found.length ? Math.min(...found) : lines.length;
}

function splitHeaderReference(line, labelRegex) {
  const cleaned = normalizeSpaces(line.replace(labelRegex, ''));
  return cleaned.replace(/^[:\-–—]+\s*/, '').trim();
}

function extractBibleReference(line) {
  const cleaned = normalizeSpaces(line);
  const match = cleaned.match(/(?:^|\s)((?:[1-3]\s*)?[A-ZÀ-ỸĐ][A-Za-zÀ-ỹĐđ.\-]{0,14}\s*\d{1,3}[,.:]\s*\d[\d.,\-–;\sabcvx]*)$/u);
  return normalizeSpaces(match?.[1] || '');
}

function textBetween(lines, start, end) {
  if (start < 0 || end <= start) return '';
  return normalizeTextBlock(lines.slice(start, end).join('\n'));
}

function firstNonEmpty(lines, start = 0) {
  for (let index = start; index < lines.length; index += 1) {
    if (normalizeSpaces(lines[index])) return { index, value: normalizeSpaces(lines[index]) };
  }
  return { index: -1, value: '' };
}

function parsePsalmResponse(lines) {
  const responseIndex = lines.findIndex(line => /^Đ\./i.test(line));
  if (responseIndex < 0) return '';
  const output = [];
  for (let index = responseIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > responseIndex && (/^\^\{?\d+\}?/u.test(line) || /^Bài đọc|^Tung hô|^Tin Mừng/i.test(line))) break;
    output.push(line);
    if (output.length >= 4) break;
  }
  return normalizeTextBlock(output.join('\n'));
}

function parseReflection(lines, startIndex) {
  const reflectionIndex = findLineIndex(lines, [/suy\s*niệm/i, /gợi\s*ý\s*suy/i, /bài\s*giảng/i], startIndex);
  if (reflectionIndex < 0) return { title: '', content: '' };
  const end = nextSectionIndex(lines, reflectionIndex + 1, FOOTER_MARKERS);
  return {
    title: normalizeSpaces(lines[reflectionIndex]),
    content: textBetween(lines, reflectionIndex + 1, end)
  };
}

function parseVaticanReadings(html, dateStr, sourceUrl) {
  const lines = linesFromHtml(html);
  const startMarker = findLineIndex(lines, ['Bài đọc ngày hôm nay']);
  const start = startMarker >= 0 ? startMarker : Math.max(findLineIndex(lines, ['Lời Chúa Hằng Ngày']), 0);
  const footer = nextSectionIndex(lines, start + 1, FOOTER_MARKERS);
  const scopedLines = lines.slice(start + 1, footer);

  const first = firstNonEmpty(scopedLines, 0);
  const title = first.value && !/^chọn ngày/i.test(first.value) ? first.value : '';
  const titleIndexOffset = first.index >= 0 ? first.index + 1 : 0;
  let rank = '';
  const possibleRank = scopedLines[titleIndexOffset] || '';
  if (/^lễ\s+(trọng|kính|nhớ)/i.test(possibleRank)) rank = normalizeSpaces(possibleRank);

  const reading1Index = findLineIndex(scopedLines, [/^Bài\s*đọc\s*(1|I)\b/i]);
  const psalmIndex = findLineIndex(scopedLines, [/^Đáp\s*ca\b/i]);
  const reading2Index = findLineIndex(scopedLines, [/^Bài\s*đọc\s*(2|II)\b/i]);
  const acclamationIndex = findLineIndex(scopedLines, ['Tung hô Tin Mừng']);
  const gospelHeaderIndex = findLineIndex(scopedLines, ['Tin Mừng ngày hôm nay']);
  const gospelFallbackIndex = gospelHeaderIndex >= 0 ? gospelHeaderIndex : findLineIndex(scopedLines, [/^Tin\s*Mừng\b/i], acclamationIndex >= 0 ? acclamationIndex + 1 : 0);

  const reading1End = [psalmIndex, reading2Index, acclamationIndex, gospelFallbackIndex]
    .filter(index => index > reading1Index)
    .sort((a, b) => a - b)[0] ?? scopedLines.length;

  const psalmEnd = [reading2Index, acclamationIndex, gospelFallbackIndex]
    .filter(index => index > psalmIndex)
    .sort((a, b) => a - b)[0] ?? scopedLines.length;

  const acclamationEnd = gospelFallbackIndex > acclamationIndex ? gospelFallbackIndex : scopedLines.length;

  let gospelReference = '';
  let gospelTextStart = gospelFallbackIndex + 1;
  let gospelTitle = '';
  if (gospelFallbackIndex >= 0) {
    for (let index = gospelFallbackIndex + 1; index < Math.min(scopedLines.length, gospelFallbackIndex + 8); index += 1) {
      const line = scopedLines[index];
      const reference = extractBibleReference(line);
      if (reference && /(Mt|Mc|Lc|Ga|Gio-an|Mát-thêu|Mác-cô|Lu-ca)/i.test(line)) {
        gospelReference = reference;
        gospelTextStart = index + 1;
        break;
      }
      if (!gospelTitle && line && !/^✠/u.test(line)) gospelTitle = line;
    }
  }

  const reflection = parseReflection(scopedLines, gospelTextStart);
  const gospelEnd = reflection.title
    ? findLineIndex(scopedLines, reflection.title, gospelTextStart)
    : nextSectionIndex(scopedLines, gospelTextStart, FOOTER_MARKERS);

  const psalmLines = psalmIndex >= 0 ? scopedLines.slice(psalmIndex + 1, psalmEnd) : [];

  return {
    liturgyTitle: title,
    liturgyRank: rank,
    readings: {
      reading1: {
        reference: reading1Index >= 0 ? splitHeaderReference(scopedLines[reading1Index], /^Bài\s*đọc\s*(1|I)\s*/i) : '',
        text: reading1Index >= 0 ? textBetween(scopedLines, reading1Index + 1, reading1End) : ''
      },
      psalm: {
        reference: psalmIndex >= 0 ? splitHeaderReference(scopedLines[psalmIndex], /^Đáp\s*ca\s*/i) : '',
        response: parsePsalmResponse(psalmLines)
      },
      gospel_acclamation: acclamationIndex >= 0 ? textBetween(scopedLines, acclamationIndex, acclamationEnd) : '',
      gospel: {
        reference: gospelReference,
        text: gospelFallbackIndex >= 0 ? normalizeTextBlock([gospelTitle, textBetween(scopedLines, gospelTextStart, gospelEnd)].filter(Boolean).join('\n\n')) : ''
      }
    },
    reflection,
    sourceUrl
  };
}

export function buildVaticanDailyUrl(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${SOURCES.vaticanDailyBase}/${year}/${month}/${day}.html`;
}

export async function crawlDailyReadings(dateStr) {
  const sourceUrl = buildVaticanDailyUrl(dateStr);
  let html = await getCachedText(sourceUrl, Number(process.env.VATICAN_CACHE_TTL_MS || 86400000));
  if (!html && dateStr === getTodayInTimeZone()) {
    html = await getCachedText(`${SOURCES.vaticanDailyBase}.html`, Number(process.env.VATICAN_CACHE_TTL_MS || 3600000));
  }
  if (!html) {
    return {
      liturgyTitle: '',
      liturgyRank: '',
      readings: emptyReadings(),
      reflection: { title: '', content: '' },
      sourceUrl,
      unavailable: true
    };
  }
  return parseVaticanReadings(html, dateStr, sourceUrl);
}

export function emptyReadings() {
  return {
    reading1: { reference: '', text: '' },
    psalm: { reference: '', response: '' },
    gospel_acclamation: '',
    gospel: { reference: '', text: '' }
  };
}

function rankFromMarker(marker = '', celebration = '', weekday = '') {
  const mark = normalizeSpaces(marker).toUpperCase();
  if (mark === 'T') return 'Lễ trọng';
  if (mark === 'K') return 'Lễ kính';
  if (mark === 'N') return 'Lễ nhớ';
  const normalized = stripDiacritics(celebration);
  if (normalized.includes('le trong')) return 'Lễ trọng';
  if (normalized.includes('le kinh')) return 'Lễ kính';
  if (normalized.includes('le nho')) return 'Lễ nhớ';
  if (weekday === 'Chủ Nhật' || normalized.includes('chu nhat')) return 'Chúa Nhật';
  return 'Ngày thường';
}

function isMonthLine(line) {
  return MONTHS_VI.has(line);
}

function parseMonth(line) {
  return MONTHS_VI.get(line) || null;
}

function isSeasonLine(line) {
  return /^(Mùa\s+|Tam nhật Thánh)/i.test(line);
}

function parseDayLine(line) {
  const cleaned = normalizeSpaces(line);
  const match = cleaned.match(/^(\d{1,2})\s+(Chủ Nhật|Thứ Hai|Thứ Ba|Thứ Tư|Thứ Năm|Thứ Sáu|Thứ Bảy)(?:\s+([A-ZĐ]+\*?))?$/u);
  if (match) return { day: Number(match[1]), weekday: match[2], marker: match[3] || '' };

  // Fallback cho trường hợp HTML bị nén làm mất khoảng trắng: 1Thứ NămT
  const compact = cleaned.replace(/\s+/g, '');
  const compactMatch = compact.match(/^(\d{1,2})(ChủNhật|ThứHai|ThứBa|ThứTư|ThứNăm|ThứSáu|ThứBảy)([A-ZĐ]+\*?)?$/u);
  if (!compactMatch) return null;
  const weekdayMap = {
    'ChủNhật': 'Chủ Nhật',
    'ThứHai': 'Thứ Hai',
    'ThứBa': 'Thứ Ba',
    'ThứTư': 'Thứ Tư',
    'ThứNăm': 'Thứ Năm',
    'ThứSáu': 'Thứ Sáu',
    'ThứBảy': 'Thứ Bảy'
  };
  return { day: Number(compactMatch[1]), weekday: weekdayMap[compactMatch[2]], marker: compactMatch[3] || '' };
}

function isRomanWeek(line) {
  return /^(I|II|III|IV)$/i.test(normalizeSpaces(line));
}

function isOptionalMarker(line) {
  return /^n\*?$/i.test(normalizeSpaces(line));
}

function inferSundayCycle(dateStr) {
  const date = parseDateString(dateStr);
  const year = date.getFullYear();
  const adventStart = getFirstAdventSunday(year);
  const liturgicalYear = date >= adventStart ? year + 1 : year;
  const cycles = ['A', 'B', 'C'];
  return cycles[((liturgicalYear - 2023) % 3 + 3) % 3];
}

function getFirstAdventSunday(year) {
  const christmas = new Date(year, 11, 25);
  const weekday = christmas.getDay();
  const sundayBeforeChristmas = new Date(christmas);
  sundayBeforeChristmas.setDate(christmas.getDate() - weekday);
  const firstAdvent = new Date(sundayBeforeChristmas);
  firstAdvent.setDate(sundayBeforeChristmas.getDate() - 21);
  return firstAdvent;
}

function inferWeekdayCycle(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  return year % 2 === 0 ? 'II' : 'I';
}

export function inferYearCycle(dateStr) {
  return `${inferSundayCycle(dateStr)} / ${inferWeekdayCycle(dateStr)}`;
}

function extractWeek(celebration = '', season = '') {
  const text = normalizeSpaces(celebration);
  const direct = text.match(/(Tuần\s+[IVXLCDM]+|tuần\s+thứ\s+[^,.;]+)/iu);
  if (direct) return normalizeSpaces(direct[1].replace(/^tuần/i, 'Tuần'));
  const sunday = text.match(/Chúa Nhật\s+(?:thứ\s+)?([^,.;]+)\s+(Mùa\s+[^,.;]+)/iu);
  if (sunday) return normalizeSpaces(`Chúa Nhật ${sunday[1]} ${sunday[2]}`);
  if (/Tuần\s*Thánh/i.test(text)) return 'Tuần Thánh';
  if (/Bát Nhật/i.test(text)) return 'Tuần Bát Nhật';
  return season || '';
}

function inferColor(celebration = '', season = '', rank = '') {
  const text = stripDiacritics(`${celebration} ${season} ${rank}`);
  if (text.includes('thu sau tuan thanh') || text.includes('le la') || text.includes('chua thanh than') || text.includes('thanh gia')) return 'Đỏ';
  if (text.includes('tu dao') || text.includes('tong do') || text.includes('tac gia sach tin mung')) return 'Đỏ';
  if (text.includes('cau hon') || text.includes('cac dang linh hon')) return 'Tím';
  if (text.includes('mua vong')) {
    if (text.includes('chu nhat thu ba')) return 'Hồng';
    return 'Tím';
  }
  if (text.includes('mua chay')) {
    if (text.includes('chu nhat thu tu')) return 'Hồng';
    return 'Tím';
  }
  if (text.includes('mua quanh nam') || text.includes('mua thuong nien')) {
    if (/thanh|duc me|ma-ri-a|maria|le kinh|le nho/.test(text)) return 'Trắng';
    return 'Xanh lá';
  }
  if (text.includes('mua phuc sinh') || text.includes('mua giang sinh') || text.includes('chua giesu') || text.includes('chua giê-su')) return 'Trắng';
  if (/duc me|duc ma|maria|ma-ri-a|cac thanh|truyen tin|hien dung|thang thien|len troi|thanh tam|thanh the|thanh gia/.test(text)) return 'Trắng';
  if (/thanh/.test(text)) return 'Trắng';
  return '';
}

function extractSaintName(...values) {
  const text = normalizeSpaces(values.filter(Boolean).join(' | '));
  const parts = text.split('|').map(part => normalizeSpaces(part)).filter(Boolean);
  const candidate = parts.find(part => /(Thánh|Đức Mẹ|Đức Ma-ri-a|Ðức Mẹ|Ðức Ma-ri-a)/i.test(part)) || '';
  if (!candidate) return '';
  return normalizeSpaces(candidate
    .replace(/^n\*?\s*/i, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .split(/[,;:]/)[0]
    .replace(/\s+và\s+thánh\s+.*$/i, '')
    .replace(/\s+và\s+Thánh\s+.*$/i, ''));
}

function finalizeCalendarEntry(entry, calendarUrl) {
  if (!entry) return null;
  const celebration = entry.liturgy.celebration || `${entry.weekday} ${entry.liturgy.season}`.trim();
  const optionalCelebrations = entry._optionalCelebrations || [];
  const rank = rankFromMarker(entry._marker, celebration, entry.weekday);
  const saintName = extractSaintName(celebration, ...optionalCelebrations);
  const color = inferColor(celebration, entry.liturgy.season, rank);

  return {
    date: entry.date,
    weekday: entry.weekday,
    liturgy: {
      season: entry.liturgy.season || '',
      week: extractWeek(celebration, entry.liturgy.season),
      year_cycle: inferYearCycle(entry.date),
      celebration,
      rank,
      color,
      saint: {
        name: saintName,
        image: '',
        wiki: ''
      }
    },
    source: {
      calendar: calendarUrl,
      gospel: ''
    }
  };
}


function weekdayViFromDateString(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('vi-VN', {
    weekday: 'long',
    timeZone: 'Asia/Ho_Chi_Minh'
  }).format(new Date(Date.UTC(year, month - 1, day, 12))).replace(/^./, ch => ch.toUpperCase());
}

function buildFallbackCalendarYear(year, calendarUrl, reason = '') {
  const entries = new Map();
  const cursor = new Date(Date.UTC(year, 0, 1, 12));
  const end = new Date(Date.UTC(year, 11, 31, 12));
  while (cursor <= end) {
    const date = `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`;
    const weekday = weekdayViFromDateString(date);
    entries.set(date, {
      date,
      weekday,
      liturgy: {
        season: '',
        week: '',
        year_cycle: inferYearCycle(date),
        celebration: '',
        rank: weekday === 'Chủ Nhật' ? 'Chúa Nhật' : 'Ngày thường',
        color: '',
        saint: { name: '', image: '', wiki: '' }
      },
      source: {
        calendar: calendarUrl,
        gospel: ''
      },
      calendar_warning: reason || 'Không đọc được cấu trúc GCatholic; đã tạo khung ngày để tiếp tục lấy Lời Chúa từ Vatican News.'
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return entries;
}

export function buildCalendarUrl(year) {
  return `${SOURCES.calendarBase}/${year}/VN-H-vi`;
}

export async function crawlLiturgyYear(year = 2026) {
  const calendarUrl = buildCalendarUrl(year);
  const html = await getCachedText(calendarUrl, Number(process.env.GCATHOLIC_CACHE_TTL_MS || 86400000));
  const lines = linesFromHtml(html);
  const entries = new Map();
  let currentMonth = null;
  let currentSeason = '';
  let current = null;
  let pendingOptional = false;

  const firstMonthIndex = lines.findIndex(isMonthLine);
  const scopedLines = firstMonthIndex >= 0 ? lines.slice(firstMonthIndex) : lines;

  function flushCurrent() {
    const finalized = finalizeCalendarEntry(current, calendarUrl);
    if (finalized) entries.set(finalized.date, finalized);
    current = null;
    pendingOptional = false;
  }

  for (const rawLine of scopedLines) {
    const line = normalizeSpaces(rawLine);
    if (!line) continue;

    if (isMonthLine(line)) {
      flushCurrent();
      currentMonth = parseMonth(line);
      pendingOptional = false;
      continue;
    }

    if (isSeasonLine(line)) {
      flushCurrent();
      currentSeason = line;
      pendingOptional = false;
      continue;
    }

    const day = parseDayLine(line);
    if (day && currentMonth) {
      flushCurrent();
      const date = `${year}-${pad2(currentMonth)}-${pad2(day.day)}`;
      current = {
        date,
        weekday: day.weekday,
        _marker: day.marker,
        _optionalCelebrations: [],
        liturgy: {
          season: currentSeason,
          celebration: '',
          week: '',
          year_cycle: inferYearCycle(date),
          rank: '',
          color: '',
          saint: { name: '', image: '', wiki: '' }
        }
      };
      continue;
    }

    if (!current) continue;

    if (isRomanWeek(line)) {
      current.liturgy.psalter_week = line;
      pendingOptional = false;
      continue;
    }

    if (isOptionalMarker(line)) {
      pendingOptional = true;
      continue;
    }

    if (/^(iCal|Copy|EN|VI|Hôm nay:|Ascension|Import the calendar|Lịch Phụng Vụ)$/i.test(line)) continue;

    if (pendingOptional || current.liturgy.celebration) {
      current._optionalCelebrations.push(line);
      pendingOptional = false;
    } else {
      current.liturgy.celebration = line;
    }
  }
  flushCurrent();

  if (!entries.size) {
    const preview = normalizeSpaces(lines.slice(0, 20).join(' | ')).slice(0, 500);
    console.warn(`[calendar] Không phân tích được GCatholic HTML. Dùng fallback ngày trống để build tiếp. Preview: ${preview}`);
    return buildFallbackCalendarYear(year, calendarUrl, 'Không phân tích được lịch phụng vụ GCatholic. Có thể bị cache HTML lỗi, chống bot, hoặc HTML đã thay đổi.');
  }
  return entries;
}

export function extractLiturgyFromVaticanTitle(title = '', rank = '') {
  const output = { season: '', week: '', celebration: '', rank: normalizeSpaces(rank) };
  const cleaned = normalizeSpaces(title);
  if (!cleaned) return output;
  output.celebration = cleaned;
  const parts = cleaned.split(/\s+-\s+/);
  if (parts.length >= 2) {
    output.week = normalizeSpaces(parts[0]);
    output.season = normalizeSpaces(parts.slice(1).join(' - ')).replace('Mùa Thường Niên', 'Mùa Quanh Năm');
  } else {
    output.week = extractWeek(cleaned, '');
  }
  if (!output.rank && /^lễ\s+(trọng|kính|nhớ)/i.test(rank)) output.rank = normalizeSpaces(rank);
  return output;
}

export function mergeCalendarAndReadings(calendarRecord, readingRecord, dateStr) {
  const base = calendarRecord || {
    date: dateStr,
    weekday: new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'Asia/Ho_Chi_Minh' }).format(parseDateString(dateStr)),
    liturgy: {
      season: '',
      week: '',
      year_cycle: inferYearCycle(dateStr),
      celebration: '',
      rank: '',
      color: '',
      saint: { name: '', image: '', wiki: '' }
    },
    source: { calendar: '', gospel: '' }
  };

  const fromVatican = extractLiturgyFromVaticanTitle(readingRecord?.liturgyTitle, readingRecord?.liturgyRank);
  const celebration = base.liturgy.celebration || fromVatican.celebration;
  const rank = base.liturgy.rank || fromVatican.rank || rankFromMarker('', celebration, base.weekday);
  const season = base.liturgy.season || fromVatican.season;

  return {
    date: dateStr,
    weekday: base.weekday || '',
    liturgy: {
      season,
      week: base.liturgy.week || fromVatican.week || extractWeek(celebration, season),
      year_cycle: base.liturgy.year_cycle || inferYearCycle(dateStr),
      celebration,
      rank,
      color: base.liturgy.color || inferColor(celebration, season, rank),
      saint: base.liturgy.saint || { name: '', image: '', wiki: '' }
    },
    readings: readingRecord?.readings || emptyReadings(),
    reflection: readingRecord?.reflection || { title: '', content: '' },
    source: {
      calendar: base.source?.calendar || '',
      gospel: readingRecord?.sourceUrl || base.source?.gospel || ''
    },
    updated: new Date().toISOString()
  };
}
