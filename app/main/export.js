'use strict';
// CSV and a dependency-free XLSX writer (zip "deflate" + minimal SpreadsheetML).
const zlib = require('node:zlib');

const NUM = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  // UTF-8 BOM so Excel opens °F / µF correctly.
  return '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
function colName(i) {
  let s = ''; i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

// sheets: [{ name, headers, rows, widths?, validations?, freeze?, hidden?, wrap?, numericFrom? }]
//   validations: [{ col, list: ['a','b'] } | { col, range: 'Lists!$A$2:$A$20' }]  (applied to rows 2..1000)
//   freeze: { x, y } columns/rows kept in view;  wrap: columns whose text wraps;  numericFrom: columns >= this index
//   (and column 0) are written as numbers when the text is numeric; otherwise only real JS numbers are numeric.
function toXlsxBook(sheets) {
  const cell = (sheet, v, r, c) => {
    const ref = `${colName(c)}${r + 1}`;
    if (v === null || v === undefined || v === '') return r === 0 ? `<c r="${ref}" s="2" t="inlineStr"><is><t></t></is></c>` : '';
    const header = r === 0;
    const numeric = typeof v === 'number' || (!header && sheet.numericFrom !== undefined && (c === 0 || c >= sheet.numericFrom) && typeof v === 'string' && NUM.test(v));
    if (numeric) return `<c r="${ref}"><v>${Number(v)}</v></c>`;
    const style = header ? ' s="2"' : (sheet.wrap && sheet.wrap.includes(c) ? ' s="3"' : (sheet.muted && sheet.muted.includes(c) ? ' s="4"' : ''));
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const sheetXml = (sh) => {
    const all = [sh.headers, ...sh.rows];
    const body = all.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell(sh, v, i, c)).join('')}</row>`).join('');
    const widths = (sh.widths || sh.headers.map((h) => Math.min(40, Math.max(10, String(h).length + 2))))
      .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"${sh.textCols ? ' style="5"' : ''}/>`).join('');
    const fr = sh.freeze === undefined ? { x: 2, y: 1 } : sh.freeze;
    const pane = fr ? `<pane${fr.x ? ` xSplit="${fr.x}"` : ''}${fr.y ? ` ySplit="${fr.y}"` : ''} topLeftCell="${colName(fr.x || 0)}${(fr.y || 0) + 1}" activePane="${fr.x && fr.y ? 'bottomRight' : fr.y ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : '';
    const dv = (sh.validations || []).map((v) => {
      const col = colName(v.col);
      const f = v.list ? `"${v.list.map(xmlEsc).join(',')}"` : xmlEsc(v.range);
      return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="${v.warn ? 'warning' : 'stop'}" errorTitle="Pick from the list" error="${v.warn ? 'That is not in the list. Keep it to create a new one.' : 'Choose one of the listed values.'}" sqref="${col}2:${col}1000"><formula1>${f}</formula1></dataValidation>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><cols>${widths}</cols><sheetData>${body}</sheetData>${dv ? `<dataValidations count="${sh.validations.length}">${dv}</dataValidations>` : ''}</worksheet>`;
  };
  const n = sheets.length;
  const ids = sheets.map((_, i) => i + 1);
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${ids.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${xmlEsc(sh.name).slice(0, 31)}" sheetId="${i + 1}"${sh.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="11"/><color rgb="FF777777"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E3DA"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4F2EC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((sh, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh)]),
  ];
  return zip(files);
}

// The data export: one sheet, first two columns frozen, numeric text in the value columns written as numbers.
function toXlsx(headers, rows, sheetName = 'Setup Tracker') {
  return toXlsxBook([{ name: sheetName, headers, rows, numericFrom: headers.indexOf('Changed Fields') + 1 }]);
}

// ---------- reading ----------
function unzip(buf) {
  const out = new Map();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not an Excel (.xlsx) file');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged Excel file');
    const method = buf.readUInt16LE(p + 10); const csz = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28); const el = buf.readUInt16LE(p + 30); const cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26); const lel = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csz);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, zlib.inflateRawSync(data));
    p += 46 + nl + el + cl;
  }
  return out;
}
const xmlUnesc = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
});
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlUnesc(m[1])).join('');
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref);
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
// Returns [{ name, rows: [[string, ...], ...] }] for every sheet. Empty cells are ''. Numbers come back as text.
function readXlsx(buf) {
  const files = unzip(buf);
  const get = (name) => { const b = files.get(name); return b ? b.toString('utf8') : null; };
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('Not an Excel (.xlsx) file');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1]; const t = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    return [id, t];
  }));
  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlUnesc(/\bname="([^"]*)"/.exec(m[0])?.[1] || '');
    const rid = /\br:id="([^"]*)"/.exec(m[0])?.[1];
    let t = target.get(rid);
    if (!t) continue;
    t = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
    const xml = get(t);
    if (xml === null) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rnum = /\br="(\d+)"/.exec(rm[0])?.[1];
      const row = [];
      for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]; const inner = cm[2] || '';
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
        let v = '';
        if (type === 's') { const idx = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]; v = shared[parseInt(idx, 10)] ?? ''; }
        else if (type === 'inlineStr') v = textOf(inner);
        else if (type === 'b') v = /<v>1<\/v>/.test(inner) ? 'TRUE' : 'FALSE';
        else if (type === 'e') v = '';
        else { const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]; v = raw === undefined ? '' : xmlUnesc(raw); if (type === 'str') v = v; }
        const ci = ref ? colIndex(ref) : row.length;
        while (row.length < ci) row.push('');
        row[ci] = v;
      }
      const ri = rnum ? parseInt(rnum, 10) - 1 : rows.length;
      while (rows.length < ri) rows.push([]);
      rows[ri] = row;
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

module.exports = { toCsv, toXlsx, toXlsxBook, readXlsx, zip, crc32 };
