'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readXlsx } = require('../app/main/export');
const { sheet10899, SHEET, FORM } = require('../scripts/templates-lib');
const { make, tmp } = require('./helpers');

const COMMITTED = path.join(__dirname, '..', 'templates', 'form-10899-2500T-setup-sheet.xlsx');
const write = (bytes) => { const f = path.join(tmp(), 't.xlsx'); fs.writeFileSync(f, bytes); return f; };

test('the 2500T sheet template lists every printed field once, in sheet order, on form 10899', () => {
  const { svc } = make();
  const rows = readXlsx(sheet10899(svc)).find((s) => s.name === 'Fields').rows.slice(1);
  assert.equal(rows.length, 42);
  assert.deepEqual(rows.map((r) => r[10]), SHEET.map((s) => s[0]));
  assert.equal(new Set(rows.map((r) => r[10])).size, 42);
  assert.ok(rows.every((r) => r[0] === String(FORM)));
  const labels = rows.map((r) => r[2]);
  for (const must of ['Billet temperature', 'Low reject temperature', 'Hi reject temperature', 'Scrap temperature', 'Billet length', 'Number of coils']) assert.ok(labels.includes(must), must);
  assert.ok(!labels.includes('Heater power'));
});

test('into today\'s app it changes only what the printed sheet adds: tongs yes/no, cool-down seconds, nitrogen PSI', () => {
  const { svc } = make();
  const plan = svc.previewTemplate(write(sheet10899(svc)));
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.summary, { formsAdded: 0, fieldsAdded: 0, fieldsChanged: 3, fieldsOnForms: 0, roleChanges: 0, removed: 0, sectionsAdded: 0, linesSet: 0 });
  assert.deepEqual(plan.fields.filter((f) => f.status === 'changed').map((f) => f.key).sort(), ['cool_down', 'leave_tongs', 'nitrogen']);
});

test('into an empty profile it builds the whole form, its sections and lines 5, 7, 9', () => {
  const { svc } = make();
  const file = write(sheet10899(svc));
  const fresh = make({ blank: true }).svc;
  fresh.applyTemplate(file);
  assert.equal(fresh.getFormFields(FORM).length, 42);
  assert.deepEqual(fresh.getLineForms().map((l) => l.line), [5, 7, 9]);
  const k = Object.fromEntries(fresh.getFields().map((f) => [f.label, f.key]));
  const r = fresh.saveEntry({ line: 9, part_no: '40-XXXX-01', noBackup: true, values: { [k['Billet temperature']]: { setpoint: '2300', actual: '2300' }, [k['Leave tongs in']]: { actual: 'yes' }, [k['Cool down']]: { actual: '1:30' } } });
  assert.equal(fresh.getEntry(r.id).values[k['Leave tongs in']].actual, 'Yes');
  assert.equal(fresh.getEntry(r.id).values[k['Cool down']].actual, '90');
});

test('the committed file is what the generator makes (run `npm run templates` after changing fields)', () => {
  const { svc } = make();
  const strip = (b) => readXlsx(b).map((s) => ({ name: s.name, rows: s.rows }));
  assert.deepEqual(strip(fs.readFileSync(COMMITTED)), strip(sheet10899(svc)));
});
