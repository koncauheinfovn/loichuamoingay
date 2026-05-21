const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=1800"
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const date = url.searchParams.get("date");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      return json({ ok: false, message: "Sai định dạng ngày. Dùng YYYY-MM-DD." }, 400);
    }

    const [year, month, day] = date.split("-");
    const vaticanUrl = `https://www.vaticannews.va/vi/loi-chua-hang-ngay/${year}/${month}/${day}.html`;

    try {
      const res = await fetch(vaticanUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "vi,en;q=0.8"
        }
      });

      if (!res.ok) {
        return json({
          ok: false,
          message: `Vatican News trả về HTTP ${res.status}.`,
          sourceUrl: vaticanUrl
        }, 502);
      }

      const textParts = [];

      await new HTMLRewriter()
        .on("body", {
          text(text) {
            if (text.text) textParts.push(text.text);
          }
        })
        .transform(res)
        .arrayBuffer();

      const fullText = cleanText(textParts.join("\n"));
      const parsed = parseVaticanReadings(fullText);

      if (!parsed.readings.length) {
        return json({
          ok: false,
          message: "Không tách được bài đọc từ Vatican News.",
          sourceUrl: vaticanUrl
        }, 422);
      }

      return json({
        ok: true,
        date,
        title: parsed.title || "Lời Chúa Hằng Ngày",
        readings: parsed.readings,
        source: "Vatican News Tiếng Việt",
        sourceUrl: vaticanUrl
      }, 200);
    } catch (err) {
      return json({
        ok: false,
        message: err && err.message ? err.message : "Không tải được Vatican News.",
        sourceUrl: vaticanUrl
      }, 500);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLine(value) {
  return cleanText(String(value || "")
    .replace(/^#+\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, ""));
}

function norm(value) {
  return cleanText(value)
    .replace(/Ð/g, "Đ")
    .replace(/ð/g, "đ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function linesOf(text) {
  return cleanText(text).split(/\n+/).map(cleanLine).filter(Boolean);
}

function labelOf(line) {
  const t = norm(line);

  if (/^bai doc ngay hom nay\b/.test(t)) return "";
  if (/^bai doc\s*(1|i)\b/.test(t)) return "Bài đọc I";
  if (/^dap ca\b/.test(t)) return "Đáp ca";
  if (/^bai doc\s*(2|ii)\b/.test(t)) return "Bài đọc II";
  if (/^tung ho tin mung\b/.test(t)) return "Tung hô Tin Mừng";
  if (/^tin mung ngay hom nay\b/.test(t) || /^tin mung\b/.test(t) || /^phuc am\b/.test(t)) return "Tin Mừng";

  return "";
}

function stopLine(line) {
  const t = norm(line);

  return (
    t.indexOf("gop y cai thien") > -1 ||
    t.indexOf("xin ho tro su mang") > -1 ||
    t.indexOf("ban van kinh thanh") > -1 ||
    t.indexOf("gui di") === 0 ||
    t === "in" ||
    t.indexOf("them cac su kien sap toi") > -1 ||
    t.indexOf("lich trinh cua dgh") > -1 ||
    t.indexOf("hoat dong cua dgh") > -1 ||
    t.indexOf("duc tin chung ta") > -1 ||
    t.indexOf("thong tin huu ich") > -1 ||
    t.indexOf("cac mang khac") > -1 ||
    t.indexOf("cac kenh khac") > -1 ||
    t.indexOf("copyright") > -1
  );
}

function stripRefFromHeader(line, label) {
  let text = cleanLine(line);

  if (label === "Bài đọc I") {
    return cleanText(text.replace(/^Bài\s*(?:đọc|Ðọc|Đọc)\s*(?:1|I)\s*/i, ""));
  }

  if (label === "Bài đọc II") {
    return cleanText(text.replace(/^Bài\s*(?:đọc|Ðọc|Đọc)\s*(?:2|II)\s*/i, ""));
  }

  if (label === "Đáp ca") {
    return cleanText(text.replace(/^Đáp\s*ca\s*/i, ""));
  }

  if (label === "Tung hô Tin Mừng") {
    return cleanText(text.replace(/^Tung\s*hô\s*Tin\s*Mừng\s*/i, ""));
  }

  if (label === "Tin Mừng") {
    return cleanText(text.replace(/^Tin\s*Mừng\s*(?:ngày\s*hôm\s*nay)?\s*/i, "").replace(/^Phúc\s*Âm\s*/i, ""));
  }

  return "";
}

function bibleRefFromLines(lines, label) {
  const joined = lines.slice(0, 6).join(" ");

  if (label === "Tin Mừng") {
    const gospel = joined.match(/(?:Mt|Mc|Lc|Ga|Gioan|Mát-thêu|Mác-cô|Lu-ca)\s*\d[\d,;\-\s.]+/i);
    if (gospel) return cleanText(gospel[0]);
  }

  const ref = joined.match(/(?:St|Xh|Lv|Ds|Đnl|Gs|Tl|R|1\s*Sm|2\s*Sm|1\s*V|2\s*V|1\s*Sb|2\s*Sb|Er|Nkm|Tb|Gđt|Et|G|Tv|Cn|Gv|Dc|Kn|Hc|Is|Gr|Ac|Br|Ed|Đn|Hs|Ge|Am|Ov|Gn|Mk|Nk|Kb|Xp|Kg|Dcr|Ml|Cv|Rm|1\s*Cr|2\s*Cr|Gl|Ep|Pl|Cl|1\s*Tx|2\s*Tx|1\s*Tm|2\s*Tm|Tt|Plm|Hr|Gc|1\s*Pr|2\s*Pr|1\s*Ga|2\s*Ga|3\s*Ga|Gđ|Kh)\s*\d[\d,;\-\s.]+/i);

  return ref ? cleanText(ref[0]) : "";
}

function extractMainBlock(text) {
  const source = cleanText(text);
  const lower = norm(source);
  const start = lower.indexOf("bai doc ngay hom nay");

  if (start < 0) {
    throw new Error("Không thấy mục Bài đọc ngày hôm nay.");
  }

  let end = source.length;
  const lowerSource = norm(source);

  [
    "GÓP Ý CẢI THIỆN",
    "Xin hỗ trợ sứ mạng",
    "Bản văn Kinh Thánh",
    "Thêm các sự kiện sắp tới",
    "Hoạt động của ĐGH",
    "Đức tin chúng ta",
    "Thông tin hữu ích",
    "Các mạng khác",
    "Các kênh khác",
    "Copyright"
  ].forEach(stop => {
    const p = lowerSource.indexOf(norm(stop), start + 1);
    if (p > -1 && p < end) end = p;
  });

  return source.slice(start, end);
}

function parseVaticanReadings(text) {
  const block = extractMainBlock(text);
  const lines = linesOf(block);
  const markers = [];
  let title = "";
  let afterHeading = false;

  lines.forEach((line, index) => {
    const n = norm(line);

    if (n.indexOf("bai doc ngay hom nay") > -1) {
      afterHeading = true;
      return;
    }

    if (afterHeading && !title && !labelOf(line) && !stopLine(line) && n.indexOf("chon ngay") !== 0) {
      title = line;
    }

    const label = labelOf(line);

    if (!label) return;
    if (label === "Tin Mừng" && norm(line).indexOf("tung ho tin mung") > -1) return;

    markers.push({ label, index, header: line });
  });

  const readings = [];

  markers.forEach((marker, i) => {
    const start = marker.index + 1;
    const end = i + 1 < markers.length ? markers[i + 1].index : lines.length;
    let sectionLines = lines.slice(start, end).filter(line => line && !stopLine(line));

    let ref = stripRefFromHeader(marker.header, marker.label);

    if (!ref && sectionLines.length && sectionLines[0].length < 140 && /\d/.test(sectionLines[0])) {
      ref = sectionLines.shift();
    }

    if (!ref) {
      ref = bibleRefFromLines(sectionLines, marker.label);
    }

    const body = cleanText(sectionLines.join("\n"));

    if (body.length < 10) return;

    readings.push({
      label: marker.label,
      ref,
      text: body
    });
  });

  return { title, readings };
}
