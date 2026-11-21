import zlib from "node:zlib";

function unzipEntries(buffer, wanted) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 Office ZIP 文件。");
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;
    // Only the requested XML is needed. Never inflate embedded images/video.
    if (wanted && !wanted(name)) continue;
    if (uncompressedSize > 16 * 1024 * 1024) continue;
    total += uncompressedSize;
    if (total > 40 * 1024 * 1024) throw new Error("Office 文字内容过大。");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else continue;
    entries.set(name, data);
  }
  return entries;
}

function xmlText(xml) {
  const decode = (s) => s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const paragraphs = [];
  const pRe = /<a:p\b[\s\S]*?<\/a:p>/g;
  let m;
  while ((m = pRe.exec(xml)) !== null) {
    const parts = [];
    const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
    let t;
    while ((t = tRe.exec(m[0])) !== null) parts.push(decode(t[1]));
    const line = parts.join("").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs.join("\n");
}

export function extractPptxText(buffer) {
  const entries = unzipEntries(buffer, (name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name));
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!slides.length) throw new Error("PPTX 中没有找到幻灯片。");
  const chunks = [];
  let chars = 0;
  for (let i = 0; i < slides.length; i++) {
    const xml = entries.get(slides[i]).toString("utf8");
    const text = xmlText(xml);
    const block = text || "（这一页只有图片/图表，没有可提取文字）";
    const heading = `## 第 ${i + 1} 页\n${block}`;
    chunks.push(heading);
    chars += heading.length;
    if (chars > 1_200_000) {
      chunks.push("…（PPT 文字过多，已截断）");
      break;
    }
  }
  return { text: chunks.join("\n\n"), slides: slides.length };
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function extractDocxText(buffer) {
  const entries = unzipEntries(buffer, (name) =>
    name === "word/document.xml" || /^word\/(?:header|footer)\d*\.xml$/i.test(name));
  const main = entries.get("word/document.xml");
  if (!main) throw new Error("DOCX 中没有找到正文。");
  const paragraphs = [];
  const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let pm;
  while ((pm = pRe.exec(main.toString("utf8"))) !== null) {
    let inner = pm[0].replace(/<w:tab\b[^>]*\/>/g, "\t").replace(/<w:br\b[^>]*\/>/g, "\n");
    const parts = [];
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tm;
    while ((tm = tRe.exec(inner)) !== null) parts.push(decodeXmlEntities(tm[1]));
    const line = parts.join("").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
    if (line) paragraphs.push(line);
  }
  if (!paragraphs.length) throw new Error("DOCX 中没有可提取文字。");
  const text = paragraphs.join("\n");
  return { text: text.slice(0, 1_200_000), paragraphs: paragraphs.length };
}

function sharedStrings(entries) {
  const xml = entries.get("xl/sharedStrings.xml");
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[\s\S]*?<\/si>/g;
  let sm;
  while ((sm = siRe.exec(xml.toString("utf8"))) !== null) {
    const parts = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(sm[0])) !== null) parts.push(decodeXmlEntities(tm[1]));
    out.push(parts.join(""));
  }
  return out;
}

export function extractXlsxText(buffer) {
  const entries = unzipEntries(buffer, (name) =>
    name === "xl/sharedStrings.xml" || name === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!sheets.length) throw new Error("XLSX 中没有找到工作表。");
  const strings = sharedStrings(entries);
  const wb = entries.get("xl/workbook.xml");
  const names = [];
  if (wb) {
    const sRe = /<sheet\b[^>]*\bname="([^"]*)"/g;
    let m;
    while ((m = sRe.exec(wb.toString("utf8"))) !== null) names.push(decodeXmlEntities(m[1]));
  }
  const chunks = [];
  let totalRows = 0;
  let chars = 0;
  for (let si = 0; si < sheets.length; si++) {
    const xml = entries.get(sheets[si]).toString("utf8");
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      const cells = [];
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRe.exec(rm[1])) !== null) {
        const attrs = cm[1] || "";
        const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "";
        const v = (cm[2].match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/) || [])[1] || "";
        let value = "";
        if (t === "s") value = strings[Number(v)] || "";
        else if (t === "inlineStr") value = [...cm[2].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decodeXmlEntities(x[1])).join("");
        else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else value = decodeXmlEntities(v);
        cells.push(String(value).replace(/[\r\n\t]+/g, " ").trim());
      }
      const line = cells.join("\t").trim();
      if (line) rows.push(line);
      totalRows++;
      if (rows.length > 5000) break;
    }
    const heading = `## ${names[si] || ("工作表 " + (si + 1))}`;
    const block = rows.length ? heading + "\n" + rows.join("\n") : heading + "\n（空表）";
    chunks.push(block);
    chars += block.length;
    if (chars > 1_200_000) {
      chunks.push("…（表格内容过多，已截断）");
      break;
    }
  }
  return { text: chunks.join("\n\n"), sheets: sheets.length, rows: totalRows };
}
