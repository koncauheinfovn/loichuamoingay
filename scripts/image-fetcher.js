import axios from 'axios';
import * as cheerio from 'cheerio';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { DATA_DIR, ensureDir, normalizeSpaces, readJsonSafe, requestJson, requestText, stripDiacritics, writeJsonFile } from './crawler.js';

const IMAGE_CACHE_FILE = path.join(DATA_DIR, 'image-cache.json');
const USER_AGENT = process.env.USER_AGENT || 'CatholicDailyDataBot/1.0 image-fetcher axios cheerio node-fetch';
const MIN_IMAGE_WIDTH = Number(process.env.MIN_IMAGE_WIDTH || 240);

function cleanSaintQuery(name = '') {
  return normalizeSpaces(String(name)
    .replace(/^(Thánh|Thánh nữ|Thánh nam|Ðức|Đức)\s+/i, '')
    .replace(/\s+(giám mục|linh mục|tử đạo|trinh nữ|tông đồ|giáo hoàng|viện phụ|tiến sĩ Hội Thánh).*$/i, '')
    .replace(/[()]/g, ' '));
}

function scoreCandidate(candidate) {
  const width = Number(candidate.width || 0);
  const height = Number(candidate.height || 0);
  const pixels = width * height;
  const priorityScore = (10 - candidate.priority) * 100000000;
  return priorityScore + pixels;
}

async function readCache() {
  await ensureDir(DATA_DIR);
  return await readJsonSafe(IMAGE_CACHE_FILE, {});
}

async function writeCache(cache) {
  await writeJsonFile(IMAGE_CACHE_FILE, cache);
}

function getPageFromWikipediaPayload(payload) {
  const pages = payload?.query?.pages || {};
  return Object.values(pages).find(page => page && page.pageid && page.pageid > 0) || null;
}

async function validateImageUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return false;
    const type = response.headers.get('content-type') || '';
    return type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url);
  } catch {
    return /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url);
  }
}

async function searchWikipediaTitle(query, lang = 'vi') {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`;
  const data = await requestJson(url, { headers: { 'user-agent': USER_AGENT } });
  const hits = data?.query?.search || [];
  const saintHit = hits.find(hit => /thánh|saint|catholic|giáo hoàng|tông đồ/i.test(`${hit.title} ${hit.snippet || ''}`)) || hits[0];
  return saintHit?.title || '';
}

async function fetchWikipediaImage(name) {
  const query = cleanSaintQuery(name);
  const candidates = [];
  for (const lang of ['vi', 'en']) {
    const title = await searchWikipediaTitle(`${query} thánh Công giáo`, lang).catch(() => '');
    if (!title) continue;
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages|info&piprop=original|thumbnail&pithumbsize=1600&inprop=url&format=json&origin=*`;
    const data = await requestJson(url, { headers: { 'user-agent': USER_AGENT } }).catch(() => null);
    const page = getPageFromWikipediaPayload(data);
    const imageUrl = page?.original?.source || page?.thumbnail?.source || '';
    if (!imageUrl) continue;
    candidates.push({
      provider: `wikipedia-${lang}`,
      url: imageUrl,
      wiki: page?.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      width: page?.original?.width || page?.thumbnail?.width || 0,
      height: page?.original?.height || page?.thumbnail?.height || 0,
      title: page?.title || title,
      priority: lang === 'vi' ? 1 : 2
    });
  }
  return candidates;
}

async function fetchCommonsImage(name) {
  const query = cleanSaintQuery(name);
  const searches = [`${query} saint`, `${query} Catholic saint`, `${query}`];
  const candidates = [];
  for (const search of searches) {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(search)}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=2000&format=json&origin=*`;
    const data = await requestJson(url, { headers: { 'user-agent': USER_AGENT } }).catch(() => null);
    const pages = Object.values(data?.query?.pages || {});
    for (const page of pages) {
      const info = page?.imageinfo?.[0];
      if (!info?.url && !info?.thumburl) continue;
      const mime = info.mime || '';
      if (mime && !mime.startsWith('image/')) continue;
      const title = page.title || '';
      if (/\.svg$/i.test(title) && candidates.length > 0) continue;
      candidates.push({
        provider: 'wikimedia-commons',
        url: info.thumburl || info.url,
        wiki: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        width: info.thumbwidth || info.width || 0,
        height: info.thumbheight || info.height || 0,
        title,
        priority: 3
      });
    }
    if (candidates.length) break;
  }
  return candidates;
}

async function fetchImageFromSearchPage(url, provider, priority) {
  const html = await requestText(url, { headers: { 'user-agent': USER_AGENT }, retries: 2, timeoutMs: 15000 }).catch(() => '');
  if (!html) return [];
  const $ = cheerio.load(html);
  const candidates = [];
  const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || '';
  if (ogImage) {
    candidates.push({ provider, url: new URL(ogImage, url).href, wiki: url, width: 0, height: 0, title: provider, priority });
  }
  $('img').each((_, element) => {
    const src = $(element).attr('src') || $(element).attr('data-src') || '';
    const alt = $(element).attr('alt') || '';
    if (!src || /logo|sprite|blank|icon/i.test(src)) return;
    candidates.push({
      provider,
      url: new URL(src, url).href,
      wiki: url,
      width: Number($(element).attr('width') || 0),
      height: Number($(element).attr('height') || 0),
      title: alt || provider,
      priority
    });
  });
  return candidates;
}

async function fetchVaticanNewsImage(name) {
  const query = cleanSaintQuery(name);
  const url = `https://www.vaticannews.va/vi/search.html?searchPhrase=${encodeURIComponent(query)}`;
  return await fetchImageFromSearchPage(url, 'vatican-news', 4);
}

async function fetchCatholicSaintsImage(name) {
  const query = cleanSaintQuery(name);
  const urls = [
    `https://www.catholic.org/search/?q=${encodeURIComponent(query)}`,
    `https://www.catholic.org/saints/saint.php?saint_id=${encodeURIComponent(query)}`
  ];
  const output = [];
  for (const url of urls) {
    const items = await fetchImageFromSearchPage(url, 'catholic-saints', 5).catch(() => []);
    output.push(...items);
    if (output.length) break;
  }
  return output;
}

function normalizeCandidate(candidate) {
  if (!candidate?.url) return null;
  const url = String(candidate.url).replace(/^http:/i, 'https:');
  if (!/^https:\/\//i.test(url)) return null;
  return {
    provider: candidate.provider || '',
    url,
    image: url,
    wiki: candidate.wiki || '',
    title: normalizeSpaces(candidate.title || ''),
    width: Number(candidate.width || 0),
    height: Number(candidate.height || 0),
    priority: Number(candidate.priority || 99)
  };
}

export async function fetchSaintImage(name) {
  const saintName = normalizeSpaces(name);
  if (!saintName) return { name: '', image: '', wiki: '', provider: '', cached: false };

  const cache = await readCache();
  const key = stripDiacritics(saintName);
  const cached = cache[key];
  if (cached?.image && process.env.BYPASS_IMAGE_CACHE !== 'true') {
    return { ...cached, cached: true };
  }

  const groups = [];
  groups.push(await fetchWikipediaImage(saintName).catch(() => []));
  groups.push(await fetchCommonsImage(saintName).catch(() => []));
  groups.push(await fetchVaticanNewsImage(saintName).catch(() => []));
  groups.push(await fetchCatholicSaintsImage(saintName).catch(() => []));

  const candidates = groups.flat()
    .map(normalizeCandidate)
    .filter(Boolean)
    .filter(candidate => !candidate.width || candidate.width >= MIN_IMAGE_WIDTH)
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));

  let best = null;
  for (const candidate of candidates) {
    if (await validateImageUrl(candidate.url)) {
      best = candidate;
      break;
    }
  }

  const payload = best ? {
    name: saintName,
    image: best.url,
    wiki: best.wiki,
    provider: best.provider,
    width: best.width,
    height: best.height,
    updated: new Date().toISOString()
  } : {
    name: saintName,
    image: '',
    wiki: '',
    provider: '',
    width: 0,
    height: 0,
    updated: new Date().toISOString()
  };

  cache[key] = payload;
  await writeCache(cache);
  return { ...payload, cached: false };
}

export default fetchSaintImage;
