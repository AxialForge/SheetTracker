'use strict';
// Loading history from Excel: one row per sheet (entry), with the setpoint and actual of every field.
// A blank template is exported per form; the app's own Data export (.xlsx) can be re-imported too.
// Import shows a plan first, never edits or deletes stored entries, and backs up before it writes.
const C = require('../shared/compare');
const T = require('../shared/types');
const F = require('./fields');
const { toXlsxBook, readXlsx } = require('./export');

const FIXED = [
  ['line', ['line', 'press', 'press line', 'station', 'cell']],
  ['part', ['part no', 'part', 'part number', 'partno', 'part #', 'product', 'product no']],
  ['ts', ['date/time', 'date time', 'datetime', 'date', 'when', 'timestamp']],
  ['by', ['entered by', 'by', 'operator', 'entered']],
  ['rev', ['sheet rev', 'rev', 'revision', 'sheet revision']],
  ['revised', ['revised', 'revised date', 'revised by/date', 'sheet revised']],
  ['hmi', ['hmi file', 'hmi file #', 'hmi', 'hmi #']],
  ['reason', ['reason', 'change reason']],
  ['notes', ['notes', 'note', 'comments', 'comment']],
  ['source', ['source file', 'source', 'pdf', 'pdf file', 'file']],
  ['review', ['review', 'needs review', 'check', 'to check']],
];
const IGNORED = new Set(['changed fields', 'form', '#', 'no', 'row']);
const norm = (s) => C.norm(s);
const lc = (s) => norm(s).toLowerCase();
const key = (s) => lc(s).replace(/[^a-z0-9/#]+/g, ' ').trim();

// ---------- the blank template for a form ----------
// opts: { form: form number }. Columns: the sheet's header values, then setpoint / actual for each field on the form.
function buildHistoryTemplate(svc, { form } = {}) {
  const formNo = svc.ensureForm(form);
  const sections = svc.getSections();
  const order = new Map(sections.map((s, i) => [s.key, i]));
  const fields = svc.getFormFields(formNo).slice().sort((a, b) => (order.get(a.section) ?? 99) - (order.get(b.section) ?? 99) || a.sort - b.sort);
  const L = svc._labels();
  const lines = svc.getLineForms().filter((l) => l.form_no === formNo).map((l) => l.line);
  const fixedHeaders = [L.line, L.part, 'Date/Time', 'Entered by', 'Sheet rev', 'Revised', 'HMI file', 'Reason', 'Notes', 'Source file', 'Review'];
  const headers = [...fixedHeaders];
  const map = [];
  const validations = [];
  const list = (col, values) => { if (values.length && values.join(',').length <= 240) validations.push({ col, list: values }); };
  list(0, lines.map(String));
  list(7, F.REASONS);
  for (const f of fields) {
    const u = f.unit ? ` (${f.unit})` : '';
    const dd = f.kind === 'yesno' ? ['Yes', 'No'] : f.kind === 'choice' ? T.choicesOf(f)
      : f.kind === 'rating' ? Array.from({ length: Math.max(0, T.scaleOf(f) - (parseInt(f.min, 10) || 1) + 1) }, (_, i) => String((parseInt(f.min, 10) || 1) + i)) : [];
    if (f.has_sp) {
      list(headers.length, dd); headers.push(`${f.label}${u} - Setpoint`); map.push([headers[headers.length - 1], f.key, 'setpoint']);
      list(headers.length, dd); headers.push(`${f.label}${u} - Actual`); map.push([headers[headers.length - 1], f.key, 'actual']);
    } else {
      list(headers.length, dd); headers.push(`${f.label}${u}`); map.push([headers[headers.length - 1], f.key, 'actual']);
    }
  }
  const info = svc.getForms().find((x) => x.form_no === formNo);
  const readme = [
    [`Setup Tracker history template: form ${formNo}${info?.name ? ` (${info.name})` : ''}`],
    [''],
    ['One row per setup sheet. Fill what the sheet shows; leave the rest blank.'],
    [`${L.line}, ${L.part} and Date/Time are required. Date/Time like 2026-03-10 08:00 (a date alone is fine, but two sheets for the same part on one date then need different times).`],
    ['Setpoint = the printed value on the sheet. Actual = the value written in by hand. A row may have setpoints only (the part\'s first sheet) or both.'],
    ['Readings (heat #, part-to-part time …) have a single column.'],
    ['Source file: the PDF this row came from. It is kept in the entry\'s notes so any value can be traced back.'],
    ['Review: put a note here when a handwritten value was hard to read. It is kept in the notes as “NEEDS REVIEW”.'],
    ['Do not rename or delete the header cells in row 1 (the Columns sheet maps each one to a field). You may delete whole columns you do not need.'],
    ['Cells are formatted as text so Excel keeps values exactly as typed (6:05, 1:30, 0012).'],
    ['In Setup Tracker: Export → Import entries from Excel. You get a preview of every row, with problems listed, before anything is saved. Stored entries are never changed.'],
  ];
  return toXlsxBook([
    { name: 'Read me', headers: readme[0], rows: readme.slice(1), widths: [130], freeze: null, wrap: [0] },
    { name: 'Entries', headers, rows: [], freeze: { x: 3, y: 1 }, textCols: true, validations,
      widths: headers.map((h, i) => (i === 0 ? 8 : i === 1 ? 16 : i === 2 ? 17 : i === 8 ? 30 : i === 9 ? 26 : Math.min(30, Math.max(11, h.length * 0.9)))) },
    { name: 'Columns', headers: ['Header', 'Field key', 'Value'], rows: map, widths: [60, 24, 12], muted: [0, 1, 2] },
  ]);
}

// ---------- reading ----------
const pad = (n) => String(n).padStart(2, '0');
function serialToParts(n) { // Excel date serial (1900 system) -> { date, minutes }
  const days = Math.floor(n); const frac = n - days;
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, minutes: Math.round(frac * 1440) };
}
const isSerial = (s) => /^\d{5}(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000;
// -> 'YYYY-MM-DDTHH:MM' or null
function parseTs(raw) {
  const s = norm(raw);
  if (!s) return null;
  if (isSerial(s)) { const p = serialToParts(Number(s)); return `${p.date}T${pad(Math.floor(p.minutes / 60) % 24)}:${pad(p.minutes % 60)}`; }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]+(.+))?$/.exec(s);
  let y; let mo; let d; let rest;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ ,]+(.+))?$/.exec(s))) {
    mo = +m[1]; d = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; rest = m[4];
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  let minutes = 0;
  if (rest) {
    const mm = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(am|pm)?$/i.exec(rest.trim());
    if (!mm) return null;
    let h = +mm[1]; const min = +mm[2];
    if (mm[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (mm[3].toLowerCase() === 'pm' ? 12 : 0); }
    if (h > 23 || min > 59) return null;
    minutes = h * 60 + min;
  }
  return `${y}-${pad(mo)}-${pad(d)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
// A cell Excel turned into a number although the field wants a time or a date.
function fixCell(field, raw) {
  const s = norm(raw);
  if (field.kind === 'time' && /^0?\.\d+$|^1$|^0$/.test(s)) { const m = Math.round(Number(s) * 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
  if (field.kind === 'date' && isSerial(s)) return serialToParts(Number(s)).date;
  return s;
}

// Map the header row to columns. Returns { fixed: {name: idx}, cols: [{idx, key, which, header}], errors, warnings }.
function mapHeaders(svc, header, columnsSheet) {
  const L = svc._labels();
  const out = { fixed: {}, cols: [], errors: [], warnings: [] };
  const fixedAlias = new Map();
  for (const [name, aliases] of FIXED) for (const a of aliases) fixedAlias.set(key(a), name);
  fixedAlias.set(key(L.line), 'line'); fixedAlias.set(key(L.part), 'part'); fixedAlias.set(key(L.part.replace(/\.$/, '')), 'part');
  const fields = svc.getFields();
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const byName = new Map();
  const addName = (n, f) => { const k = key(n); if (!byName.has(k)) byName.set(k, []); if (!byName.get(k).includes(f)) byName.get(k).push(f); };
  for (const f of fields) { addName(f.label, f); if (f.unit) addName(`${f.label} (${f.unit})`, f); }
  const mapped = new Map((columnsSheet || []).slice(1).filter((r) => r && r[0] && r[1]).map((r) => [norm(r[0]), { key: norm(r[1]), which: lc(r[2]) === 'setpoint' ? 'setpoint' : 'actual' }]));
  header.forEach((h, idx) => {
    const text = norm(h);
    if (!text) return;
    const fx = fixedAlias.get(key(text));
    if (fx && out.fixed[fx] === undefined) { out.fixed[fx] = idx; return; }
    if (IGNORED.has(lc(text))) return;
    if (mapped.has(text) && byKey.has(mapped.get(text).key)) { out.cols.push({ idx, header: text, ...mapped.get(text) }); return; }
    if (mapped.has(text)) { out.errors.push(`Column “${text}” maps to the field “${mapped.get(text).key}”, which does not exist here.`); return; }
    const sfx = /\s*[-–·]\s*(setpoint|sp|actual)$/i.exec(text);
    const which = sfx ? (/^(setpoint|sp)$/i.test(sfx[1]) ? 'setpoint' : 'actual') : 'actual';
    const base = sfx ? text.slice(0, sfx.index) : text;
    const hits = byName.get(key(base)) || byName.get(key(base.replace(/\s*\([^)]*\)\s*$/, ''))) || [];
    if (hits.length === 1) { out.cols.push({ idx, header: text, key: hits[0].key, which }); return; }
    out.errors.push(hits.length > 1 ? `Column “${text}” matches more than one field. Use the exported template's headers.` : `Column “${text}” does not match any field (or any standard column). Rename it, or delete the column.`);
  });
  for (const need of ['line', 'part', 'ts']) {
    if (out.fixed[need] === undefined) out.errors.push(`There is no ${need === 'line' ? L.line : need === 'part' ? L.part : 'Date/Time'} column.`);
  }
  return out;
}

// ---------- plan ----------
// opts: { skipBad: import the good rows and list the bad ones as skipped }
const emptyPlan = () => ({
  errors: [], warnings: [], skipped: [], entries: [], changed: 0, rowsRead: 0,
  summary: { rows: 0, toAdd: 0, duplicates: 0, skipped: 0, newParts: [], values: 0, first: '', last: '', outOfRange: 0 },
});
function planHistory(svc, buf, opts = {}) {
  const plan = emptyPlan();
  let sheets;
  try { sheets = readXlsx(buf); } catch (e) { plan.errors.push(e.message); return plan; }
  return planSheets(svc, sheets, opts, plan);
}

// The plan for already-parsed sheets ([{name, rows}]): the Excel import reads them from a workbook, the scan import builds them.
function planSheets(svc, sheets, opts = {}, plan = emptyPlan()) {
  const sheet = sheets.find((s) => lc(s.name) === 'entries') || sheets.find((s) => s.rows[0] && mapHeaders(svc, s.rows[0], null).fixed.part !== undefined && mapHeaders(svc, s.rows[0], null).fixed.line !== undefined) || sheets[0];
  if (!sheet || !sheet.rows.length) { plan.errors.push('The workbook has no rows.'); return plan; }
  const columns = sheets.find((s) => lc(s.name) === 'columns');
  const hm = mapHeaders(svc, sheet.rows[0], columns?.rows);
  plan.errors.push(...hm.errors);
  plan.warnings.push(...hm.warnings);
  if (plan.errors.length) return plan;

  const L = svc._labels();
  const fields = new Map(svc.getFields().map((f) => [f.key, f]));
  const lineForm = new Map(svc.getLineForms().map((l) => [l.line, l.form_no]));
  const formKeys = new Map();
  const keysOnForm = (n) => { if (!formKeys.has(n)) formKeys.set(n, new Set(svc.getFormFields(n).map((f) => f.key))); return formKeys.get(n); };
  const cell = (r, name) => (hm.fixed[name] === undefined ? '' : norm(r[hm.fixed[name]] ?? ''));
  const seenKey = new Map(); // line|part|ts -> first row
  const filePart = new Map(); // line|folded part -> spelling first used in the file
  const newParts = new Map(); // line|part -> rows
  const offForm = new Set();
  let rowNo = 1;

  for (let i = 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i];
    rowNo = i + 1;
    if (!r || r.every((c) => C.blank(c))) continue;
    plan.summary.rows++;
    const problems = [];
    const bad = (m) => problems.push(m);
    const lineRaw = cell(r, 'line').replace(/\.0+$/, '');
    const line = /^\d+$/.test(lineRaw) ? parseInt(lineRaw, 10) : NaN;
    if (!(line > 0)) bad(`${L.line} “${lineRaw}” is not a number`);
    else if (!lineForm.has(line)) bad(`${L.line} ${line} is not set up (Settings → ${L.line} → Form)`);
    let part = norm(cell(r, 'part'));
    if (!part) bad(`${L.part} is empty`);
    const ts = parseTs(cell(r, 'ts'));
    if (!ts) bad(`Date/Time “${cell(r, 'ts')}” is not a date (use 2026-03-10 08:00)`);
    if (line > 0 && part) { // one spelling per part: the stored one, else the first one used in this file
      const stored = svc._canonPart(line, part);
      const fk = `${line}|${part.toLowerCase()}`;
      if (stored !== part) part = stored;
      else if (filePart.has(fk)) part = filePart.get(fk);
      else filePart.set(fk, part);
    }
    const values = [];
    for (const c of hm.cols) {
      const f = fields.get(c.key);
      const raw = r[c.idx];
      if (C.blank(raw)) continue;
      const fixed = fixCell(f, raw);
      const p = f.kind === 'text' ? { ok: true, value: norm(fixed) } : T.parse(f, fixed);
      if (!p.ok) { bad(`${c.header}: ${p.error}`); continue; }
      values.push({ key: c.key, which: c.which, value: p.value });
      if (c.which === 'actual' && T.outOfRange(f, p.value)) plan.summary.outOfRange++;
      if (line > 0 && lineForm.get(line) && !keysOnForm(lineForm.get(line)).has(c.key)) offForm.add(`${f.label}|${lineForm.get(line)}`);
    }
    const notesParts = [cell(r, 'notes'), cell(r, 'source') && `Source: ${cell(r, 'source')}`, cell(r, 'review') && `NEEDS REVIEW: ${cell(r, 'review')}`].filter(Boolean);
    const notes = notesParts.join(' | ');
    if (!values.length && !notes) bad('the row has no values and no notes');
    if (line > 0 && part && ts) {
      const sk = `${line}|${part}|${ts}`;
      if (seenKey.has(sk)) bad(`same ${L.line.toLowerCase()}, ${L.part.toLowerCase()} and date/time as row ${seenKey.get(sk)}. Add a time to tell them apart`);
      else seenKey.set(sk, rowNo);
    }
    if (problems.length) { plan.skipped.push({ row: rowNo, problems }); continue; }
    if (svc.db.prepare('SELECT 1 FROM entries WHERE line=? AND part_no=? AND entry_ts=? AND voided=0').get(line, part, ts)) { plan.summary.duplicates++; continue; }
    const vals = {};
    for (const v of values) (vals[v.key] = vals[v.key] || {})[v.which] = v.value;
    plan.entries.push({
      row: rowNo, line, part_no: part, entry_ts: ts, entered_by: cell(r, 'by'), sheet_rev: cell(r, 'rev'), sheet_revised: cell(r, 'revised'),
      hmi_file: cell(r, 'hmi'), reason: cell(r, 'reason'), notes, values: vals,
    });
    plan.summary.values += values.length;
    if (!svc.db.prepare('SELECT 1 FROM parts WHERE line=? AND part_no=?').get(line, part)) {
      const nk = `${line}|${part}`;
      if (!newParts.has(nk)) newParts.set(nk, { line, part });
    }
  }
  plan.rowsRead = plan.summary.rows;
  plan.summary.skipped = plan.skipped.length;
  plan.summary.toAdd = plan.entries.length;
  plan.summary.newParts = [...newParts.values()];
  if (plan.entries.length) {
    const tss = plan.entries.map((e) => e.entry_ts).sort();
    plan.summary.first = tss[0]; plan.summary.last = tss[tss.length - 1];
  }
  // likely typos: a new part that is one character away from a stored part, or from another new part
  const spellings = plan.summary.newParts;
  for (const np of spellings) {
    const near = svc.checkPart(np.line, np.part).similar.map((s) => s.part_no);
    const alsoNew = spellings.filter((o) => o !== np && o.line === np.line && o.part > np.part && nearEnough(o.part, np.part)).map((o) => o.part);
    const all = [...new Set([...near, ...alsoNew])];
    if (all.length) plan.warnings.push(`${L.part} “${np.part}” (${L.line.toLowerCase()} ${np.line}) is new but looks like ${all.map((a) => `“${a}”`).join(', ')}. A typo would start a separate history.`);
  }
  for (const k of offForm) { const [label, form] = k.split('|'); plan.warnings.push(`“${label}” is not on form ${form}; its values are imported anyway.`); }
  if (plan.summary.duplicates) plan.warnings.push(`${plan.summary.duplicates} row${plan.summary.duplicates === 1 ? '' : 's'} already exist${plan.summary.duplicates === 1 ? 's' : ''} (same ${L.line.toLowerCase()}, ${L.part.toLowerCase()} and date/time) and will be skipped.`);
  if (plan.summary.outOfRange) plan.warnings.push(`${plan.summary.outOfRange} actual value${plan.summary.outOfRange === 1 ? ' is' : 's are'} outside the field's min/max (flagged after import, not blocked).`);
  if (plan.skipped.length) {
    for (const s of plan.skipped.slice(0, 200)) plan.errors.push(`Row ${s.row}: ${s.problems.join('; ')}`);
    if (plan.skipped.length > 200) plan.errors.push(`…and ${plan.skipped.length - 200} more rows with problems`);
  }
  plan.canApply = plan.entries.length > 0 && (plan.skipped.length === 0 || !!opts.skipBad);
  plan.changed = plan.entries.length;
  return plan;
}
// one edit apart ignoring case/punctuation
function nearEnough(a, b) {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, ''); const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (x === y) return true;
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0; let j = 0; let diff = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return diff + (x.length - i) + (y.length - j) <= 1;
}

// ---------- apply ----------
function applyHistory(svc, plan) {
  if (!plan.canApply) throw new Error(plan.entries.length ? 'The file has rows with problems. Fix them, or choose to skip those rows.' : 'There is nothing to import.');
  const db = svc.db;
  svc._tx(() => {
    const insPart = db.prepare('INSERT OR IGNORE INTO parts(line,part_no) VALUES(?,?)');
    const insEntry = db.prepare(`INSERT INTO entries(line,part_no,entry_ts,entered_by,sheet_rev,sheet_revised,hmi_file,notes,source,reason,photo_path)
      VALUES(?,?,?,?,?,?,?,?,?,?,'')`);
    const insVal = db.prepare('INSERT INTO entry_values(entry_id,key,setpoint,actual) VALUES(?,?,?,?)');
    for (const e of plan.entries) {
      insPart.run(e.line, e.part_no);
      const id = Number(insEntry.run(e.line, e.part_no, e.entry_ts, e.entered_by, e.sheet_rev, e.sheet_revised, e.hmi_file, e.notes, plan.source || 'import', e.reason).lastInsertRowid);
      for (const [k, v] of Object.entries(e.values)) insVal.run(id, k, v.setpoint ?? null, v.actual ?? null);
    }
  });
  svc._cache = null;
  svc.audit(plan.source === 'ocr' ? 'scan-import' : 'history-import', `${plan.entries.length} entries (${plan.summary.first.slice(0, 10)} to ${plan.summary.last.slice(0, 10)}), ${plan.summary.newParts.length} new parts, ${plan.skipped.length} rows skipped`);
}

module.exports = { buildHistoryTemplate, planHistory, planSheets, applyHistory, parseTs, mapHeaders };
