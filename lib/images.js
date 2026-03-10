const fs = require("node:fs");
const path = require("node:path");

function detectMediaTypeByExt(p) {
  const ext = (path.extname(p) || "").toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function parseCursorImageFilesFromText(text) {
  if (typeof text !== "string") return [];
  const start = text.indexOf("<image_files>");
  const end = text.indexOf("</image_files>");
  if (start === -1 || end === -1 || end <= start) return [];

  const block = text.slice(start, end);
  // Match both Windows paths (C:\...) and Unix paths (/Users/..., /home/..., /tmp/...)
  const re = /(?:[A-Za-z]:\\|\/)[^\r\n]+?\.(png|jpg|jpeg|webp|gif)/gi;

  const out = [];
  let m;
  while ((m = re.exec(block)) !== null) out.push(m[0]);
  return [...new Set(out)];
}

function stripImageFilesBlock(text) {
  if (typeof text !== "string") return text;
  return text.replace(/<image_files>[\s\S]*?<\/image_files>/g, "").trim();
}

function fileToClaudeImageBlock(filePath) {
  const buf = fs.readFileSync(filePath);
  const media_type = detectMediaTypeByExt(filePath);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type,
      data: buf.toString("base64"),
    },
  };
}

function injectImagesFromCursorTextBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  const out = [];
  for (const b of blocks) {
    if (b?.type !== "text" || typeof b.text !== "string") {
      out.push(b);
      continue;
    }
    const paths = parseCursorImageFilesFromText(b.text);
    if (!paths.length) {
      out.push(b);
      continue;
    }

    const cleaned = stripImageFilesBlock(b.text);
    if (cleaned) out.push({ type: "text", text: cleaned });

    for (const p of paths) {
      try {
        out.push(fileToClaudeImageBlock(p));
      } catch {
        out.push({ type: "text", text: `[Không đọc được ảnh: ${p}]` });
      }
    }
  }
  return out;
}

module.exports = {
  detectMediaTypeByExt,
  parseCursorImageFilesFromText,
  stripImageFilesBlock,
  fileToClaudeImageBlock,
  injectImagesFromCursorTextBlocks,
};
