'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toXlsxBook, readXlsx } = require('../app/main/export');
const { FIELD_HEADERS } = require('../app/main/template');
const { make, entry, tmp } = require('./helpers');

const H = FIELD_HEADERS;
// Write a template workbook to disk. fieldRows: arrays in FIELD_HEADERS order (short rows are padded).
function book(fieldRows, formRows, name = 'tpl.xlsx') {
  const sheets = [{ name: 'Fields', headers: H, rows: fieldRows.map((r) => H.map((_, i) => r[i] ?? '')) }];
  if (formRows) sheets.push({ name: 'Forms', headers: ['Form', 'Name', 'Notes', 'Lines'], rows: formRows });
  const file = path.join(tmp(), name);
  fs.writeFileSync(file, toXlsxBook(sheets));
  return file;
}
const blankSvc = () => make({ blank: true }).svc;

test('exporting every form and importing it straight back changes nothing', () => {
  const { svc } = make();
  const file = path.join(tmp(), 'all.xlsx');
  fs.writeFileSync(file, svc.exportTemplate({ forms: 'all' }));
  const plan = svc.previewTemplate(file);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.changed, 0, JSON.stringify(plan.summary));
  assert.equal(plan.fields.filter((f) => f.status !== 'same').length, 0);
  assert.equal(plan.membership.filter((m) => m.action !== 'same').length, 0);
});

test('exported workbook has the expected sheets, headers, dropdown lists and one row per form field', () => {
  const { svc } = make();
  const sheets = readXlsx(svc.exportTemplate({ forms: [10880] }));
  assert.deepEqual(sheets.map((s) => s.name), ['Read me', 'Fields', 'Forms', 'Lists']);
  const f = sheets.find((s) => s.name === 'Fields');
  assert.deepEqual(f.rows[0], H);
  assert.equal(f.rows.length - 1, svc.getFormFields(10880).length);
  const row = f.rows.find((r) => r[2] === 'Billet temperature');
  assert.equal(row[0], '10880'); assert.equal(row[3], 'Number'); assert.equal(row[5], 'Setting'); assert.equal(row[6], 'Tracked'); assert.equal(row[10], 'billet_temp');
  const dp = f.rows.find((r) => r[10] === 'dousing_pump');
  assert.equal(dp[3], 'Rating'); assert.equal(dp[9], '5');
  const lists = sheets.find((s) => s.name === 'Lists').rows;
  assert.ok(lists.some((r) => r[0] === 'Yes / No') && lists.some((r) => r[0] === 'Time of day'));
});

test('blank template has headers and instructions but no field rows', () => {
  const { svc } = make();
  const sheets = readXlsx(svc.exportTemplate({ blank: true }));
  assert.equal(sheets.find((s) => s.name === 'Fields').rows.length, 1);
  assert.ok(sheets.find((s) => s.name === 'Read me').rows.some((r) => /Example/.test(r[0] || '')));
});

test('a new job: a blank profile gets its forms, sections, types and lines entirely from a template', () => {
  const svc = blankSvc();
  assert.equal(svc.getFields().length, 0);
  assert.equal(svc.getForms().length, 0);
  const file = book([
    [101, 'Heating', 'Furnace temp', 'Number', '°F', 'Setting', 'Tracked', '', '1800', '2400'],
    [101, 'Heating', 'Pump OK', 'Yes / No', '', 'Reading', 'Tracked'],
    [101, 'Setup', 'Grade', 'Choice', '', 'Setting', 'Set once', 'A; B; C'],
    [101, 'Quality', 'Surface finish', 'Rating', '', 'Reading', 'Tracked', '', '1', '5'],
    [101, 'Quality', 'Started at', 'Time of day', '', 'Reading'],
    [101, 'Quality', 'Cycle', 'Duration', 's', 'Reading'],
    [102, 'Heating', 'Furnace temp', 'Number', '°F', 'Setting', 'Tracked'],
  ], [[101, 'Furnace line', 'first form', '1, 2'], [102, 'Second furnace', '', '3']]);
  const plan = svc.previewTemplate(file);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.summary.formsAdded, 2);
  assert.equal(plan.summary.fieldsAdded, 6);          // Furnace temp is one field shared by both forms
  assert.equal(plan.summary.fieldsOnForms, 7);
  assert.deepEqual(plan.sections, ['Heating', 'Setup', 'Quality']);
  assert.equal(plan.summary.linesSet, 3);
  const res = svc.applyTemplate(file);
  assert.equal(res.applied, true);
  const byLabel = Object.fromEntries(svc.getFields().map((f) => [f.label, f]));
  assert.equal(byLabel['Furnace temp'].min, '1800'); assert.equal(byLabel['Furnace temp'].unit, '°F');
  assert.equal(byLabel['Pump OK'].kind, 'yesno'); assert.equal(byLabel['Pump OK'].has_sp, 0);
  assert.equal(byLabel.Grade.kind, 'choice'); assert.equal(byLabel.Grade.choices, 'A\nB\nC');
  assert.equal(byLabel['Surface finish'].kind, 'rating'); assert.equal(byLabel['Surface finish'].max, '5');
  assert.equal(byLabel['Started at'].kind, 'time');
  assert.equal(svc.getFormFields(101).find((f) => f.label === 'Grade').role, 'initial');
  assert.deepEqual(svc.getFormFields(102).map((f) => f.label), ['Furnace temp']);
  assert.deepEqual(svc.getLineForms().map((l) => [l.line, l.form_no]), [[1, 101], [2, 101], [3, 102]]);
  assert.deepEqual(svc.getSections().map((s) => s.label), ['General', 'Heating', 'Setup', 'Quality']);
  // and it is immediately usable
  const k = Object.fromEntries(svc.getFields().map((f) => [f.label, f.key]));
  const r = svc.saveEntry({ line: 1, part_no: 'X1', values: { [k['Furnace temp']]: { setpoint: '2000', actual: '2010' }, [k['Pump OK']]: { actual: 'ok' }, [k.Grade]: { actual: 'b' } }, noBackup: true });
  assert.ok(r.id);
  assert.equal(svc.getEntry(r.id).values[k.Grade].actual, 'B');
});

test('re-importing the same template is a no-op', () => {
  const svc = blankSvc();
  const file = book([[7, 'Main', 'Temp', 'Number', 'C', 'Setting', 'Tracked']], [[7, 'Seven', '', '1']]);
  svc.applyTemplate(file);
  const again = svc.applyTemplate(file);
  assert.equal(again.applied, false);
});

test('a keyed row renames and retypes the field; stored entries are untouched; misfit values are warned about', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { cycle_time: { actual: '12.5' } });
  const file = path.join(tmp(), 'edit.xlsx');
  const all = readXlsx(svc.exportTemplate({ forms: [10899] })).find((s) => s.name === 'Fields').rows;
  const edited = all.slice(1).map((r) => {
    if (r[10] === 'cycle_time') { r[2] = 'Cycle (renamed)'; r[3] = 'Rating'; r[4] = ''; r[8] = ''; r[9] = '5'; }
    if (r[10] === 'billet_temp') r[6] = 'Set once';
    return r;
  });
  fs.writeFileSync(file, toXlsxBook([{ name: 'Fields', headers: H, rows: edited }]));
  const plan = svc.previewTemplate(file);
  assert.deepEqual(plan.errors, []);
  const f = plan.fields.find((x) => x.key === 'cycle_time');
  assert.deepEqual(f.changes.map((c) => c.what).sort(), ['Max', 'Name', 'Type', 'Unit'].sort());
  assert.ok(plan.warnings.some((w) => /cycle/i.test(w) && /do not fit/.test(w)), plan.warnings.join('|'));
  assert.equal(plan.summary.roleChanges, 1);
  svc.applyTemplate(file);
  assert.equal(svc.getFields().find((x) => x.key === 'cycle_time').label, 'Cycle (renamed)');
  assert.equal(svc.getFormFields(10899).find((x) => x.key === 'billet_temp').role, 'initial');
  assert.equal(svc.getEntry(1).values.cycle_time.actual, '12.5'); // kept as it was
});

test('rows without a Key match by name; blank optional cells then leave the field as it is', () => {
  const { svc } = make();
  const file = book([[10880, 'Billet heating', 'Billet temperature', 'Number', '', 'Setting']]);
  const plan = svc.previewTemplate(file);
  const f = plan.fields.find((x) => x.key === 'billet_temp');
  assert.equal(f.status, 'same');
  assert.equal(plan.summary.fieldsAdded, 0);
});

test('fields missing from the template are only taken off the form when asked; values are kept', () => {
  const { svc } = make();
  const keep = svc.getFormFields(10880).find((f) => f.key === 'billet_temp');
  const file = book([[10880, 'Billet heating', 'Billet temperature', 'Number', '°F', 'Setting', 'Tracked', '', '', '', 'billet_temp']]);
  entry(svc, '2026-03-10T08:00', { shut_height: { actual: '14' } }, { line: 3 });
  const keepOnly = svc.previewTemplate(file);
  assert.equal(keepOnly.summary.removed, 0);
  const strict = svc.previewTemplate(file, { removeMissing: true });
  assert.ok(strict.summary.removed > 10);
  svc.applyTemplate(file, { removeMissing: true });
  assert.deepEqual(svc.getFormFields(10880).map((f) => f.key), [keep.key]);
  assert.equal(svc.db.prepare("SELECT COUNT(*) c FROM entry_values WHERE key='shut_height'").get().c, 1);
});

test('a template with problems reports every one with its row and applies nothing', () => {
  const svc = blankSvc();
  const file = book([
    ['', 'S', 'No form', 'Number'],
    [5, 'S', '', 'Number'],
    [5, 'S', 'Bad type', 'Quantum'],
    [5, 'S', 'Bad entry', 'Number', '', 'Maybe'],
    [5, 'S', 'Bad role', 'Number', '', 'Setting', 'Sometimes'],
    [5, 'S', 'Bad min', 'Number', '', 'Setting', 'Tracked', '', 'abc'],
    [5, 'S', 'Dup', 'Number'],
    [5, 'S', 'Dup', 'Number'],
    [5, 'S', 'Bad key', 'Number', '', 'Setting', 'Tracked', '', '', '', 'has space'],
  ], [['x', 'Bad form', '', '']]);
  const plan = svc.previewTemplate(file);
  assert.equal(plan.errors.length, 9, plan.errors.join('\n'));
  assert.ok(plan.errors.some((e) => /Fields row 2/.test(e)));
  assert.ok(plan.errors.some((e) => /Quantum/.test(e)));
  assert.ok(plan.errors.some((e) => /Forms row 2/.test(e)));
  assert.throws(() => svc.applyTemplate(file), /problems; nothing was imported/);
  assert.equal(svc.getFields().length, 0);
  assert.equal(svc.getForms().length, 0);
});

test('type names are forgiving: aliases, any case', () => {
  const svc = blankSvc();
  const file = book([
    [1, 'S', 'a', 'yes/no'], [1, 'S', 'b', 'TIME OF DAY'], [1, 'S', 'c', 'pick-list', '', '', '', 'x; y'], [1, 'S', 'd', 'scale', '', '', '', '', '', '10'],
    [1, 'S', 'e', 'x of y'], [1, 'S', 'f', 'timer'], [1, 'S', 'g', 'boolean'],
  ]);
  svc.applyTemplate(file);
  const kinds = Object.fromEntries(svc.getFields().map((f) => [f.label, f.kind]));
  assert.deepEqual(kinds, { a: 'yesno', b: 'time', c: 'choice', d: 'rating', e: 'ratio', f: 'duration', g: 'yesno' });
});

test('a workbook without a Fields sheet or Form column is refused with guidance', () => {
  const svc = blankSvc();
  const file = path.join(tmp(), 'odd.xlsx');
  fs.writeFileSync(file, toXlsxBook([{ name: 'Sheet1', headers: ['Foo', 'Bar'], rows: [[1, 2]] }]));
  assert.match(svc.previewTemplate(file).errors[0], /No “Fields” sheet/);
  const file2 = path.join(tmp(), 'odd2.xlsx');
  fs.writeFileSync(file2, toXlsxBook([{ name: 'Fields', headers: ['Field', 'Type'], rows: [['x', 'Number']] }]));
  assert.match(svc.previewTemplate(file2).errors.join(' '), /no “Form” column/);
  assert.throws(() => svc.previewTemplate(path.join(tmp(), 'missing.xlsx')), /not found/i);
  const notxl = path.join(tmp(), 'x.xlsx'); fs.writeFileSync(notxl, 'hello');
  assert.throws(() => svc.previewTemplate(notxl), /Not an Excel/);
});

test('applying takes a backup first and writes an audit line', () => {
  const svc = blankSvc();
  svc.applyTemplate(book([[1, 'S', 'a', 'Number']]));
  assert.ok(svc.listBackups().some((b) => b.reason === 'pre-template'));
  assert.ok(svc.getAudit().some((a) => a.action === 'template-import'));
});

test('a template exported from one profile loads into another and reproduces the same forms', () => {
  const { svc: src } = make();
  const file = path.join(tmp(), 'pack.xlsx');
  fs.writeFileSync(file, src.exportTemplate({ forms: 'all' }));
  const dst = blankSvc();
  dst.applyTemplate(file);
  for (const f of src.getForms()) {
    assert.deepEqual(dst.getFormFields(f.form_no).map((x) => [x.key, x.role, x.kind, x.label]), src.getFormFields(f.form_no).map((x) => [x.key, x.role, x.kind, x.label]));
  }
  assert.deepEqual(dst.getLineForms().map((l) => [l.line, l.form_no]), src.getLineForms().map((l) => [l.line, l.form_no]));
  assert.equal(dst.previewTemplate(file).changed, 0);
});
