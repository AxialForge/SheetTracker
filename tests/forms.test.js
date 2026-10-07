'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SetupService } = require('../app/main/service');
const { make, entry, tmp } = require('./helpers');

const keys = (svc, form) => svc.getFormFields(form).map((f) => f.key);

test('default forms carry exactly the fields they always had, all tracked', () => {
  const { svc } = make();
  assert.deepEqual(svc.getForms().map((f) => f.form_no), [10880, 10899, 10900, 10903]);
  const l3 = keys(svc, 10880);
  assert.ok(l3.includes('coil2_amps') && !l3.includes('coil3_amps') && !l3.includes('capacitance'));
  const l11 = keys(svc, 10903);
  assert.ok(l11.includes('coil5_amps') && l11.includes('gripper_size') && l11.includes('billet_temp'));
  assert.ok(svc.getFormFields(10899).every((f) => f.role === 'tracked'));
  assert.deepEqual(svc.fieldsForForm(10900).map((f) => f.key), keys(svc, 10900));
  const f = svc.getForms().find((x) => x.form_no === 10899);
  assert.deepEqual(f.lines, [5, 7, 9]);
  assert.equal(f.initial, 0);
  assert.ok(f.tracked > 10);
});

test('add / remove a field on one form, change its role; other forms and stored values are untouched', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { die_temp: { actual: '450' } });
  svc.removeFormField(10899, 'die_temp');
  assert.ok(!keys(svc, 10899).includes('die_temp'));
  assert.ok(keys(svc, 10880).includes('die_temp'));
  assert.equal(svc.getEntry(1).values.die_temp.actual, '450'); // history survives
  svc.setFormField(10899, 'die_temp', 'initial');
  assert.equal(svc.getFormFields(10899).find((f) => f.key === 'die_temp').role, 'initial');
  svc.setFormField(10899, 'die_temp', 'tracked');
  assert.equal(svc.getFormFields(10899).find((f) => f.key === 'die_temp').role, 'tracked');
  assert.throws(() => svc.setFormField(10899, 'nope', 'tracked'), /Unknown field/);
  assert.throws(() => svc.setFormField(10899, 'die_temp', 'sometimes'), /Role/);
  assert.throws(() => svc.setFormField(99999, 'die_temp', 'tracked'), /does not exist/);
  assert.ok(svc.getAudit().some((a) => a.action === 'form-field-remove'));
});

test('addField attaches to all forms by default, or only the forms given, with a role', () => {
  const { svc } = make();
  svc.addField({ label: 'Coolant ppm', has_sp: false });
  for (const n of [10880, 10899, 10900, 10903]) assert.ok(keys(svc, n).includes('x_coolant_ppm'));
  svc.addField({ label: 'Die serial', kind: 'text', has_sp: false, forms: [10900], role: 'initial' });
  assert.ok(keys(svc, 10900).includes('x_die_serial'));
  assert.ok(!keys(svc, 10880).includes('x_die_serial'));
  assert.equal(svc.getFormFields(10900).find((f) => f.key === 'x_die_serial').role, 'initial');
  assert.throws(() => svc.addField({ label: 'X', forms: [12345] }), /does not exist/);
  assert.throws(() => svc.addField({ label: 'X', section: 'nowhere' }), /Unknown section/);
  svc.deleteField('x_die_serial');
  assert.ok(!keys(svc, 10900).includes('x_die_serial'));
  assert.equal(svc.db.prepare("SELECT COUNT(*) c FROM form_fields WHERE key='x_die_serial'").get().c, 0);
});

test('updateField can change type, setting/reading and section, and validates', () => {
  const { svc } = make();
  svc.updateField('die_temp', { kind: 'text', has_sp: false, section: 'heat', unit: 'F' });
  const f = svc.getFields().find((x) => x.key === 'die_temp');
  assert.deepEqual([f.kind, f.has_sp, f.section, f.unit], ['text', 0, 'heat', 'F']);
  assert.throws(() => svc.updateField('die_temp', { kind: 'blob' }), /Type/);
  assert.throws(() => svc.updateField('die_temp', { section: 'nowhere' }), /Unknown section/);
});

test('addForm: validates, can start empty or copy another form (roles included)', () => {
  const { svc } = make();
  svc.setFormField(10899, 'die_temp', 'initial');
  svc.addForm({ form_no: 10950, name: 'New press form' });
  assert.deepEqual(keys(svc, 10950), []);
  svc.addForm({ form_no: 10951, copyFrom: 10899 });
  assert.deepEqual(keys(svc, 10951), keys(svc, 10899));
  assert.equal(svc.getFormFields(10951).find((f) => f.key === 'die_temp').role, 'initial');
  assert.equal(svc.getForms().find((f) => f.form_no === 10950).name, 'New press form');
  assert.throws(() => svc.addForm({ form_no: 10899 }), /already exists/);
  assert.throws(() => svc.addForm({ form_no: 'abc' }), /number/);
  assert.throws(() => svc.addForm({ form_no: 10952, copyFrom: 777 }), /does not exist/);
});

test('updateForm edits name and notes', () => {
  const { svc } = make();
  svc.updateForm(10880, { name: ' Small press ', notes: 'two coils' });
  const f = svc.getForms().find((x) => x.form_no === 10880);
  assert.equal(f.name, 'Small press'); assert.equal(f.notes, 'two coils');
  assert.throws(() => svc.updateForm(1, { name: 'x' }), /does not exist/);
});

test('renameForm moves field list and line mapping; refuses a number already in use', () => {
  const { svc } = make();
  const before = keys(svc, 10880);
  svc.renameForm(10880, 10881);
  assert.ok(!svc.getForms().some((f) => f.form_no === 10880));
  assert.deepEqual(keys(svc, 10881), before);
  assert.equal(svc.formFor(3), 10881); assert.equal(svc.formFor(4), 10881);
  assert.throws(() => svc.renameForm(10881, 10899), /already exists/);
  assert.throws(() => svc.renameForm(10881, 0), /number/);
  assert.ok(svc.getAudit().some((a) => a.action === 'form-renumber'));
});

test('deleteForm is refused while a line uses it, allowed after re-mapping, and keeps entries', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { die_temp: { actual: '450' } });
  assert.throws(() => svc.deleteForm(10899), /used by lines 5, 7, 9/);
  svc.setLineForm(5, 10880); svc.setLineForm(7, 10880); svc.setLineForm(9, 10880);
  svc.deleteForm(10899);
  assert.ok(!svc.getForms().some((f) => f.form_no === 10899));
  assert.equal(svc.db.prepare('SELECT COUNT(*) c FROM form_fields WHERE form_no=10899').get().c, 0);
  assert.equal(svc.listEntries({}).total, 1);
});

test('mapping a line to a form that does not exist yet creates it with the default fields', () => {
  const { svc } = make();
  svc.setLineForm(2, 10990);
  assert.ok(svc.getForms().some((f) => f.form_no === 10990));
  const k = keys(svc, 10990);
  assert.ok(k.includes('die_temp') && k.includes('heat_no') && !k.includes('coil1_amps'));
  assert.deepEqual(svc.fieldsForForm(10990).map((f) => f.key), k);
});

test('migration v3 -> v4 seeds forms from the old built-in rules and backs up first', () => {
  const dir = tmp();
  const a = new SetupService({ dataDir: dir, now: () => new Date('2026-03-18T12:00:00') });
  a.addField({ label: 'Coolant ppm', has_sp: false });
  const expect = Object.fromEntries(a.getForms().map((f) => [f.form_no, keys(a, f.form_no)]));
  a.close();
  const db = new DatabaseSync(path.join(dir, 'setups.db'));
  db.exec('DROP TABLE form_fields; DROP TABLE forms; PRAGMA user_version = 3;');
  db.close();
  const b = new SetupService({ dataDir: dir, now: () => new Date('2026-03-18T12:00:00') });
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.deepEqual(Object.fromEntries(b.getForms().map((f) => [f.form_no, keys(b, f.form_no)])), expect);
  assert.ok(b.listBackups().some((x) => x.reason === 'pre-migrate'));
  b.close();
});

test('import: imported custom fields join existing forms and imported line forms are created', () => {
  const { svc } = make();
  const dir = tmp(); const p = path.join(dir, 'v3.db');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE fields(key TEXT PRIMARY KEY, label TEXT, section TEXT, kind TEXT, unit TEXT, visible INTEGER, sort INTEGER, custom INTEGER, has_sp INTEGER);
    CREATE TABLE entries(id INTEGER PRIMARY KEY, line INTEGER, part_no TEXT, entry_ts TEXT, entered_by TEXT, sheet_rev TEXT, sheet_revised TEXT, hmi_file TEXT, notes TEXT, source TEXT);
    CREATE TABLE entry_values(entry_id INTEGER, key TEXT, setpoint TEXT, actual TEXT);
    CREATE TABLE line_forms(line INTEGER PRIMARY KEY, form_no INTEGER);
    INSERT INTO fields VALUES('x_coolant','Coolant','custom','number','',1,500,1,1);
    INSERT INTO line_forms VALUES(2,10777);`);
  db.close();
  svc.importDatabase(p);
  for (const n of [10880, 10899, 10900, 10903, 10777]) assert.ok(keys(svc, n).includes('x_coolant'), `form ${n}`);
  assert.equal(svc.formFor(2), 10777);
});
