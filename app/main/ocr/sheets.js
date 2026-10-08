'use strict';
// Scanned sheets <-> the app: review one scan against the form's fields, and turn reviewed scans into entries
// through the same plan/apply as the Excel history import (same checks, same preview, same backup).
const C = require('../../shared/compare');
const T = require('../../shared/types');
const Ex = require('./extract');
const Hist = require('../history');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// scan: { file, pages: [{ words, skew, conf }] }. opts: { form } to override the form (when the sheet's own is not readable).
// Returns the sheet as the review screen shows it.
function reviewScan(svc, scan, opts = {}) {
  const L = svc._labels();
  const pages = (scan.pages || []).filter((p) => p && p.words && p.words.length);
  const headers = pages.map((p) => Ex.readHeader(p.words, { skew: p.skew }));
  const header = {};
  for (const k of ['line', 'part', 'rev', 'revised', 'revisedBy', 'hmi', 'form']) header[k] = (headers.find((h) => h[k]) || {})[k] || '';
  const forms = new Map(svc.getForms().map((f) => [f.form_no, f]));
  const line = /^\d+$/.test(header.line) ? Number(header.line) : null;
  let form = null;
  let formSource = '';
  if (opts.form && forms.has(Number(opts.form))) { form = Number(opts.form); formSource = 'chosen'; }
  else if (header.form && forms.has(Number(header.form))) { form = Number(header.form); formSource = 'sheet'; }
  else if (opts.line && svc.formFor(opts.line)) { form = svc.formFor(opts.line); formSource = 'line'; }
  else if (line && svc.formFor(line)) { form = svc.formFor(line); formSource = 'line'; }
  const problems = [];
  const warnings = [];
  const item = {
    file: scan.file || '', header, form, formSource, formName: form ? forms.get(form).name : '', pages: pages.length,
    line: opts.line || line, part: header.part, rev: header.rev, revised: header.revised, revisedBy: header.revisedBy, hmi: header.hmi,
    fields: [], missing: [], warnings, problems, conf: 0,
  };
  if (!pages.length) { problems.push('No text was found on the sheet.'); return item; }
  item.conf = Math.round(pages.reduce((s, p) => s + (p.conf || 0), 0) / pages.length);
  if (!form) { problems.push(header.form ? `Form ${header.form} is not in this database.` : `The form number was not found${line ? ` and ${L.line.toLowerCase()} ${line} has no form` : ''}. Choose the form.`); return item; }
  if (header.form && forms.has(Number(header.form)) && opts.line && svc.formFor(opts.line) && svc.formFor(opts.line) !== Number(header.form)) {
    warnings.push(`The sheet says form ${header.form}, but ${L.line.toLowerCase()} ${opts.line} is set up for form ${svc.formFor(opts.line)}.`);
  }
  const fields = svc.getFormFields(form).filter((f) => f.has_sp);
  const seen = new Set();
  const found = new Set();
  pages.forEach((p, i) => {
    const r = Ex.extractFields(p.words, fields, { skew: p.skew, page: i + 1 });
    for (const f of r.fields) if (!seen.has(f.key)) { seen.add(f.key); found.add(f.key); item.fields.push(f); }
    warnings.push(...r.warnings);
  });
  item.missing = fields.filter((f) => !found.has(f.key)).map((f) => ({ key: f.key, label: f.label }));
  if (!item.line) problems.push(`${L.line} was not read from the sheet. Choose it.`);
  else if (!svc.formFor(item.line)) problems.push(`${L.line} ${item.line} is not set up (Settings → ${L.line} → Form).`);
  if (!item.part) problems.push(`${L.part} was not read from the sheet (it may be a blank form). Type it in.`);
  if (!item.fields.length) problems.push('No values were found. The photo may be too dark or too small, or this is not one of the sheets.');
  return item;
}

// Fill in what the review screen shows about a part: stored spelling, similar parts, the last setpoint of each value.
function partInfo(svc, line, part) {
  if (!line || !part) return null;
  const chk = svc.checkPart(line, part);
  return { exists: chk.exists, canonical: chk.canonical, similar: chk.similar.map((s) => s.part_no), otherLines: chk.otherLines };
}
function previous(svc, line, part) {
  const out = {};
  for (const [k, v] of Object.entries(svc.latestValues(line, svc._canonPart(line, part)))) if (!C.blank(v.setpoint)) out[k] = v.setpoint;
  return out;
}

// items: [{ file, line, part, rev, revised, revisedBy, hmi, notes?, fields: [{ key, label, value, raw, status, note?, error?, include }] }]
// Only fields with include !== false and a value become entry values; the rest are listed in the entry's notes.
function buildSheets(svc, items, opts = {}) {
  const L = svc._labels();
  const now = opts.now ? new Date(opts.now) : new Date();
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => (Number(a.it.line) - Number(b.it.line)) || String(a.it.part).localeCompare(String(b.it.part))
    || String(a.it.revised || '').localeCompare(String(b.it.revised || '')) || String(a.it.file).localeCompare(String(b.it.file)));
  const groups = new Map();
  for (const o of order) { const g = `${o.it.line}|${String(o.it.part).toLowerCase()}`; (groups.get(g) || groups.set(g, []).get(g)).push(o); }
  const cols = new Map(); // header -> key
  for (const it of items) for (const f of it.fields) if (f.include !== false && f.status !== 'bad' && !C.blank(f.value)) cols.set(`${f.key} - Setpoint`, f.key);
  const colList = [...cols.keys()];
  const headers = [L.line, L.part, 'Date/Time', 'Entered by', 'Sheet rev', 'Revised', 'HMI file', 'Reason', 'Notes', 'Source file', 'Review', ...colList];
  const rows = [];
  const rowItem = [];
  for (const group of groups.values()) {
    group.forEach((o, idx) => {
      const it = o.it;
      const base = opts.dateBy === 'revised' && /^\d{4}-\d{2}-\d{2}$/.test(it.revised || '') ? new Date(`${it.revised}T08:00:00`) : now;
      const ts = stamp(new Date(base.getTime() - (group.length - 1 - idx) * 60000));
      const used = it.fields.filter((f) => f.include !== false && f.status !== 'bad' && !C.blank(f.value));
      const dropped = it.fields.filter((f) => !used.includes(f) && !C.blank(f.raw || f.value));
      const review = [
        ...used.filter((f) => f.status === 'check').map((f) => `${f.label} = ${f.value}${f.note ? ` (${f.note})` : ''}`),
        ...dropped.map((f) => `NOT IMPORTED ${f.label} = ${f.raw || f.value}`),
      ].join('; ');
      const byKey = new Map(used.map((f) => [f.key, f.value]));
      rows.push([String(it.line), it.part, ts, it.revisedBy || '', it.rev || '', it.revised || '', it.hmi || '', '',
        ['Setup sheet scanned (OCR)', ...(it.notes || [])].filter(Boolean).join(' | '), it.file || '', review, ...colList.map((h) => byKey.get(cols.get(h)) ?? '')]);
      rowItem.push(it);
    });
  }
  const colsSheet = [['Header', 'Field key', 'Value'], ...colList.map((h) => [h, cols.get(h), 'setpoint'])];
  return { sheets: [{ name: 'Entries', rows: [headers, ...rows] }, { name: 'Columns', rows: colsSheet }], rowItem };
}

// A sheet whose values all match the part's latest setpoints adds nothing: re-running a folder must not duplicate entries.
function unchanged(svc, it) {
  if (!it.line || !it.part) return false;
  const used = it.fields.filter((f) => f.include !== false && f.status !== 'bad' && !C.blank(f.value));
  if (!used.length) return false;
  const prev = svc.latestValues(it.line, svc._canonPart(it.line, it.part));
  const fields = new Map(svc.getFields().map((f) => [f.key, f]));
  return used.every((f) => prev[f.key] && !C.blank(prev[f.key].setpoint) && T.same(fields.get(f.key), prev[f.key].setpoint, f.value));
}

function planScans(svc, items, opts = {}) {
  const fresh = [];
  let same = 0;
  const sameFiles = [];
  for (const it of items) {
    if (it.include === false) continue;
    if (unchanged(svc, it)) { same++; sameFiles.push(it.file); } else fresh.push(it);
  }
  if (!fresh.length) {
    const plan = Hist.planSheets(svc, [{ name: 'Entries', rows: [['Line', 'Part No.', 'Date/Time']] }], opts);
    plan.errors = []; plan.canApply = false;
    plan.summary.duplicates = same;
    if (same) plan.warnings.push(`${same} sheet${same === 1 ? ' is' : 's are'} already up to date (the same setpoints are stored).`);
    return Object.assign(plan, { source: 'ocr', files: [] });
  }
  const { sheets, rowItem } = buildSheets(svc, fresh, opts);
  const plan = Hist.planSheets(svc, sheets, opts);
  plan.source = 'ocr';
  plan.summary.duplicates += same;
  if (same) plan.warnings.push(`${same} sheet${same === 1 ? ' is' : 's are'} already up to date (the same setpoints are stored) and ${same === 1 ? 'was' : 'were'} skipped.`);
  plan.errors = plan.errors.map((e) => e.replace(/^Row (\d+):/, (m, n) => `${(rowItem[n - 2] || {}).file || `Row ${n}`}:`));
  plan.files = rowItem.map((it) => it.file);
  return plan;
}

function applyScans(svc, items, opts = {}) {
  const plan = planScans(svc, items, opts);
  if (!plan.canApply) throw new Error(plan.entries.length ? `${plan.skipped.length} sheet${plan.skipped.length === 1 ? ' has' : 's have'} problems. Fix them, or choose to skip those.` : 'There is nothing to import.');
  svc.backupNow('pre-scan', true);
  Hist.applyHistory(svc, plan);
  return { added: plan.entries.length, skipped: plan.skipped.length, newParts: plan.summary.newParts.length, upToDate: plan.summary.duplicates };
}

module.exports = { reviewScan, planScans, applyScans, partInfo, previous, buildSheets };
