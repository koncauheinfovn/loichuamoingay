import fetch from "node-fetch";

const UA = process.env.USER_AGENT || "Mozilla/5.0 loichuamoingay-bot/2.0";
const imageCache = new Map();

export async function fetchSaintImage(name) {
  const query = cleanQuery(name);
  if (!query) return { name: "", image: "", wiki: "" };
  if (imageCache.has(query)) return imageCache.get(query);

  const result =
    (await fromWikipedia("vi", query)) ||
    (await fromWikipedia("en", query)) ||
    (await fromCommons(query)) ||
    { name: query, image: "", wiki: "" };

  imageCache.set(query, result);
  return result;
}

function cleanQuery(value = "") {
  return String(value)
    .replace(/\blễ\s+(trọng|kính|nhớ|nhớ tự do)\b/gi, "")
    .replace(/\bquan thầy.*$/gi, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fromWikipedia(lang, query) {
  const api = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
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

  const data = await fetchJson(api).catch(() => null);
  const pages = data?.query?.pages;
  if (!pages) return null;

  for (const page of Object.values(pages)) {
    const image = page?.original?.source || page?.thumbnail?.source || "";
    const wiki = page?.fullurl || "";
    if (isHttps(image) || wiki) {
      return {
        name: page?.title || query,
        image: isHttps(image) ? image : "",
        wiki: isHttps(wiki) ? wiki : ""
      };
    }
  }
  return null;
}

async function fromCommons(query) {
  const api = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
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

  const data = await fetchJson(api).catch(() => null);
  const pages = data?.query?.pages;
  if (!pages) return null;

  for (const page of Object.values(pages)) {
    const image = page?.imageinfo?.[0]?.url || "";
    if (isHttps(image)) {
      return {
        name: page?.title || query,
        image,
        wiki: ""
      };
    }
  }
  return null;
}

async function fetchJson(url, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      await sleep(350 * (i + 1));
    }
  }
  throw lastError;
}

function isHttps(url = "") {
  return /^https:\/\//i.test(String(url));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
