'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SetupService } = require('../app/main/service');
const { make, entry, tmp } = require('./helpers');

test('first value is a baseline, later difference is a change; carry-forward skips blanks', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { billet_temp: { setpoint: '2250', actual: '2250' } });
  const r2 = entry(svc, '2026-03-11T08:00', { billet_temp: { setpoint: '2250', actual: '' }, nitrogen: { actual: '450' } });
  assert.equal(r2.changes, 0);
  // billet_temp blank on 03-11, so the comparison base is still 2250 from 03-10
  const r3 = entry(svc, '2026-03-12T08:00', { billet_temp: { setpoint: '2250', actual: '2275' } });
  assert.equal(r3.changes, 1);
  const rows = svc.listEntries({}).rows;
  assert.equal(rows.filter((e) => e.changed.billet_temp).length, 1);
  assert.deepEqual(rows.find((e) => e.changed.billet_temp).changed.billet_temp, { from: '2250', to: '2275' });
});

test('numeric equality: 2300 == 2300.0 is not a change', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { nitrogen: { actual: '2300' } });
  assert.equal(entry(svc, '2026-03-11T08:00', { nitrogen: { actual: '2300.0' } }).changes, 0);
});

test('readings are never change-tracked', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { ptp_time: { actual: '6.1' }, heat_no: { actual: 'H1' } });
  const r = entry(svc, '2026-03-11T08:00', { ptp_time: { actual: '9.9' }, heat_no: { actual: 'H2' } });
  assert.equal(r.changes, 0);
  assert.equal(svc.allChanges().length, 0);
});

test('changes are per Line+Part', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  const other = svc.saveEntry({ line: 5, part_no: 'P-2', entry_ts: '2026-03-11T08:00', values: { nitrogen: { actual: '999' } }, noBackup: true });
  assert.equal(other.changes, 0);
});

test('latestValues carries forward last non-blank actual and setpoint', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { nitrogen: { setpoint: '450', actual: '452' } });
  entry(svc, '2026-03-11T08:00', { nitrogen: { setpoint: '', actual: '' }, shut_height: { actual: '14' } });
  const l = svc.latestValues(5, 'P-1');
  assert.equal(l.nitrogen.actual, '452');
  assert.equal(l.nitrogen.setpoint, '450');
  assert.equal(l.shut_height.actual, '14');
});

test('saveEntry validates', () => {
  const { svc } = make();
  assert.throws(() => svc.saveEntry({ line: 5, part_no: '', values: { nitrogen: { actual: '1' } } }), /Part No/);
  assert.throws(() => svc.saveEntry({ line: 99, part_no: 'X', values: { nitrogen: { actual: '1' } } }), /not configured/);
  assert.throws(() => svc.saveEntry({ line: 5, part_no: 'X', values: {} }), /Nothing to save/);
});

test('entries are append-only; notes edits are audit-logged', () => {
  const { svc } = make();
  const { id } = entry(svc, '2026-03-10T08:00', { nitrogen: { actual: '450' } }, { notes: 'first' });
  svc.updateNotes(id, 'second');
  assert.equal(svc.getEntry(id).notes, 'second');
  const a = svc.getAudit().find((x) => x.action === 'notes-edit');
  assert.match(a.detail, /first.*second/);
  assert.equal(svc.listEntries({}).total, 1);
});

test('drift: N in a row raises an alert, ack hides it until a newer drifting entry', () => {
  const { svc } = make();
  for (const d of ['10', '11']) entry(svc, `2026-03-${d}T08:00`, { lube_concentration: { setpoint: '60', actual: '66' } });
  assert.equal(svc.driftAlerts().length, 0); // 2 < default 3
  entry(svc, '2026-03-12T08:00', { lube_concentration: { setpoint: '60', actual: '66' } });
  const [a] = svc.driftAlerts();
  assert.equal(a.key, 'lube_concentration');
  assert.equal(a.streak, 3);
  svc.ackDrift(5, 'P-1', 'lube_concentration');
  assert.equal(svc.driftAlerts().length, 0);
  entry(svc, '2026-03-13T08:00', { lube_concentration: { setpoint: '60', actual: '67' } });
  assert.equal(svc.driftAlerts().length, 1);
});

test('drift: a matching entry breaks the streak; N is configurable; option can be off', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { lube_concentration: { setpoint: '60', actual: '66' } });
  entry(svc, '2026-03-11T08:00', { lube_concentration: { setpoint: '60', actual: '60' } });
  entry(svc, '2026-03-12T08:00', { lube_concentration: { setpoint: '60', actual: '66' } });
  assert.equal(svc.driftAlerts().length, 0);
  svc.setSettings({ drift_n: '2' });
  entry(svc, '2026-03-13T08:00', { lube_concentration: { setpoint: '60', actual: '66' } });
  assert.equal(svc.driftAlerts().length, 1);
  svc.setSettings({ opt_drift: '0' });
  assert.equal(svc.driftAlerts().length, 0);
});

test('dashboard: missing-entry tracking is optional and counts lines without an entry today', () => {
  const { svc } = make();
  entry(svc, '2026-03-18T07:00', { nitrogen: { actual: '450' } });
  assert.equal(svc.dashboard().notLoggedToday, null);
  svc.setSettings({ opt_missing: '1' });
  const d = svc.dashboard();
  assert.equal(d.notLoggedToday, 7); // 7 default lines, only L5 logged
  assert.equal(d.entriesThisWeek, 1);
});

test('fields: hide, rename, custom add/delete; form-specific fields', () => {
  const { svc } = make();
  svc.updateField('nitrogen', { label: 'Die temperature', visible: false });
  const f = svc.getFields().find((x) => x.key === 'nitrogen');
  assert.equal(f.label, 'Die temperature'); assert.equal(f.visible, 0);
  svc.addField({ label: 'Coolant ppm', has_sp: false });
  const custom = svc.getFields().find((x) => x.custom);
  assert.equal(custom.key, 'x_coolant_ppm'); assert.equal(custom.has_sp, 0);
  assert.throws(() => svc.deleteField('nitrogen'), /custom/);
  svc.deleteField('x_coolant_ppm');
  const l3 = svc.fieldsForForm(10880).map((x) => x.key);
  assert.ok(l3.includes('coil2_amps')); assert.ok(!l3.includes('coil3_amps')); assert.ok(!l3.includes('capacitance'));
  const l1 = svc.fieldsForForm(10900).map((x) => x.key);
  assert.ok(l1.includes('capacitance')); assert.ok(!l1.includes('coil1_amps'));
  const l11 = svc.fieldsForForm(10903).map((x) => x.key);
  assert.ok(l11.includes('coil5_amps') && l11.includes('gripper_size'));
});

test('default line → form mapping', () => {
  const { svc } = make();
  const m = Object.fromEntries(svc.getLineForms().map((l) => [l.line, l.form_no]));
  assert.deepEqual(m, { 1: 10900, 2: 10903, 3: 10880, 4: 10880, 5: 10899, 7: 10899, 9: 10899, 11: 10903 });
});

test('list is sorted by line then part, newest first', () => {
  const { svc } = make();
  svc.saveEntry({ line: 7, part_no: 'B', entry_ts: '2026-03-10T08:00', values: { nitrogen: { actual: '1' } }, noBackup: true });
  svc.saveEntry({ line: 1, part_no: 'B', entry_ts: '2026-03-10T08:00', values: { nitrogen: { actual: '1' } }, noBackup: true });
  svc.saveEntry({ line: 1, part_no: 'A', entry_ts: '2026-03-09T08:00', values: { nitrogen: { actual: '1' } }, noBackup: true });
  svc.saveEntry({ line: 1, part_no: 'A', entry_ts: '2026-03-11T08:00', values: { nitrogen: { actual: '1' } }, noBackup: true });
  const order = svc.listEntries({}).rows.map((e) => `${e.line}${e.part_no}${e.entry_ts.slice(8, 10)}`);
  assert.deepEqual(order, ['1A11', '1A09', '1B10', '7B10']);
});

test('migration v2 -> v5 keeps data, adds columns/tables, backs up first', () => {
  const dir = tmp();
  const dbPath = path.join(dir, 'setups.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE fields(key TEXT PRIMARY KEY, label TEXT NOT NULL, section TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'number', unit TEXT DEFAULT '', visible INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, custom INTEGER NOT NULL DEFAULT 0, has_sp INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE parts(line INTEGER NOT NULL, part_no TEXT NOT NULL, PRIMARY KEY(line, part_no));
    CREATE TABLE entries(id INTEGER PRIMARY KEY AUTOINCREMENT, line INTEGER NOT NULL, part_no TEXT NOT NULL, entry_ts TEXT NOT NULL, entered_by TEXT DEFAULT '', sheet_rev TEXT DEFAULT '', sheet_revised TEXT DEFAULT '', hmi_file TEXT DEFAULT '', notes TEXT DEFAULT '', source TEXT DEFAULT 'manual');
    CREATE TABLE entry_values(entry_id INTEGER NOT NULL, key TEXT NOT NULL, setpoint TEXT, actual TEXT, PRIMARY KEY(entry_id, key));
    CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user TEXT DEFAULT '', action TEXT NOT NULL, detail TEXT DEFAULT '');
    CREATE TABLE line_forms(line INTEGER PRIMARY KEY, form_no INTEGER NOT NULL);
    INSERT INTO fields(key,label,section,kind,unit,visible,sort,custom,has_sp) VALUES('nitrogen','Die temp','press','number','F',1,10,0,1);
    INSERT INTO line_forms VALUES(5,10899);
    INSERT INTO entries(line,part_no,entry_ts,notes) VALUES(5,'P-1','2026-03-10T08:00','old note');
    INSERT INTO entry_values VALUES(1,'nitrogen','450','452');
    PRAGMA user_version = 2;`);
  db.close();
  const svc = new SetupService({ dataDir: dir, now: () => new Date('2026-03-18T12:00:00') });
  assert.equal(svc.db.prepare('PRAGMA user_version').get().user_version, 5);
  const e = svc.getEntry(1);
  assert.equal(e.notes, 'old note'); assert.equal(e.values.nitrogen.actual, '452'); assert.equal(e.reason, '');
  assert.equal(e.voided, 0); assert.equal(e.void_reason, ''); assert.equal(svc.listEntries({}).total, 1);
  assert.ok(svc.db.prepare('PRAGMA table_info(fields)').all().some((c) => c.name === 'choices'));
  assert.ok(svc.db.prepare("SELECT 1 FROM sqlite_master WHERE name='drift_ack'").get());
  assert.ok(svc.listBackups().some((b) => b.reason === 'pre-migrate'));
  assert.deepEqual(svc.getForms().map((f) => f.form_no), [10880, 10899, 10900, 10903]);
  svc.close();
});

test('backup → modify → restore round trip, with safety copy and integrity check', () => {
  const { svc, dataDir } = make();
  entry(svc, '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  const bak = svc.backupNow('manual', true);
  assert.ok(fs.existsSync(bak));
  assert.equal(svc.integrityCheck(bak).ok, true);
  entry(svc, '2026-03-11T08:00', { nitrogen: { actual: '460' } });
  assert.equal(svc.listEntries({}).total, 2);
  const r = svc.restore(bak);
  assert.equal(svc.listEntries({}).total, 1);
  assert.ok(r.safety && fs.existsSync(r.safety)); // pre-restore copy still has both entries
  const check = new DatabaseSync(r.safety, { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) c FROM entries').get().c, 2);
  check.close();
  assert.ok(svc.getAudit().some((a) => a.action === 'restore'));
  assert.ok(fs.existsSync(dataDir));
});

test('restore rejects corrupt / foreign files and leaves data untouched', () => {
  const { svc, dataDir } = make();
  entry(svc, '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  const junk = path.join(dataDir, 'junk.db');
  fs.writeFileSync(junk, 'not a database at all');
  assert.throws(() => svc.restore(junk));
  const foreign = path.join(dataDir, 'foreign.db');
  const f = new DatabaseSync(foreign); f.exec('CREATE TABLE x(a)'); f.close();
  assert.throws(() => svc.restore(foreign), /Not a Setup Tracker/);
  assert.equal(svc.listEntries({}).total, 1);
});

test('auto backup is throttled to once per 5 minutes; keeps newest 100', () => {
  let t = new Date('2026-03-18T12:00:00').getTime();
  const { svc } = make({ now: () => new Date(t) });
  assert.ok(svc.backupNow('auto', false));
  t += 60 * 1000;
  assert.equal(svc.backupNow('auto', false), null);
  t += 5 * 60 * 1000;
  assert.ok(svc.backupNow('auto', false));
  for (let i = 0; i < 105; i++) { t += 6 * 60 * 1000; svc.backupNow('bulk', true); }
  assert.ok(svc.listBackups().length <= 100);
});

test('photos are copied into the photos folder and mirrored into backups', () => {
  const { svc, dataDir } = make();
  const src = path.join(dataDir, 'sheet.jpg'); fs.writeFileSync(src, 'jpegbytes');
  const { id } = entry(svc, '2026-03-10T08:00', { nitrogen: { actual: '450' } }, { photo_src: src });
  const name = svc.getEntry(id).photo_path;
  assert.ok(name && fs.existsSync(svc.photoPath(name)));
  svc.backupNow('manual', true);
  assert.ok(fs.existsSync(path.join(svc.backupDir, 'photos', name)));
});

test('import: v3-style DB brings entries over, skips duplicates, adds custom fields', () => {
  const { svc } = make();
  const dir = tmp(); const p = path.join(dir, 'v3.db');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE fields(key TEXT PRIMARY KEY, label TEXT, section TEXT, kind TEXT, unit TEXT, visible INTEGER, sort INTEGER, custom INTEGER, has_sp INTEGER);
    CREATE TABLE entries(id INTEGER PRIMARY KEY, line INTEGER, part_no TEXT, entry_ts TEXT, entered_by TEXT, sheet_rev TEXT, sheet_revised TEXT, hmi_file TEXT, notes TEXT, source TEXT);
    CREATE TABLE entry_values(entry_id INTEGER, key TEXT, setpoint TEXT, actual TEXT);
    CREATE TABLE line_forms(line INTEGER PRIMARY KEY, form_no INTEGER);
    INSERT INTO fields VALUES('x_coolant','Coolant','custom','number','',1,500,1,1);
    INSERT INTO line_forms VALUES(5,10899);
    INSERT INTO entries VALUES(1,5,'P-9','2026-03-01T08:00','Joe','A','','H1','n','manual');
    INSERT INTO entry_values VALUES(1,'x_coolant','5','6');`);
  db.close();
  const r1 = svc.importDatabase(p);
  assert.deepEqual(r1, { added: 1, skipped: 0, newFields: 1 });
  const r2 = svc.importDatabase(p);
  assert.deepEqual(r2, { added: 0, skipped: 1, newFields: 0 });
  const e = svc.listEntries({ part: 'P-9' }).rows[0];
  assert.equal(e.values.x_coolant.actual, '6'); assert.equal(e.source, 'import');
  assert.throws(() => svc.importDatabase(path.join(dir, 'nope.db')), /not found/i);
});

test('sample data loads, produces changes + drift, and can be removed', () => {
  const { svc } = make();
  const { added } = svc.loadSampleData();
  assert.ok(added > 100);
  assert.ok(svc.allChanges().length > 0);
  assert.ok(svc.driftAlerts().length > 0);
  const own = entry(svc, '2026-03-17T08:00', { nitrogen: { actual: '1' } });
  svc.removeSampleData();
  assert.equal(svc.listEntries({}).total, 1);
  assert.ok(svc.getEntry(own.id));
});

test('trend and compare series', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { billet_temp: { setpoint: '2250', actual: '2251' } });
  entry(svc, '2026-03-11T08:00', { billet_temp: { setpoint: '2250', actual: '2260' } });
  svc.saveEntry({ line: 7, part_no: 'Q', entry_ts: '2026-03-11T09:00', values: { billet_temp: { actual: '2240' } }, noBackup: true });
  const t = svc.trend({ line: 5, part: 'P-1', key: 'billet_temp' });
  assert.deepEqual(t.points.map((p) => p.actual), [2251, 2260]);
  assert.equal(t.points[0].setpoint, 2250);
  const c = svc.compareTrend({ key: 'billet_temp' });
  assert.deepEqual(c.series.map((s) => s.line), [5, 7]);
});
