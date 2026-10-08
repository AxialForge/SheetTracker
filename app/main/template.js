'use strict';
// Form templates in Excel: export a form (or all forms) as a workbook, edit it in Excel, import it back.
// Importing never touches stored entries. It shows a plan first (what will be added / changed / removed).
const C = require('../shared/compare');
const T = require('../shared/types');
const { toXlsxBook, readXlsx } = require('./export');

const ENTRY = { setting: 'Setting', reading: 'Reading' };
const ROLE = { tracked: 'Tracked', initial: 'Set once' };
const FIELD_HEADERS = ['Form', 'Section', 'Field', 'Type', 'Unit', 'Entry', 'Role', 'Options', 'Min', 'Max', 'Key'];

const norm = (s) => C.norm(s);
const lc = (s) => norm(s).toLowerCase();
const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// ---------- export ----------
function readMe(blank) {
  const rows = [
    ['Setup Tracker form template'],
    [''],
    ['How to use'],
    ['1. Fill in or edit the Fields sheet: one row per field on a form. Add rows freely; delete rows you do not want.'],
    ['2. Save the workbook, then in Setup Tracker open Forms → Import template and pick it. You see a preview of every change before anything is applied.'],
    ['3. Stored entries are never changed or deleted by an import.'],
    [''],
    ['Columns on the Fields sheet'],
    ['Form: the form number this row belongs to. The same field can appear on several forms (one row per form).'],
    ['Section: the heading the field is grouped under on the entry screen. A new name creates a new section.'],
    ['Field: what the operator sees.'],
    ['Type: Number, Text, Choice (pick-list), Yes / No, Rating, Ratio (x of y), Time of day, Duration, Date.'],
    ['Unit: shown next to the field (°F, s, PSI …). Optional.'],
    ['Entry: Setting = has a printed sheet setpoint and an actual value, and is change-tracked. Reading = actual value only, never counted as a change.'],
    ['Role: Tracked = asked on every entry. Set once = asked on the first entry for a line + part (and on demand after that).'],
    ['Options: for Choice, the allowed values separated by semicolons (e.g. Standard; Heavy). For Text, the usual values (offered as suggestions).'],
    ['Min / Max: optional limits for Number, Duration and Time of day (a value outside them is flagged, not blocked). For Rating, Max is the scale (e.g. 5) and Min the lowest rating (default 1).'],
    ['Key: the app\'s internal id for the field. Leave it blank for new fields. Keep it on existing rows so a rename is a rename, not a new field.'],
    [''],
    ['Forms sheet: a name and notes for each form, and the lines that use it (comma separated). Lines listed here are pointed at that form.'],
    [''],
    ['Example'],
    ['Form | Section | Field | Type | Unit | Entry | Role | Options | Min | Max'],
    ['101 | Heating | Furnace temp | Number | °F | Setting | Tracked | | 1800 | 2400'],
    ['101 | Heating | Pump OK | Yes / No | | Reading | Tracked'],
    ['101 | Setup | Grade | Choice | | Setting | Set once | A; B; C'],
    ['101 | Quality | Surface finish | Rating | | Reading | Tracked | | 1 | 5'],
  ];
  return blank ? rows : rows.slice(0, 19);
}

// svc: SetupService.  opts: { forms: 'all' | [form numbers], blank: boolean }
function buildTemplate(svc, opts = {}) {
  const sections = svc.getSections();
  const secOrder = new Map(sections.map((s, i) => [s.key, i]));
  const secLabel = (k) => sections.find((s) => s.key === k)?.label || k;
  const allForms = svc.getForms();
  const pick = opts.blank ? [] : (opts.forms === undefined || opts.forms === 'all' ? allForms : allForms.filter((f) => [].concat(opts.forms).map(Number).includes(f.form_no)));
  const rows = [];
  for (const f of pick) {
    const fields = svc.getFormFields(f.form_no).slice().sort((a, b) => (secOrder.get(a.section) ?? 99) - (secOrder.get(b.section) ?? 99) || a.sort - b.sort);
    for (const fl of fields) rows.push(fieldRow(f.form_no, secLabel(fl.section), fl));
  }
  const formRows = pick.map((f) => [f.form_no, f.name, f.notes, f.lines.join(', ')]);
  return assemble(svc, { rows, formRows, blank: opts.blank });
}

// One Fields-sheet row (in FIELD_HEADERS order) for a field on a form. fl: a field record with its role.
function fieldRow(formNo, sectionLabel, fl) {
  return [formNo, sectionLabel, fl.label, T.label(fl.kind).split(' (')[0], fl.unit || '',
    fl.has_sp ? ENTRY.setting : ENTRY.reading, ROLE[fl.role] || ROLE.tracked,
    String(fl.choices || '').split('\n').filter(Boolean).join('; '), fl.min || '', fl.max || '', fl.key || ''];
}

// The workbook layout: Read me, Fields (with dropdowns), Forms, hidden Lists. rows / formRows as built above.
function assemble(svc, { rows, formRows, blank = false }) {
  const sections = svc.getSections();
  const lists = [];
  const types = T.KINDS.map((k) => k.label.split(' (')[0]);
  const secLabels = sections.map((s) => s.label);
  const n = Math.max(types.length, secLabels.length, 2);
  for (let i = 0; i < n; i++) lists.push([types[i] || '', i === 0 ? ENTRY.setting : i === 1 ? ENTRY.reading : '', i === 0 ? ROLE.tracked : i === 1 ? ROLE.initial : '', secLabels[i] || '']);
  return toXlsxBook([
    { name: 'Read me', headers: ['Setup Tracker form template'], rows: readMe(blank).slice(1).map((r) => [r[0]]), widths: [120], freeze: null, wrap: [0] },
    {
      name: 'Fields', headers: FIELD_HEADERS, rows, freeze: { x: 3, y: 1 }, muted: [10], numericFrom: undefined,
      widths: [8, 20, 30, 16, 10, 10, 11, 34, 9, 9, 22],
      validations: [
        { col: 1, range: `Lists!$D$2:$D$${secLabels.length + 1}`, warn: true },
        { col: 3, range: `Lists!$A$2:$A$${types.length + 1}` },
        { col: 5, range: 'Lists!$B$2:$B$3' },
        { col: 6, range: 'Lists!$C$2:$C$3' },
      ],
    },
    { name: 'Forms', headers: ['Form', 'Name', 'Notes', 'Lines'], rows: formRows, widths: [8, 34, 44, 24], freeze: { x: 1, y: 1 } },
    { name: 'Lists', headers: ['Types', 'Entry', 'Role', 'Sections'], rows: lists, hidden: true },
  ]);
}

// ---------- parse ----------
const HEADER_ALIASES = {
  form: ['form', 'formno', 'formnumber', 'formnum'],
  section: ['section', 'group', 'heading', 'category'],
  field: ['field', 'fieldname', 'name', 'label', 'item', 'description'],
  kind: ['type', 'fieldtype', 'datatype'],
  unit: ['unit', 'units', 'uom'],
  entry: ['entry', 'settingorreading', 'settingreading', 'kind'],
  role: ['role', 'tracking', 'frequency', 'asked'],
  options: ['options', 'choices', 'picklist', 'list', 'values', 'allowedvalues'],
  min: ['min', 'minimum', 'low', 'lowlimit', 'lower'],
  max: ['max', 'maximum', 'high', 'highlimit', 'upper', 'scale'],
  key: ['key', 'id', 'fieldkey', 'fieldid'],
};
function headerMap(header) {
  const map = {};
  header.forEach((h, i) => {
    const t = lc(h).replace(/[^a-z]/g, '');
    if (!t) return;
    for (const [name, aliases] of Object.entries(HEADER_ALIASES)) if (map[name] === undefined && aliases.includes(t)) { map[name] = i; break; }
  });
  return map;
}
const isBlankRow = (r) => !r || r.every((c) => C.blank(c));

// Returns { rows, forms, errors, warnings }. Rows are normalised but not yet compared with the database.
function parseTemplate(buf) {
  const sheets = readXlsx(buf);
  const out = { rows: [], forms: [], errors: [], warnings: [] };
  const fsheet = sheets.find((s) => lc(s.name) === 'fields') || sheets.find((s) => s.rows[0] && headerMap(s.rows[0]).field !== undefined && headerMap(s.rows[0]).form !== undefined);
  if (!fsheet) { out.errors.push('No “Fields” sheet found. Export a template from Setup Tracker (Forms → Download template) and fill that in.'); return out; }
  const header = fsheet.rows[0] || [];
  const col = headerMap(header);
  for (const need of ['form', 'field']) {
    if (col[need] === undefined) out.errors.push(`The Fields sheet has no “${need === 'form' ? 'Form' : 'Field'}” column.`);
  }
  if (out.errors.length) return out;
  const cell = (r, name) => (col[name] === undefined ? '' : norm(r[col[name]] ?? ''));
  const seen = new Map();
  for (let i = 1; i < fsheet.rows.length; i++) {
    const r = fsheet.rows[i];
    if (isBlankRow(r)) continue;
    const rowNo = i + 1;
    const err = (m) => out.errors.push(`Fields row ${rowNo}: ${m}`);
    const label = cell(r, 'field');
    if (!label) { err('no field name.'); continue; }
    const formRaw = cell(r, 'form');
    const form_no = /^\d+$/.test(formRaw.replace(/\.0+$/, '')) ? parseInt(formRaw, 10) : NaN;
    if (!(form_no > 0)) { err(`“${label}” has no valid form number (got “${formRaw}”).`); continue; }
    let kind = 'number';
    const kindRaw = cell(r, 'kind');
    if (kindRaw) { kind = T.kindFrom(kindRaw); if (!kind) { err(`“${label}”: unknown type “${kindRaw}”. Use one of: ${T.KINDS.map((k) => k.label.split(' (')[0]).join(', ')}.`); continue; } }
    let has_sp = 1;
    const entryRaw = lc(cell(r, 'entry'));
    if (entryRaw) {
      if (/^(setting|set|setpoint|tracked setting)/.test(entryRaw)) has_sp = 1;
      else if (/^(reading|read|actual|measure)/.test(entryRaw)) has_sp = 0;
      else { err(`“${label}”: Entry must be Setting or Reading (got “${cell(r, 'entry')}”).`); continue; }
    }
    let role = 'tracked';
    const roleRaw = lc(cell(r, 'role'));
    if (roleRaw) {
      if (/^(tracked|track|every|daily)/.test(roleRaw)) role = 'tracked';
      else if (/^(set ?once|once|initial|setup|set up|fixed|first)/.test(roleRaw)) role = 'initial';
      else { err(`“${label}”: Role must be Tracked or Set once (got “${cell(r, 'role')}”).`); continue; }
    }
    const kindGiven = !!kindRaw; const entryGiven = !!entryRaw; const roleGiven = !!roleRaw;
    const optionsRaw = col.options === undefined ? '' : String(r[col.options] ?? '');
    const row = {
      rowNo, form_no, label, kind, has_sp, role, kindGiven, entryGiven, roleGiven,
      section: cell(r, 'section'), unit: cell(r, 'unit'), choices: optionsRaw.split(/[;\n]/).map(norm).filter(Boolean).join('\n'),
      min: cell(r, 'min'), max: cell(r, 'max'), key: cell(r, 'key'),
      given: { unit: col.unit !== undefined, options: col.options !== undefined, min: col.min !== undefined, max: col.max !== undefined, section: col.section !== undefined, kind: col.kind !== undefined, entry: col.entry !== undefined },
    };
    if (row.key && !/^[A-Za-z0-9_]+$/.test(row.key)) { err(`“${label}”: the Key “${row.key}” may only contain letters, numbers and underscores. Clear it to create a new field.`); continue; }
    if (row.key) row.key = row.key.toLowerCase();
    const dupe = `${form_no}|${row.key || `label:${lc(label)}`}`;
    if (seen.has(dupe)) { err(`“${label}” is already on form ${form_no} (row ${seen.get(dupe)}).`); continue; }
    seen.set(dupe, rowNo);
    // bounds must make sense for the type
    for (const which of ['min', 'max']) {
      if (!row[which]) continue;
      if (kind === 'rating') { if (!/^\d+$/.test(row[which])) err(`“${label}”: ${which === 'max' ? 'Max (the scale)' : 'Min (lowest rating)'} must be a whole number.`); }
      else if (T.NUMERIC.has(kind) && kind !== 'ratio') { const p = T.parse({ kind }, row[which]); if (!p.ok) err(`“${label}”: ${which === 'min' ? 'Min' : 'Max'} ${p.error}.`); else row[which] = p.value; }
    }
    if (kind === 'choice' && !row.choices) out.warnings.push(`Fields row ${rowNo}: “${label}” is a Choice with no options, so it accepts any text until you list some.`);
    out.rows.push(row);
  }
  const forms = sheets.find((s) => lc(s.name) === 'forms');
  if (forms && forms.rows.length) {
    const fc = headerMap(forms.rows[0]);
    const nameCol = forms.rows[0].findIndex((h) => lc(h).replace(/[^a-z]/g, '') === 'name');
    const notesCol = forms.rows[0].findIndex((h) => lc(h).replace(/[^a-z]/g, '') === 'notes');
    const linesCol = forms.rows[0].findIndex((h) => ['lines', 'line', 'usedby', 'stations'].includes(lc(h).replace(/[^a-z]/g, '')));
    if (fc.form === undefined) out.warnings.push('The Forms sheet has no “Form” column and was ignored.');
    else {
      for (let i = 1; i < forms.rows.length; i++) {
        const r = forms.rows[i];
        if (isBlankRow(r)) continue;
        const rowNo = i + 1;
        const formRaw = norm(r[fc.form] ?? '').replace(/\.0+$/, '');
        if (!/^\d+$/.test(formRaw)) { out.errors.push(`Forms row ${rowNo}: no valid form number (got “${formRaw}”).`); continue; }
        const lines = [];
        const linesRaw = linesCol >= 0 ? norm(r[linesCol] ?? '') : '';
        let bad = false;
        for (const part of linesRaw.split(/[,;\s]+/).filter(Boolean)) {
          const t = part.replace(/\.0+$/, '');
          if (!/^\d+$/.test(t) || parseInt(t, 10) < 1) { out.errors.push(`Forms row ${rowNo}: line “${part}” is not a number.`); bad = true; } else lines.push(parseInt(t, 10));
        }
        if (bad) continue;
        out.forms.push({ form_no: parseInt(formRaw, 10), name: nameCol >= 0 ? norm(r[nameCol] ?? '') : '', notes: notesCol >= 0 ? norm(r[notesCol] ?? '') : '', lines, hasName: nameCol >= 0, hasNotes: notesCol >= 0 });
      }
    }
  }
  if (!out.rows.length && !out.errors.length) out.warnings.push('The Fields sheet has no rows, so only the Forms sheet (if any) will be applied.');
  return out;
}

// ---------- plan ----------
// Compare the parsed template with the database. Nothing is written. opts.removeMissing: also take fields that are on a
// listed form but missing from the template off that form (stored values are kept either way).
function planTemplate(svc, parsed, opts = {}) {
  const plan = {
    errors: [...parsed.errors], warnings: [...parsed.warnings],
    summary: { formsAdded: 0, fieldsAdded: 0, fieldsChanged: 0, fieldsOnForms: 0, roleChanges: 0, removed: 0, sectionsAdded: 0, linesSet: 0 },
    sections: [], forms: [], fields: [], membership: [], lines: [],
    ops: { sections: [], forms: [], fields: [], membership: [], removals: [], lines: [], sequences: {} },
  };
  if (plan.errors.length) return plan;
  const dbFields = svc.getFields();
  const byKey = new Map(dbFields.map((f) => [f.key, f]));
  const sections = svc.getSections();
  const secByLabel = new Map(sections.map((s) => [lc(s.label), s]));
  const secByKey = new Map(sections.map((s) => [s.key, s]));
  const existingForms = new Map(svc.getForms().map((f) => [f.form_no, f]));
  const formFields = new Map();
  const fieldsOn = (n) => { if (!formFields.has(n)) formFields.set(n, existingForms.has(n) ? new Map(svc.getFormFields(n).map((f) => [f.key, f])) : new Map()); return formFields.get(n); };
  const usedKeys = new Set(byKey.keys());
  const planned = new Map(); // resolved key -> { key, isNew, attrs, first row }
  const newSections = [];
  const sectionFor = (label) => {
    if (!label) return null;
    const hit = secByLabel.get(lc(label)) || secByKey.get(label.toLowerCase());
    if (hit) return hit.key;
    if (!newSections.some((s) => lc(s) === lc(label))) newSections.push(label);
    return `new:${lc(label)}`;
  };

  for (const row of parsed.rows) {
    // 1) resolve which field this row is
    let existing = null; let key = row.key || '';
    if (key && byKey.has(key)) existing = byKey.get(key);
    else if (!key) {
      const here = [...fieldsOn(row.form_no).values()].find((f) => lc(f.label) === lc(row.label));
      const anywhere = dbFields.filter((f) => lc(f.label) === lc(row.label));
      existing = here || anywhere.find((f) => row.section && lc(secByKey.get(f.section)?.label || '') === lc(row.section)) || anywhere[0] || null;
      if (existing) key = existing.key;
    }
    if (!existing) {
      if (!key) {
        // the same new field on another form: one field, several forms
        const prior = [...planned.values()].find((q) => q.isNew && lc(q.attrs.label) === lc(row.label));
        if (prior) key = prior.key;
        else { const base = `x_${slug(row.label) || 'field'}`; key = base; let i = 2; while (usedKeys.has(key)) key = `${base}_${i++}`; }
      }
      usedKeys.add(key);
    }
    // 2) the field's attributes (first row that mentions a field wins; later rows are checked for disagreement)
    const secKey = row.section ? sectionFor(row.section) : (existing?.section || null);
    const attrs = {
      label: row.label, section: secKey, kind: existing && !row.kindGiven ? existing.kind : row.kind, unit: row.unit,
      has_sp: existing && !row.entryGiven ? existing.has_sp : row.has_sp, choices: row.choices, min: row.min, max: row.max,
    };
    // blank optional cells on a row matched by name (no Key) mean "unchanged"; on a keyed row (from an export) they mean "none"
    if (existing && !row.key) {
      if (!row.unit) attrs.unit = existing.unit || '';
      if (!row.choices) attrs.choices = existing.choices || '';
      if (!row.min) attrs.min = existing.min || '';
      if (!row.max) attrs.max = existing.max || '';
      attrs.label = existing.label;
    }
    if (!attrs.section) attrs.section = 'general'; // resolved below if the database has no such section
    let p = planned.get(key);
    if (!p) { p = { key, isNew: !existing, existing, attrs, rowNo: row.rowNo }; planned.set(key, p); }
    else {
      for (const k of ['kind', 'has_sp']) {
        if (String(p.attrs[k]) !== String(attrs[k]) && (k === 'kind' ? row.kindGiven : row.entryGiven)) plan.warnings.push(`“${row.label}” has a different ${k === 'kind' ? 'Type' : 'Entry'} on form ${row.form_no} (row ${row.rowNo}) than on row ${p.rowNo}. The first row is used.`);
      }
    }
    (plan.ops.sequences[row.form_no] = plan.ops.sequences[row.form_no] || []).push(key);
    // 3) membership
    const on = fieldsOn(row.form_no).get(key);
    const role = !row.roleGiven && on ? on.role : row.role;
    const m = { form_no: row.form_no, key, label: p.attrs.label, role, from: on ? on.role : null };
    m.action = !on ? 'add' : on.role !== role ? 'role' : 'same';
    plan.membership.push(m);
  }
  if (plan.errors.length) return plan;

  // sections: resolve placeholders to keys (created in the order they first appear)
  for (const label of newSections) plan.ops.sections.push(label);
  plan.sections = [...plan.ops.sections];
  plan.summary.sectionsAdded = plan.ops.sections.length;

  // fields
  for (const p of planned.values()) {
    const changes = [];
    if (p.existing) {
      const cur = p.existing;
      const was = (k) => String(cur[k] ?? '');
      const secLabelOf = (k) => (String(k).startsWith('new:') ? newSections.find((s) => `new:${lc(s)}` === k) : secByKey.get(k)?.label || k);
      if (p.attrs.label !== cur.label) changes.push({ what: 'Name', from: cur.label, to: p.attrs.label });
      if (p.attrs.section !== cur.section) changes.push({ what: 'Section', from: secLabelOf(cur.section), to: secLabelOf(p.attrs.section) });
      if (p.attrs.kind !== cur.kind) changes.push({ what: 'Type', from: T.label(cur.kind).split(' (')[0], to: T.label(p.attrs.kind).split(' (')[0] });
      if ((p.attrs.unit || '') !== was('unit')) changes.push({ what: 'Unit', from: was('unit'), to: p.attrs.unit });
      if (Number(p.attrs.has_sp) !== Number(cur.has_sp)) changes.push({ what: 'Entry', from: cur.has_sp ? 'Setting' : 'Reading', to: p.attrs.has_sp ? 'Setting' : 'Reading' });
      if ((p.attrs.choices || '') !== was('choices')) changes.push({ what: 'Options', from: was('choices').split('\n').join('; '), to: p.attrs.choices.split('\n').join('; ') });
      if ((p.attrs.min || '') !== was('min')) changes.push({ what: 'Min', from: was('min'), to: p.attrs.min });
      if ((p.attrs.max || '') !== was('max')) changes.push({ what: 'Max', from: was('max'), to: p.attrs.max });
      if (p.attrs.kind !== cur.kind) {
        const stored = svc.db.prepare("SELECT setpoint, actual FROM entry_values WHERE key=?").all(cur.key);
        const f2 = { kind: p.attrs.kind, choices: p.attrs.choices, min: p.attrs.min, max: p.attrs.max };
        const misfit = stored.filter((v) => [v.setpoint, v.actual].some((x) => !C.blank(x) && !T.parse(f2, x).ok)).length;
        if (misfit) plan.warnings.push(`“${cur.label}”: ${misfit} stored value${misfit === 1 ? '' : 's'} do not fit the new type ${T.label(p.attrs.kind).split(' (')[0]}. They are kept as they are, but new entries must fit.`);
      }
      if (changes.length) plan.summary.fieldsChanged++;
    } else plan.summary.fieldsAdded++;
    plan.fields.push({ key: p.key, label: p.attrs.label, isNew: p.isNew, status: p.isNew ? 'new' : changes.length ? 'changed' : 'same', changes, attrs: p.attrs, rowNo: p.rowNo });
    if (p.isNew || changes.length) plan.ops.fields.push({ key: p.key, isNew: p.isNew, attrs: p.attrs });
  }

  // forms
  const formNos = [...new Set([...parsed.rows.map((r) => r.form_no), ...parsed.forms.map((f) => f.form_no)])].sort((a, b) => a - b);
  for (const n of formNos) {
    const meta = parsed.forms.find((f) => f.form_no === n);
    const cur = existingForms.get(n);
    const item = { form_no: n, isNew: !cur, name: meta?.hasName ? meta.name : (cur?.name || ''), notes: meta?.hasNotes ? meta.notes : (cur?.notes || ''), changes: [] };
    if (cur) {
      if (meta?.hasName && meta.name !== (cur.name || '')) item.changes.push({ what: 'Name', from: cur.name, to: meta.name });
      if (meta?.hasNotes && meta.notes !== (cur.notes || '')) item.changes.push({ what: 'Notes', from: cur.notes, to: meta.notes });
    }
    if (!cur) plan.summary.formsAdded++;
    plan.forms.push(item);
    if (!cur || item.changes.length) plan.ops.forms.push({ form_no: n, name: item.name, notes: item.notes, isNew: !cur });
    for (const line of meta?.lines || []) {
      const curForm = svc.db.prepare('SELECT form_no FROM line_forms WHERE line=?').get(line)?.form_no;
      if (curForm === n) continue;
      plan.lines.push({ line, form_no: n, from: curForm ?? null });
      plan.ops.lines.push({ line, form_no: n });
      plan.summary.linesSet++;
    }
  }

  // membership + optional removals
  for (const m of plan.membership) {
    if (m.action === 'add') plan.summary.fieldsOnForms++;
    if (m.action === 'role') plan.summary.roleChanges++;
    if (m.action !== 'same') plan.ops.membership.push({ form_no: m.form_no, key: m.key, role: m.role });
  }
  if (opts.removeMissing) {
    const inTemplate = new Set(plan.membership.map((m) => `${m.form_no}|${m.key}`));
    for (const n of new Set(parsed.rows.map((r) => r.form_no))) {
      if (!existingForms.has(n)) continue;
      for (const f of fieldsOn(n).values()) {
        if (inTemplate.has(`${n}|${f.key}`)) continue;
        plan.ops.removals.push({ form_no: n, key: f.key });
        plan.membership.push({ form_no: n, key: f.key, label: f.label, role: f.role, from: f.role, action: 'remove' });
        plan.summary.removed++;
      }
    }
  }
  plan.changed = plan.summary.formsAdded + plan.summary.fieldsAdded + plan.summary.fieldsChanged + plan.summary.fieldsOnForms
    + plan.summary.roleChanges + plan.summary.removed + plan.summary.sectionsAdded + plan.summary.linesSet + plan.ops.forms.length;
  return plan;
}

// ---------- apply ----------
function applyPlan(svc, plan) {
  if (plan.errors.length) throw new Error('The template has errors; nothing was imported.');
  const db = svc.db;
  svc._tx(() => {
    const secMap = new Map(); // placeholder key -> real key
    for (const label of plan.ops.sections) secMap.set(`new:${lc(label)}`, svc.addSection(label).key);
    const fallback = () => (svc.getSections()[0] ? svc.getSections()[0].key : svc.addSection('General').key);
    const resolveSection = (k) => {
      if (secMap.has(k)) return secMap.get(k);
      if (svc._hasSection(k)) return k;
      return fallback();
    };
    for (const f of plan.ops.forms) {
      if (f.isNew) db.prepare('INSERT OR IGNORE INTO forms(form_no,name,notes) VALUES(?,?,?)').run(f.form_no, f.name, f.notes);
      else db.prepare('UPDATE forms SET name=?, notes=? WHERE form_no=?').run(f.name, f.notes, f.form_no);
    }
    let sort = db.prepare('SELECT MAX(sort) m FROM fields').get().m || 0;
    for (const f of plan.ops.fields) {
      const a = f.attrs; const section = resolveSection(a.section);
      if (f.isNew) {
        sort += 10;
        db.prepare('INSERT INTO fields(key,label,section,kind,unit,visible,sort,custom,has_sp,choices,min,max) VALUES(?,?,?,?,?,1,?,1,?,?,?,?)')
          .run(f.key, a.label, section, a.kind, a.unit || '', sort, a.has_sp ? 1 : 0, a.choices || '', a.min || '', a.max || '');
      } else {
        db.prepare('UPDATE fields SET label=?, section=?, kind=?, unit=?, has_sp=?, choices=?, min=?, max=? WHERE key=?')
          .run(a.label, section, a.kind, a.unit || '', a.has_sp ? 1 : 0, a.choices || '', a.min || '', a.max || '', f.key);
      }
    }
    // New fields take their place in the order the template lists them on each form; existing fields keep theirs.
    const newKeys = new Set(plan.ops.fields.filter((f) => f.isNew).map((f) => f.key));
    if (newKeys.size) {
      const order = db.prepare('SELECT key FROM fields ORDER BY sort, key').all().map((r) => r.key).filter((k) => !newKeys.has(k));
      for (const seq of Object.values(plan.ops.sequences)) {
        seq.forEach((k, i) => {
          if (!newKeys.has(k) || order.includes(k)) return;
          const prev = i > 0 ? order.indexOf(seq[i - 1]) : -1;
          if (prev >= 0) { order.splice(prev + 1, 0, k); return; }
          const nextKey = seq.slice(i + 1).find((x) => order.includes(x));
          if (nextKey) order.splice(order.indexOf(nextKey), 0, k); else order.push(k);
        });
      }
      order.forEach((k, i) => db.prepare('UPDATE fields SET sort=? WHERE key=?').run((i + 1) * 10, k));
    }
    for (const m of plan.ops.membership) {
      db.prepare('INSERT INTO form_fields(form_no,key,role) VALUES(?,?,?) ON CONFLICT(form_no,key) DO UPDATE SET role=excluded.role').run(m.form_no, m.key, m.role);
    }
    for (const r of plan.ops.removals) db.prepare('DELETE FROM form_fields WHERE form_no=? AND key=?').run(r.form_no, r.key);
    for (const l of plan.ops.lines) {
      db.prepare('INSERT INTO line_forms(line,form_no) VALUES(?,?) ON CONFLICT(line) DO UPDATE SET form_no=excluded.form_no').run(l.line, l.form_no);
    }
  });
  svc._cache = null;
  svc.audit('template-import', `${plan.summary.formsAdded} forms, ${plan.summary.fieldsAdded} new fields, ${plan.summary.fieldsChanged} changed, ${plan.summary.fieldsOnForms} added to forms, ${plan.summary.roleChanges} role changes, ${plan.summary.removed} removed, ${plan.summary.linesSet} lines`);
}

module.exports = { buildTemplate, assemble, fieldRow, parseTemplate, planTemplate, applyPlan, FIELD_HEADERS };
