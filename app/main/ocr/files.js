'use strict';
const fs = require('node:fs');
const path = require('node:path');

const EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const MAX_FILES = 5000;
const MAX_BYTES = 80 * 1024 * 1024;

const supported = (name) => EXT.has(path.extname(name).toLowerCase());

// Every sheet file under a folder (sub-folders too), sorted, with the name of the folder it sits in:
// sheets are often kept one folder per press line ("Line 7"), which the import offers as the line.
function listFolder(dir) {
  const out = [];
  let truncated = false;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || !supported(e.name)) continue;
      if (out.length >= MAX_FILES) { truncated = true; return; }
      out.push({ path: p, name: e.name, rel: path.relative(dir, p), folder: path.basename(d), size: fs.statSync(p).size });
    }
  };
  walk(dir);
  return { dir, files: out, truncated };
}
function describe(p) {
  const st = fs.statSync(p);
  return { path: p, name: path.basename(p), rel: path.basename(p), folder: path.basename(path.dirname(p)), size: st.size };
}
// "Line 7", "line7", "L7", "7", "Press 7" -> 7; anything else -> null
function lineFromFolder(name) {
  const m = /^(?:press\s*|line\s*|l\s*)?(\d{1,2})$/i.exec(String(name || '').trim().replace(/[_-]+/g, ' '));
  return m ? Number(m[1]) : null;
}
function readFile(p) {
  const st = fs.statSync(p);
  if (!supported(p)) throw new Error(`${path.basename(p)} is not a PDF or an image`);
  if (st.size > MAX_BYTES) throw new Error(`${path.basename(p)} is larger than ${MAX_BYTES / 1048576} MB`);
  return fs.readFileSync(p);
}

// PNG, JPEG, BMP or WebP by their first bytes (the OCR library only reads these; a mislabelled file fails clearly instead of oddly)
function isImage(b) {
  if (!b || b.length < 12) return false;
  return (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x42 && b[1] === 0x4d)
    || (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');
}

module.exports = { isImage, listFolder, describe, lineFromFolder, readFile, supported, EXT };
