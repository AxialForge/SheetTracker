'use strict';
// Reads a setup sheet's words (from OCR or a PDF's text layer) into field values.
// No OCR in here: input is [{text, conf, x0, y0, x1, y1}], so it is testable with plain data.
//
// The printed sheets are "LABEL ... value unit" rows in two columns. OCR line breaks are not trusted (it glues words
// and merges the columns into one line), so rows are rebuilt from word positions, labels are found by fuzzy match
// (wherever they sit in the row) and each value is the words after its label up to the next label.
const C = require('../../shared/compare');
const T = require('../../shared/types');
const Clean = require('../../shared/clean');

const LOW_CONF = 80;      // average word confidence under this is flagged "check"
const GAP_BREAK = 8;      // a gap of this many text heights ends a value (a unit or the next column follows)

const normText = (s) => String(s || '').toUpperCase().replace(/[’‘`´]/g, "'").replace(/[^A-Z0-9#%]/g, '');
// OCR mixes O/0 and I/L/1; compare on a folded alphabet so those do not count as errors
const fold = (s) => s.replace(/O/g, '0').replace(/[IL]/g, '1');
const key = (s) => fold(normText(s));
const tol = (n) => (n <= 4 ? 0 : n <= 8 ? 1 : n <= 14 ? 2 : 3);

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let min = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < min) min = cur[j];
    }
    if (min > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// What the printed forms call things, where it differs from the field's own label.
const ALIASES = {
  billet_grade: ["BILLET GRADE MAT'L", 'BILLET GRADE', "MAT'L", 'MATERIAL'],
  coil_no: ['COIL NUMBER', 'COIL SET', 'COIL NO'],
  lube_head: ['LUBE HEAD NUMBER', 'LUBE TIP', 'LUBE HEAD'],
  billet_temp: ['BILLET TEMPERATURE', 'BILLET TEMP'],
  low_reject_temp: ['LOW REJECT TEMPERATURE', 'LOW REJECT'],
  hi_reject_temp: ['HI REJECT TEMPERATURE', 'HIGH REJECT TEMPERATURE', 'HI REJECT'],
  scrap_temp: ['SCRAP TEMPERATURE', 'SCRAP TEMP'],
  num_coils: ['NUMBER OF COILS', '# OF COILS', '# COILS'],
  num_spacers: ['NUMBER OF SPACERS', '# OF SPACERS', '# SPACERS'],
  run_power: ['RUN POWER LEVEL', 'RUN POWER'],
  run_line_speed: ['RUN LINE SPEED'],
  roller_hi_delay: ['ROLLER TRACK HI DELAY', 'ROLLER HI DELAY'],
  roller_low_delay: ['ROLLER TRACK LOW DELAY', 'ROLLER LOW DELAY'],
  coil_exit_timer: ['COIL EXIT PHOTO TIMER', 'COIL EXIT TIMER'],
  part_cooling: ['PART COOLING REQUIREMENT', 'PART COOLING'],
  special_forge: ['SPECIAL FORGE INSTRUCTION', 'SPECIAL FORGE INSTRUCTIONS'],
  special_trim: ['SPECIAL TRIM INSTRUCTION', 'SPECIAL TRIM INSTRUCTIONS'],
  leave_tongs: ['LEAVE TONGS IN'],
  cycle_time: ['CYCLE TIME'],
  robot_head: ['ROBOT HEAD NUMBER', 'ROBOT HEAD'],
  drop_position: ['DROP POSITION'],
};
// Labels that carry a value on the line(s) below them rather than beside them.
const BELOW = new Set(['special_forge', 'special_trim']);
// Fields filled from a structural row, not from their own label.
const STRUCTURAL = /^(station\d_label|tonnage_s\d|coil\d_amps|kick_hit\d)$/;

// Printed text that is never a value: section headings and column titles. They end the value before them.
const MARKERS = ['BILLET HEATING REQUIREMENTS', 'FORGE PRESS REQUIREMENTS', 'DIE LUBE REQUIREMENTS', 'BILLET SPACERS REQUIREMENTS',
  'PICK AND PLACE ROBOT SETTINGS', 'TRIM PRESS REQUIREMENTS', '% OF COIL AMPS', 'KICK SETUP', 'DIE POSITION', 'KO#', 'DWELL',
  'DESIGN BY/DATE', 'ECN:', 'DATE:'];

function buildLabels(fields) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out = [];
  const add = (text, entry) => {
    const n = key(text);
    if (n.length >= 3) out.push({ n, ...entry });
  };
  for (const m of MARKERS) add(m, { type: 'marker' });
  add('PRESS LINE', { type: 'header', h: 'line' }); add('PART NO', { type: 'header', h: 'part' });
  add('PART NUMBER', { type: 'header', h: 'part' }); add('REVISION', { type: 'header', h: 'rev' });
  add('REVISED BY/DATE', { type: 'header', h: 'revised' }); add('HMI FILE #', { type: 'header', h: 'hmi' });
  add('HMI/PLC FILE #', { type: 'header', h: 'hmi' }); add('FORM #', { type: 'header', h: 'form' });
  add('TONNAGE', { type: 'tonnage' });
  for (let i = 1; i <= 3; i++) { add(`STATION# ${i}`, { type: 'station', num: i }); add(`HIT# ${i}`, { type: 'hit', num: i }); }
  for (let i = 1; i <= 5; i++) add(`COIL# ${i}`, { type: 'coil', num: i });
  for (const f of fields) {
    if (!f.has_sp || STRUCTURAL.test(f.key)) continue;
    const names = new Set([f.label, f.label.replace(/\s*\([^)]*\)\s*/g, ' ').trim(), ...(ALIASES[f.key] || [])]);
    for (const nm of names) add(nm, { type: 'field', key: f.key });
  }
  return { list: out, byKey };
}

// ---- geometry
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const roundConf = (c) => (c === null ? null : Math.round(c));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// Group words into visual rows. skew = dy/dx of the text lines (a tilted photo): removed before grouping.
function buildRows(words, skew) {
  const ws = words.filter((w) => C.norm(w.text)).map((w) => ({ ...w, h: Math.max(1, w.y1 - w.y0), yc: (w.y0 + w.y1) / 2 - (skew || 0) * ((w.x0 + w.x1) / 2) }));
  const h = median(ws.map((w) => w.h)) || 20;
  ws.sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
  const rows = [];
  for (const w of ws) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(w.yc - r.yc) <= 0.55 * h) { r.words.push(w); r.yc = mean(r.words.map((x) => x.yc)); } else rows.push({ words: [w], yc: w.yc });
  }
  for (const r of rows) { r.words.sort((a, b) => a.x0 - b.x0); r.h = median(r.words.map((w) => w.h)) || h; }
  return { rows, h };
}

// A multi-word match must start with its first word and end with its last: stops a stray "9" before PART NO. riding along.
function spanOk(w, i, s, label) {
  const first = fold(normText(w[i].text));
  const last = fold(normText(w[i + s - 1].text));
  if (!first || !last) return false;
  const ok = (a, b) => lev(a, b, 1) <= (a.length >= 5 ? 1 : 0);
  return ok(first, label.slice(0, first.length)) && ok(last, label.slice(label.length - last.length));
}

// ---- label matching within a row
function matchRow(row, labels) {
  const hits = [];
  const w = row.words;
  let i = 0;
  while (i < w.length) {
    let best = null;
    let joined = '';
    for (let s = 1; s <= 6 && i + s <= w.length; s++) {
      joined += normText(w[i + s - 1].text);
      const j = fold(joined);
      if (j.length < 3) continue;
      for (const L of labels) {
        const t = tol(L.n.length);
        if (Math.abs(L.n.length - j.length) > t) continue;
        const d = lev(j, L.n, t);
        if (d > t) continue;
        if (s > 1 && !(spanOk(w, i, s, L.n))) continue;
        if (!best || d < best.d || (d === best.d && s > best.s)) best = { L, s, d };
      }
    }
    if (best) { hits.push({ L: best.L, i, j: i + best.s - 1 }); i += best.s; } else i++;
  }
  return hits;
}

// ---- values
const DIGITISH = /^[\dOoIl.,]+$/;
function fixDigits(text) { return DIGITISH.test(text) && /\d/.test(text) ? text.replace(/[Oo]/g, '0').replace(/[Il]/g, '1') : text; }

// The first run of words after `from`, ending at a gap wider than GAP_BREAK text heights (the unit or the next column).
function takeValue(words, from, to, h, noBreak) {
  const out = [];
  for (let k = from; k < to; k++) {
    if (out.length && !noBreak && words[k].x0 - words[k - 1].x1 > GAP_BREAK * h) break;
    out.push(words[k]);
  }
  return out;
}
const textOf = (ws) => ws.map((w) => C.norm(w.text)).join(' ').replace(/\s+([,;:])/g, '$1').trim();
// Confidence of the value itself: units and quote marks ("  T  PSI) are tiny and OCR is never sure of them.
const isUnitWord = (w) => !/[A-Za-z0-9]/.test(w.text) || Clean.isUnit(C.norm(w.text));
// Tesseract's sparse mode reports 0-10 for some words it read correctly, so those are "not scored" rather than "poor";
// null when nothing was scored (the value is still checked by its type).
const confOf = (ws) => {
  const core = ws.filter((w) => !isUnitWord(w));
  const scored = (core.length ? core : ws).filter((w) => typeof w.conf !== 'number' || w.conf > 10);
  return scored.length ? mean(scored.map((w) => (typeof w.conf === 'number' ? w.conf : 100))) : null;
};

const isoDate = (s) => {
  const m = /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(s);
  if (!m) return '';
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const d = T.parse({ kind: 'date' }, `${y}-${m[1]}-${m[2]}`);
  return d.ok ? d.value : '';
};

// Reads the header block and form number. Cheap: used first to decide which form's fields to look for.
function readHeader(words, opts = {}) {
  const { rows, h } = buildRows(words, opts.skew);
  const labels = buildLabels([]).list;
  const header = { line: '', part: '', rev: '', revised: '', revisedBy: '', hmi: '', form: '' };
  const seen = new Set();
  const lastY = rows.length ? rows[rows.length - 1].yc : 0;
  for (const row of rows) {
    const hits = matchRow(row, labels);
    hits.forEach((hit, k) => {
      if (hit.L.type !== 'header' || seen.has(hit.L.h)) return;
      if (hit.L.h === 'rev' && row.yc > 0.9 * lastY) return;      // the footer's revision belongs to the form, not the sheet
      const end = k + 1 < hits.length ? hits[k + 1].i : row.words.length;
      const vw = takeValue(row.words, hit.j + 1, end, row.h || h, true);
      const txt = textOf(vw);
      const first = vw[0] ? C.norm(vw[0].text) : '';
      const set = (name, v) => { if (v && !Clean.isPlaceholder(v)) { header[name] = v; seen.add(hit.L.h); } };
      if (hit.L.h === 'line') { const m = /\d+/.exec(fixDigits(first)); set('line', m ? m[0] : ''); }
      else if (hit.L.h === 'part') set('part', txt.replace(/\s+/g, '').replace(/[^\w.\-\/]/g, ''));
      else if (hit.L.h === 'rev') set('rev', first.replace(/[^\w.-]/g, ''));
      else if (hit.L.h === 'hmi') set('hmi', first.replace(/[^\w.-]/g, ''));
      else if (hit.L.h === 'form') { const m = /\b(1\d{4})\b/.exec(fixDigits(first) || txt); set('form', m ? m[1] : ''); }
      else if (hit.L.h === 'revised') {
        const d = isoDate(txt);
        const by = txt.replace(/\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}/, '').replace(/[^\w ]/g, '').trim();
        if (d) header.revised = d;
        if (by && !Clean.isPlaceholder(by)) header.revisedBy = by.slice(0, 40);
        if (d || by) seen.add('revised');
      }
    });
  }
  return header;
}

// fields: the form's fields [{key, label, kind, unit, min, max, choices, has_sp, ...}]
function extractFields(words, fields, opts = {}) {
  const { rows, h } = buildRows(words, opts.skew);
  const { list, byKey } = buildLabels(fields);
  const results = new Map();
  const warnings = [];
  const ignored = new Set();
  let placeholders = 0;
  let station = 0;
  let pending = [];   // fields whose value may continue on the rows below

  const put = (k, rawWords, extra = {}) => {
    const f = byKey.get(k);
    if (!f) { ignored.add(k); return null; }
    if (results.has(k)) return null;
    const raw = textOf(rawWords);
    const res = { key: k, label: f.label, raw, conf: roundConf(confOf(rawWords)), page: opts.page || 1, f, words: rawWords, ...extra };
    results.set(k, res);
    return res;
  };

  rows.forEach((row) => {
    const hits = matchRow(row, list);
    const w = row.words;
    const usedTo = [];
    // words before the first label (and any left over) can continue a value from the rows above
    const orphans = [];
    if (!hits.length) orphans.push(w);
    else if (hits[0].i > 0) orphans.push(w.slice(0, hits[0].i));
    for (const o of orphans) {
      const seg = takeValue(o, 0, o.length, row.h || h, false);
      if (!seg.length) continue;
      const p = pending
        .filter((q) => Math.abs(seg[0].x0 - q.x0) <= 2.5 * h + 30 && row.yc - q.last > 0 && row.yc - q.last <= 2.8 * (row.h || h))
        .sort((a, b) => (row.yc - a.last) - (row.yc - b.last))[0];
      if (p && !p.done) {
        p.res.words = p.res.words.concat(seg);
        p.res.raw = `${p.res.raw}${p.res.raw ? '; ' : ''}${textOf(seg)}`.replace(/^; /, '');
        p.res.conf = roundConf(confOf(p.res.words));
        p.last = row.yc;
      }
    }
    pending = pending.filter((q) => row.yc - q.last <= 2.8 * (row.h || h));

    hits.forEach((hit, k) => {
      const L = hit.L;
      const end = k + 1 < hits.length ? hits[k + 1].i : w.length;
      const noBreak = L.type === 'hit';
      const vw = takeValue(w, hit.j + 1, end, row.h || h, noBreak);
      usedTo.push(end);
      const addPending = (res, x0, below) => { if (res) pending.push({ res, x0, last: row.yc, below }); };
      if (L.type === 'station') {
        station = L.num;
        if (vw.length) addPending(put(`station${L.num}_label`, vw), vw[0].x0, false);
      } else if (L.type === 'tonnage') {
        if (station && vw.length) put(`tonnage_s${station}`, vw);
        else if (vw.length) warnings.push('A tonnage value was found before any station was read; it was not used.');
      } else if (L.type === 'coil') {
        if (vw.length) put(`coil${L.num}_amps`, vw);
      } else if (L.type === 'hit') {
        const nums = vw.map((x) => C.norm(x.text)).filter((x) => x && !Clean.isPlaceholder(x));
        if (vw.length) put(`kick_hit${L.num}`, vw, { raw: nums.join(' / '), kick: nums.length });
      } else if (L.type === 'field') {
        const f = byKey.get(L.key);
        const res = vw.length ? put(L.key, vw) : null;
        if (res) addPending(res, vw[0].x0, false);
        else if (BELOW.has(L.key) && !results.has(L.key)) {
          const r0 = put(L.key, [], { raw: '' });
          if (r0) pending.push({ res: r0, x0: w[hit.i].x0, last: row.yc, below: true });
        }
        if (!f) ignored.add(L.key);
      }
    });
  });

  // finish: clean + validate each value
  const out = [];
  for (const res of results.values()) {
    const f = res.f;
    if (!res.raw.trim()) continue;
    let raw = res.raw;
    let altered = false;
    if (f.kind === 'number' || f.kind === 'duration') { const fx = raw.split(/\s+/).map(fixDigits).join(' '); if (fx !== raw) { altered = true; raw = fx; } }
    const cv = Clean.cleanValue(f, raw);
    if (cv.blank) { placeholders++; continue; }
    const r = { key: res.key, label: f.label, unit: f.unit || '', raw: res.raw, conf: res.conf, kind: f.kind, page: res.page };
    if (!cv.ok) { r.status = 'bad'; r.value = ''; r.error = cv.error; out.push(r); continue; }
    r.value = cv.value;
    r.status = 'ok';
    const notes = [];
    if (res.conf !== null && res.conf < LOW_CONF) notes.push(`low OCR confidence (${res.conf}%)`);
    if (altered) notes.push('misread letters read as digits');
    if (res.kick !== undefined && res.kick !== 3) notes.push('expected position / KO# / dwell');
    if (T.outOfRange(f, cv.value)) notes.push('outside the field\'s min/max');
    if (notes.length) { r.status = 'check'; r.note = notes.join('; '); }
    out.push(r);
  }
  const found = new Set(out.map((r) => r.key));
  const missing = fields.filter((f) => f.has_sp && !found.has(f.key) && !results.has(f.key)).map((f) => ({ key: f.key, label: f.label }));
  return { fields: out, missing, placeholders, warnings, ignored: [...ignored], rows: rows.length, conf: Math.round(mean(words.map((w) => (typeof w.conf === 'number' ? w.conf : 100)))) };
}

// words -> { header, form, fields[], missing[], ... }. resolve(header) -> { form, fields } for the sheet's form.
function extractSheet(words, resolve, opts = {}) {
  const header = readHeader(words, opts);
  const ctx = resolve(header) || { form: 0, fields: [] };
  const res = extractFields(words, ctx.fields, opts);
  return { header, form: ctx.form || (header.form ? +header.form : 0), formSource: ctx.source || '', ...res };
}

module.exports = { extractSheet, extractFields, readHeader, buildRows, matchRow, buildLabels, lev, key };
