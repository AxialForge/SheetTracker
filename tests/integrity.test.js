'use strict';
// v0.2.0 data-integrity rules: part numbers, text values, voiding and correcting entries.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SetupService } = require('../app/main/service');
const C = require('../app/shared/compare');
const { make, entry, tmp } = require('./helpers');

const save = (svc, part, ts, values, extra = {}) => svc.saveEntry({ line: 5, part_no: part, entry_ts: ts, values, noBackup: true, ...extra });

// ---- text values (Major #4)

test('compare: text ignores case, edge spaces and runs of inner spaces', () => {
  assert.equal(C.norm('  Dummy   die  '), 'Dummy die');
  assert.equal(C.changed('DUMMY', 'Dummy '), false);
  assert.equal(C.changed('Station  1', 'station 1'), false);
  assert.equal(C.changed('DUMMY', 'Forge'), true);
  assert.equal(C.changed('2300', '2300.0'), false);
});

test('saving text tidies spacing and reuses the spelling already on record', () => {
  const { svc } = make();
  const a = save(svc, 'P-1', '2026-03-10T08:00', { station1_label: { setpoint: 'DUMMY', actual: 'DUMMY' } });
  assert.equal(a.changes, 0);
  const b = save(svc, 'P-1', '2026-03-11T08:00', { station1_label: { setpoint: 'DUMMY', actual: ' Dummy  ' } });
  assert.equal(b.changes, 0);
  const row = svc.getEntry(b.id).values.station1_label;
  assert.equal(row.actual, 'DUMMY'); // not 'Dummy'
  assert.equal(svc.allChanges().length, 0);
  const c = save(svc, 'P-1', '2026-03-12T08:00', { station1_label: { actual: 'Forge' } });
  assert.equal(c.changes, 1);
});

test('readings keep the case they were typed in (only spacing is tidied)', () => {
  const { svc } = make();
  const { id } = save(svc, 'P-1', '2026-03-10T08:00', { heat_no: { actual: ' ab12   x ' } });
  assert.equal(svc.getEntry(id).values.heat_no.actual, 'ab12   x'.replace(/\s+/g, ' '));
});

test('pick-lists: stored on the field, listed first, and set the canonical spelling', () => {
  const { svc } = make();
  svc.updateField('lube_program', { choices: 'Standard; Heavy ;standard\nLight' });
  assert.equal(svc.getFields().find((f) => f.key === 'lube_program').choices, 'Standard\nHeavy\nLight');
  const { id } = save(svc, 'P-1', '2026-03-10T08:00', { lube_program: { actual: 'heavy' } });
  assert.equal(svc.getEntry(id).values.lube_program.actual, 'Heavy');
  save(svc, 'P-1', '2026-03-11T08:00', { lube_program: { actual: 'Custom A' } });
  const s = svc.valueSuggestions().lube_program;
  assert.deepEqual(s.slice(0, 3), ['Standard', 'Heavy', 'Light']);
  assert.ok(s.includes('Custom A'));
  assert.equal(svc.valueSuggestions().nitrogen, undefined); // numbers get no list
});

// ---- part numbers (Major #3)

test('saving reuses the existing spelling of a part on that line', () => {
  const { svc } = make();
  save(svc, 'AB-100', '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  const r = save(svc, ' ab-100 ', '2026-03-11T08:00', { nitrogen: { actual: '460' } });
  assert.equal(svc.getEntry(r.id).part_no, 'AB-100');
  assert.equal(r.changes, 1); // same part, so the change is seen
  assert.deepEqual(svc.listParts(5), ['AB-100']);
});

test('checkPart: existing, new, near-miss and other-line hits', () => {
  const { svc } = make();
  save(svc, 'AB-100', '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  svc.saveEntry({ line: 7, part_no: 'ZZ-9', entry_ts: '2026-03-10T09:00', values: { nitrogen: { actual: '1' } }, noBackup: true });
  assert.deepEqual(svc.checkPart(5, 'ab-100'), { exists: true, canonical: 'AB-100', similar: [], otherLines: [] });
  const typo = svc.checkPart(5, 'AB-101');
  assert.equal(typo.exists, false);
  assert.deepEqual(typo.similar.map((s) => s.part_no), ['AB-100']);
  assert.equal(typo.similar[0].entries, 1);
  assert.equal(svc.checkPart(5, 'AB 100x').similar.length, 1); // punctuation and spacing ignored, one extra character
  assert.equal(svc.checkPart(5, 'QQ-555').similar.length, 0);
  assert.deepEqual(svc.checkPart(5, 'zz-9').otherLines, [{ line: 7, entries: 1 }]);
  assert.equal(svc.checkPart(5, '').exists, false);
});

test('renamePart moves the history; renaming onto an existing part merges and recomputes changes', () => {
  const { svc } = make();
  save(svc, 'AB-100', '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  save(svc, 'AB-1OO', '2026-03-11T08:00', { nitrogen: { actual: '470' } }); // typo with letter O
  assert.equal(svc.allChanges().length, 0); // two parts, two baselines: the change was invisible
  const r = svc.renamePart(5, 'AB-1OO', 'AB-100');
  assert.deepEqual(r, { moved: 1, merged: true, part_no: 'AB-100' });
  assert.deepEqual(svc.listParts(5), ['AB-100']);
  const [c] = svc.allChanges();
  assert.deepEqual([c.from, c.to], ['450', '470']);
  assert.match(svc.getAudit().find((a) => a.action === 'part-merge').detail, /AB-1OO -> AB-100 \(1 entry\)/);
});

test('renamePart: plain rename, case-only rename, errors', () => {
  const { svc } = make();
  save(svc, 'old', '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  assert.deepEqual(svc.renamePart(5, 'old', 'OLD'), { moved: 1, merged: false, part_no: 'OLD' });
  assert.deepEqual(svc.listParts(5), ['OLD']);
  assert.deepEqual(svc.renamePart(5, 'OLD', 'NEW-1'), { moved: 1, merged: false, part_no: 'NEW-1' });
  assert.equal(svc.listEntries({}).rows[0].part_no, 'NEW-1');
  assert.throws(() => svc.renamePart(5, 'nope', 'X'), /not found/);
  assert.throws(() => svc.renamePart(5, 'NEW-1', '  '), /required/);
});

// ---- voiding and correcting (Major #6)

test('void needs a reason, hides the entry from change detection, and is audit-logged', () => {
  const { svc } = make();
  save(svc, 'P-1', '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  const bad = save(svc, 'P-1', '2026-03-11T08:00', { nitrogen: { actual: '4500' } }); // typo
  save(svc, 'P-1', '2026-03-12T08:00', { nitrogen: { actual: '450' } });
  assert.equal(svc.allChanges().length, 2); // 450 -> 4500 -> 450
  assert.throws(() => svc.voidEntry(bad.id, '  '), /reason/);
  svc.voidEntry(bad.id, 'Typo: extra zero');
  assert.equal(svc.allChanges().length, 0); // 450 -> 450
  assert.equal(svc.listEntries({}).total, 2);
  const withVoided = svc.listEntries({ includeVoided: true });
  assert.equal(withVoided.total, 3);
  const v = withVoided.rows.find((e) => e.id === bad.id);
  assert.equal(v.voided, 1); assert.equal(v.void_reason, 'Typo: extra zero'); assert.deepEqual(v.changed, {});
  assert.equal(svc.latestValues(5, 'P-1').nitrogen.actual, '450');
  assert.match(svc.getAudit().find((a) => a.action === 'entry-void').detail, /Typo: extra zero/);
  assert.throws(() => svc.voidEntry(bad.id, 'again'), /already voided/);
  assert.throws(() => svc.voidEntry(9999, 'x'), /not found/);
});

test('voided entries are left out of exports, drift, trends, dashboard counts and parts', () => {
  const { svc } = make();
  for (const d of ['10', '11', '12']) save(svc, 'P-1', `2026-03-${d}T08:00`, { lube_concentration: { setpoint: '60', actual: '66' } });
  assert.equal(svc.driftAlerts().length, 1);
  const only = save(svc, 'ONLY-VOID', '2026-03-12T09:00', { nitrogen: { actual: '1' } });
  const ids = svc.listEntries({}).rows.filter((e) => e.part_no === 'P-1').map((e) => e.id);
  svc.voidEntry(ids[0], 'wrong sheet');
  assert.equal(svc.driftAlerts().length, 0); // streak is now 2
  assert.equal(svc.trend({ line: 5, part: 'P-1', key: 'lube_concentration' }).points.length, 2);
  assert.equal(svc.exportRows({}).rows.filter((r) => r[1] === 'P-1').length, 2);
  assert.equal(svc.dashboard().totalEntries, 3);
  svc.voidEntry(only.id, 'wrong part');
  assert.deepEqual(svc.listParts(5), ['P-1']);
  assert.ok(!svc.allParts().some((p) => p.part_no === 'ONLY-VOID'));
  assert.ok(!svc.checkPart(5, 'ONLY-VOID').exists);
});

test('restoreEntry undoes a void, but not one that a correction replaced', () => {
  const { svc } = make();
  const a = save(svc, 'P-1', '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  svc.voidEntry(a.id, 'oops');
  svc.restoreEntry(a.id);
  assert.equal(svc.getEntry(a.id).voided, 0);
  assert.equal(svc.listEntries({}).total, 1);
  assert.throws(() => svc.restoreEntry(a.id), /not voided/);
  const fix = save(svc, 'P-1', '2026-03-11T08:00', { nitrogen: { actual: '455' } }, { corrects: a.id, correct_reason: 'misread' });
  assert.throws(() => svc.restoreEntry(a.id), new RegExp(`replaced by entry #${fix.id}`));
});

test('correcting voids the original in the same save, with the original not counted as the baseline', () => {
  const { svc } = make();
  save(svc, 'P-1', '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  const bad = save(svc, 'P-1', '2026-03-11T08:00', { nitrogen: { actual: '4500' } });
  assert.throws(() => save(svc, 'P-1', '2026-03-12T08:00', { nitrogen: { actual: '455' } }, { corrects: bad.id, correct_reason: ' ' }), /reason/);
  assert.equal(svc.getEntry(bad.id).voided, 0); // nothing happened on the failed attempt
  const fix = save(svc, 'P-1', '2026-03-12T08:00', { nitrogen: { actual: '450' } }, { corrects: bad.id, correct_reason: 'Typo' });
  assert.equal(fix.changes, 0); // compared with 450, not the mistyped 4500
  const old = svc.getEntry(bad.id);
  assert.equal(old.voided, 1); assert.equal(old.void_reason, 'Typo'); assert.equal(old.corrected_by, fix.id);
  assert.equal(svc.getEntry(fix.id).source, 'correction');
  assert.equal(svc.allChanges().length, 0);
  assert.equal(svc.listEntries({}).total, 2);
  const log = svc.getAudit().map((a) => a.action);
  assert.ok(log.includes('entry-void') && log.includes('entry-add'));
});

test('a correction can fix a mistyped part number', () => {
  const { svc } = make();
  save(svc, 'GOOD-1', '2026-03-10T08:00', { nitrogen: { actual: '450' } });
  const bad = save(svc, 'G00D-1', '2026-03-11T08:00', { nitrogen: { actual: '460' } });
  const fix = save(svc, 'GOOD-1', '2026-03-11T08:00', { nitrogen: { actual: '460' } }, { corrects: bad.id, correct_reason: 'part typo' });
  assert.equal(fix.changes, 1);
  assert.deepEqual(svc.listParts(5), ['GOOD-1']);
});

// ---- migration and labels

test('migration v4 -> v6 relabels only untouched factory names and fills the capacitance unit', () => {
  const dir = tmp();
  const a = new SetupService({ dataDir: dir, now: () => new Date('2026-03-18T12:00:00') });
  a.close();
  const db = new DatabaseSync(path.join(dir, 'setups.db'));
  db.exec(`UPDATE fields SET label='Tonnage - station 1' WHERE key='tonnage_s1';
    UPDATE fields SET label='My own name' WHERE key='tonnage_s2';
    UPDATE fields SET label='Piece 1 / Station 2' WHERE key='ton_p1_s2';
    UPDATE fields SET unit='' WHERE key='capacitance';
    ALTER TABLE entries DROP COLUMN voided; ALTER TABLE entries DROP COLUMN void_reason; ALTER TABLE entries DROP COLUMN voided_ts; ALTER TABLE entries DROP COLUMN corrected_by;
    ALTER TABLE fields DROP COLUMN choices; PRAGMA user_version = 4;`);
  db.close();
  const b = new SetupService({ dataDir: dir, now: () => new Date('2026-03-18T12:00:00') });
  const label = (k) => b.getFields().find((f) => f.key === k).label;
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(label('tonnage_s1'), 'Tonnage setting - station 1');
  assert.equal(label('tonnage_s2'), 'My own name');
  assert.equal(label('ton_p1_s2'), 'Measured tonnage - piece 1 / station 2');
  assert.equal(b.getFields().find((f) => f.key === 'capacitance').unit, 'µF');
  assert.ok(b.listBackups().some((x) => x.reason === 'pre-migrate'));
  b.close();
});

test('a fresh database uses the new tonnage labels', () => {
  const { svc } = make();
  const f = new Map(svc.getFields().map((x) => [x.key, x.label]));
  assert.equal(f.get('tonnage_s3'), 'Tonnage setting - station 3');
  assert.equal(f.get('ton_p3_s3'), 'Measured tonnage - piece 3 / station 3');
});
