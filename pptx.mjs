import zlib from "node:zlib";

function unzipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP/PPTX 文件。");
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
    // Only slide XML is needed. Do not inflate embedded images/video just to
    // discard them: a normal 20+ MB deck would otherwise hit the entry limit.
    if (!/^ppt\/slides\/slide\d+\.xml$/i.test(name)) continue;
    if (uncompressedSize > 16 * 1024 * 1024) continue;
    total += uncompressedSize;
    if (total > 40 * 1024 * 1024) throw new Error("PPTX 文字内容过大。");
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
  const entries = unzipEntries(buffer);
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
