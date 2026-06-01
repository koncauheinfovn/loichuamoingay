import path from 'path';
import { promises as fs } from 'fs';
import {
  crawlDailyReadings,
  crawlLiturgyYear,
  DATA_DIR,
  emptyReadings,
  getTodayInTimeZone,
  mergeCalendarAndReadings,
  parseDateString,
  readJsonSafe,
  toDateString,
  writeJsonFile
} from './crawler.js';
import { fetchSaintImage } from './image-fetcher.js';

const TIME_ZONE = process.env.TZ_NAME || 'Asia/Ho_Chi_Minh';
const TODAY = getTodayInTimeZone(TIME_ZONE);
const CURRENT_YEAR = Number(TODAY.slice(0, 4));
const DATA_YEARS_INPUT = String(process.env.DATA_YEARS || process.env.DATA_YEAR || '2026-2030').trim();
const AUTO_YEAR_START = Number(process.env.GCATHOLIC_YEAR_START || CURRENT_YEAR - 1);
const AUTO_YEAR_END = Number(process.env.GCATHOLIC_YEAR_END || CURRENT_YEAR + 2);
const SCOPE = process.env.CRAWL_SCOPE || 'auto';
const FULL_BACKFILL = process.env.FULL_BACKFILL === 'true' || process.env.FULL_YEAR === 'true';
const FORCE_REFRESH = process.env.FORCE_REFRESH === 'true';
const FETCH_IMAGES = process.env.FETCH_IMAGES !== 'false';
const CONCURRENCY = Math.max(1, Number(process.env.CRAWL_CONCURRENCY || 2));
const MAX_YEARS = Math.max(1, Number(process.env.MAX_YEARS || 20));

function addDays(dateStr, days) {
  const date = parseDateString(dateStr);
  date.setDate(date.getDate() + days);
  return toDateString(date);
}

function compareDate(a, b) {
  return a.localeCompare(b);
}

function eachDate(startDate, endDate) {
  const output = [];
  let cursor = parseDateString(startDate);
  const end = parseDateString(endDate);
  while (cursor <= end) {
    output.push(toDateString(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return output;
}

function datesForYear(year) {
  return eachDate(`${year}-01-01`, `${year}-12-31`);
}

function getMonthRange(dateStr) {
  const date = parseDateString(dateStr);
  const year = date.getFullYear();
  const month = date.getMonth();
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  return { start: toDateString(start), end: toDateString(end) };
}

function getWeekRange(dateStr) {
  const date = parseDateString(dateStr);
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setDate(date.getDate() + diffToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: toDateString(start), end: toDateString(end) };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareDate);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function hasReadingContent(record) {
  return Boolean(record?.readings?.gospel?.text || record?.readings?.reading1?.text || record?.reflection?.content);
}

function defaultRecord(dateStr, calendarRecord) {
  return mergeCalendarAndReadings(calendarRecord, {
    liturgyTitle: '',
    liturgyRank: '',
    readings: emptyReadings(),
    reflection: { title: '', content: '' },
    sourceUrl: ''
  }, dateStr);
}

function existingMapFromYear(payload) {
  if (Array.isArray(payload)) return new Map(payload.map(item => [item.date, item]));
  if (Array.isArray(payload?.items)) return new Map(payload.items.map(item => [item.date, item]));
  return new Map();
}

function parseYearsInput(input) {
  const cleaned = String(input || '').trim().toLowerCase();
  if (!cleaned || cleaned === 'auto' || cleaned === 'all') return null;

  const range = cleaned.match(/^(\d{4})\s*[-:]\s*(\d{4})$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }

  return uniqueSorted(cleaned.split(',').map(v => Number(v.trim())).filter(y => Number.isInteger(y) && y >= 1900 && y <= 2200)).map(Number);
}

function hasUsableCalendar(calendarMap) {
  if (!calendarMap || !calendarMap.size) return false;
  let usable = 0;
  for (const item of calendarMap.values()) {
    if (!item.calendar_warning && (item.liturgy?.celebration || item.liturgy?.season)) usable += 1;
    if (usable >= 8) return true;
  }
  return false;
}

async function discoverCalendarYears() {
  const start = Math.min(AUTO_YEAR_START, AUTO_YEAR_END);
  const end = Math.max(AUTO_YEAR_START, AUTO_YEAR_END);
  const candidates = Array.from({ length: end - start + 1 }, (_, index) => start + index).slice(0, MAX_YEARS);
  const result = [];

  console.log(`[years] auto discover from ${start} to ${end}`);
  for (const year of candidates) {
    try {
      const calendarMap = await crawlLiturgyYear(year);
      if (hasUsableCalendar(calendarMap)) {
        result.push({ year, calendarMap });
        console.log(`[years] ${year}: available`);
      } else {
        console.warn(`[years] ${year}: no usable calendar`);
      }
    } catch (error) {
      console.warn(`[years] ${year}: ${error.message}`);
    }
  }

  if (!result.length) {
    console.warn(`[years] không tìm thấy năm hợp lệ; fallback current year ${CURRENT_YEAR}`);
    const calendarMap = await crawlLiturgyYear(CURRENT_YEAR);
    result.push({ year: CURRENT_YEAR, calendarMap });
  }

  return result;
}

async function loadCalendarYears() {
  const fixedYears = parseYearsInput(DATA_YEARS_INPUT);
  if (!fixedYears) return discoverCalendarYears();

  const output = [];
  for (const year of fixedYears.slice(0, MAX_YEARS)) {
    console.log(`[calendar] crawling ${year}`);
    const calendarMap = await crawlLiturgyYear(year);
    output.push({ year, calendarMap });
  }
  return output;
}

function targetDatesForYear(year, existingMap) {
  const allDates = datesForYear(year);
  const month = getMonthRange(TODAY);
  const week = getWeekRange(TODAY);
  const currentYearOnly = Number(TODAY.slice(0, 4)) === year;

  if (FULL_BACKFILL) return allDates;
  if (SCOPE === 'today') return currentYearOnly ? [TODAY] : [];
  if (SCOPE === 'week') return currentYearOnly ? eachDate(week.start, week.end).filter(date => date.startsWith(String(year))) : [];
  if (SCOPE === 'month') return currentYearOnly ? eachDate(month.start, month.end).filter(date => date.startsWith(String(year))) : [];

  const incremental = currentYearOnly
    ? [
        TODAY,
        ...eachDate(week.start, week.end),
        ...eachDate(month.start, month.end),
        ...eachDate(addDays(TODAY, -3), addDays(TODAY, 45))
      ].filter(date => date.startsWith(String(year)))
    : [];

  const datesWithExistingReadings = allDates.filter(date => existingMap.has(date) && hasReadingContent(existingMap.get(date)));
  return uniqueSorted([...incremental, ...datesWithExistingReadings]);
}

async function buildDailyRecord(dateStr, calendarMap, existingMap) {
  const calendarRecord = calendarMap.get(dateStr) || null;
  const existing = existingMap.get(dateStr) || null;
  let readingRecord = null;

  if (existing && hasReadingContent(existing) && !FORCE_REFRESH) {
    const merged = defaultRecord(dateStr, calendarRecord);
    merged.readings = existing.readings || emptyReadings();
    merged.reflection = existing.reflection || { title: '', content: '' };
    merged.source.gospel = existing.source?.gospel || merged.source.gospel;
    merged.updated = existing.updated || new Date().toISOString();
    readingRecord = { sourceUrl: merged.source.gospel, readings: merged.readings, reflection: merged.reflection };
  }

  if (!readingRecord) {
    try {
      readingRecord = await crawlDailyReadings(dateStr);
    } catch (error) {
      console.error(`[readings] ${dateStr}: ${error.message}`);
      readingRecord = {
        liturgyTitle: '',
        liturgyRank: '',
        readings: existing?.readings || emptyReadings(),
        reflection: existing?.reflection || { title: '', content: '' },
        sourceUrl: existing?.source?.gospel || '',
        unavailable: true
      };
    }
  }

  const record = mergeCalendarAndReadings(calendarRecord, readingRecord, dateStr);

  if (existing?.readings && hasReadingContent(existing) && !hasReadingContent(record)) {
    record.readings = existing.readings;
    record.reflection = existing.reflection || record.reflection;
    record.source.gospel = existing.source?.gospel || record.source.gospel;
  }

  const existingSaint = existing?.liturgy?.saint || {};
  if (existingSaint.image && !FORCE_REFRESH) {
    record.liturgy.saint = {
      name: record.liturgy.saint?.name || existingSaint.name || '',
      image: existingSaint.image,
      wiki: existingSaint.wiki || ''
    };
  } else if (FETCH_IMAGES && record.liturgy.saint?.name) {
    try {
      const image = await fetchSaintImage(record.liturgy.saint.name);
      record.liturgy.saint = {
        name: record.liturgy.saint.name,
        image: image.image || '',
        wiki: image.wiki || ''
      };
    } catch (error) {
      console.error(`[image] ${dateStr} ${record.liturgy.saint.name}: ${error.message}`);
      record.liturgy.saint = {
        name: record.liturgy.saint.name,
        image: existingSaint.image || '',
        wiki: existingSaint.wiki || ''
      };
    }
  }

  record.updated = new Date().toISOString();
  return record;
}

async function buildYearFile(year, calendarMap) {
  const yearFile = path.join(DATA_DIR, `year-${year}.json`);
  const existingPayload = await readJsonSafe(yearFile, []);
  const existingMap = existingMapFromYear(existingPayload);
  const targetDates = targetDatesForYear(year, existingMap);

  console.log(`[daily] year=${year} target dates=${targetDates.length} | fullBackfill=${FULL_BACKFILL} | scope=${SCOPE}`);
  const generated = await mapLimit(targetDates, CONCURRENCY, async dateStr => {
    console.log(`[daily] ${dateStr}`);
    return await buildDailyRecord(dateStr, calendarMap, existingMap);
  });

  const generatedMap = new Map(generated.map(item => [item.date, item]));
  const fullYear = datesForYear(year).map(dateStr => {
    if (generatedMap.has(dateStr)) return generatedMap.get(dateStr);
    if (existingMap.has(dateStr)) {
      const existing = existingMap.get(dateStr);
      const merged = defaultRecord(dateStr, calendarMap.get(dateStr) || null);
      return {
        ...merged,
        readings: existing.readings || merged.readings,
        reflection: existing.reflection || merged.reflection,
        source: {
          calendar: merged.source.calendar || existing.source?.calendar || '',
          gospel: existing.source?.gospel || merged.source.gospel || ''
        },
        liturgy: {
          ...merged.liturgy,
          saint: existing.liturgy?.saint?.image ? existing.liturgy.saint : merged.liturgy.saint
        },
        updated: existing.updated || merged.updated
      };
    }
    return defaultRecord(dateStr, calendarMap.get(dateStr) || null);
  });

  await writeJsonFile(yearFile, fullYear);
  console.log(`[done] data/year-${year}.json`);
  return fullYear;
}

function findRecord(allRecords, dateStr) {
  return allRecords.find(item => item.date === dateStr) || null;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const yearInputs = await loadCalendarYears();
  const allYears = [];
  const allRecords = [];

  for (const { year, calendarMap } of yearInputs.sort((a, b) => a.year - b.year)) {
    const items = await buildYearFile(year, calendarMap);
    allYears.push({
      year,
      file: `year-${year}.json`,
      days: items.length,
      calendar_source: items[0]?.source?.calendar || '',
      readings_filled: items.filter(hasReadingContent).length,
      updated: new Date().toISOString()
    });
    allRecords.push(...items);
  }

  const monthRange = getMonthRange(TODAY);
  const weekRange = getWeekRange(TODAY);
  const todayRecord = findRecord(allRecords, TODAY) || defaultRecord(TODAY, null);
  const weekRecords = allRecords.filter(item => item.date >= weekRange.start && item.date <= weekRange.end).sort((a, b) => a.date.localeCompare(b.date));
  const monthRecords = allRecords.filter(item => item.date >= monthRange.start && item.date <= monthRange.end).sort((a, b) => a.date.localeCompare(b.date));

  await writeJsonFile(path.join(DATA_DIR, 'today.json'), todayRecord);
  await writeJsonFile(path.join(DATA_DIR, 'week.json'), weekRecords);
  await writeJsonFile(path.join(DATA_DIR, 'month.json'), monthRecords);
  await writeJsonFile(path.join(DATA_DIR, 'years.json'), {
    years: allYears,
    today: TODAY,
    time_zone: TIME_ZONE,
    mode: DATA_YEARS_INPUT,
    full_backfill: FULL_BACKFILL,
    source: {
      calendar: 'https://gcatholic.org/calendar/{year}/VN-H-vi',
      gospel: 'https://www.vaticannews.va/vi/loi-chua-hang-ngay/{year}/{month}/{day}.html'
    },
    updated: new Date().toISOString()
  });

  console.log('[done] data/today.json');
  console.log('[done] data/week.json');
  console.log('[done] data/month.json');
  console.log('[done] data/years.json');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
