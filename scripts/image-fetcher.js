import fetch from "node-fetch";

const UA = process.env.USER_AGENT || "Mozilla/5.0 loichuamoingay-dynamic/3.0";
const cache = new Map();

export async function fetchSaintImage(name) {
  const query = normalizeQuery(name);
  if (!query) return { name: "", image: "", wiki: "" };
  if (cache.has(query)) return cache.get(query);

  const result =
    (await wiki("vi", query)) ||
    (await wiki("en", query)) ||
    (await commons(query)) ||
    { name: query, image: "", wiki: "" };

  cache.set(query, result);
  return result;
}

function normalizeQuery(value = "") {
  return String(value)
    .replace(/\blễ\s+(trọng|kính|nhớ|nhớ tự do|buộc)\b/gi, "")
    .replace(/\bquan thầy.*$/gi, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function wiki(lang, query) {
  const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "1",
    prop: "pageimages|info",
    piprop: "original|thumbnail",
    pithumbsize: "1200",
    inprop: "url",
    format: "json",
    origin: "*"
  });

  const data = await fetchJson(url).catch(() => null);
  const pages = data?.query?.pages;
  if (!pages) return null;

  for (const page of Object.values(pages)) {
    const image = page?.original?.source || page?.thumbnail?.source || "";
    const wikiUrl = page?.fullurl || "";
    if (https(image) || https(wikiUrl)) {
      return {
        name: page?.title || query,
        image: https(image) ? image : "",
        wiki: https(wikiUrl) ? wikiUrl : ""
      };
    }
  }

  return null;
}

async function commons(query) {
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

  const data = await fetchJson(url).catch(() => null);
  const pages = data?.query?.pages;
  if (!pages) return null;

  for (const page of Object.values(pages)) {
    const image = page?.imageinfo?.[0]?.url || "";
    if (https(image)) return { name: page?.title || query, image, wiki: "" };
  }

  return null;
}

async function fetchJson(url, tries = 3) {
  let error;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      error = err;
      await sleep(350 * (i + 1));
    }
  }
  throw error;
}

function https(url = "") {
  return /^https:\/\//i.test(String(url));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
