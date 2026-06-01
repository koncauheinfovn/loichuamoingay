import axios from "axios";
import fs from "fs/promises";
import path from "path";

const OUT_DIR = path.resolve("data");
const API = process.env.WORKER_API || "https://loichuamoingay.gioankminhcssr.workers.dev";
const YEARS = years(process.env.DATA_YEARS || "auto");

await fs.mkdir(OUT_DIR, { recursive: true });

for (const year of YEARS) {
  const all = [];
  for (let month = 1; month <= 12; month++) {
    const url = `${API.replace(/\/+$/, "")}/api/month?y=${year}&m=${month}`;
    console.log(`[month] ${year}-${pad(month)}`);
    const data = await getJson(url);
    const days = data.days || [];
    all.push(...days);
    await writeJson(`month-${year}-${pad(month)}.json`, {
      success: true,
      year,
      month,
      month_key: `${year}-${pad(month)}`,
      count: days.length,
      source: data.source || {},
      updated: new Date().toISOString(),
      days
    });
  }
  const unique = [...new Map(all.map(d => [d.date, d])).values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeJson(`year-${year}.json`, { success: true, year, count: unique.length, updated: new Date().toISOString(), days: unique });
}

await writeJson("years.json", { success: true, years: YEARS, updated: new Date().toISOString() });
console.log(`[done] ${YEARS.join(", ")}`);

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await axios.get(url, { timeout: 30000, headers: { Accept: "application/json" } });
      return res.data;
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw last;
}

async function writeJson(name, data) {
  await fs.writeFile(path.join(OUT_DIR, name), JSON.stringify(data, null, 2), "utf8");
}

function years(v) {
  const current = new Date().getFullYear();
  const text = String(v || "auto").trim().toLowerCase();
  if (text === "auto") return range(current, current + 5);
  if (text === "current") return [current];
  const plus = text.match(/^current\+(\d+)$/);
  if (plus) return range(current, current + Number(plus[1]));
  const rg = text.match(/^(\d{4})-(\d{4})$/);
  if (rg) return range(Number(rg[1]), Number(rg[2]));
  const list = text.split(",").map(x => Number(x.trim())).filter(Number.isInteger);
  return list.length ? [...new Set(list)].sort((a, b) => a - b) : range(current, current + 5);
}
function range(a, b) { const out = []; for (let y = a; y <= b; y++) out.push(y); return out; }
function pad(n) { return String(n).padStart(2, "0"); }
