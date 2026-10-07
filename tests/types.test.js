'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../app/shared/types');
const { make, entry } = require('./helpers');

const f = (kind, extra = {}) => ({ kind, choices: '', min: '', max: '', ...extra });
const val = (field, raw) => { const r = T.parse(field, raw); assert.ok(r.ok, `${raw}: ${r.error}`); return r.value; };

test('number: strict, commas allowed, trailing zeros kept as typed', () => {
  assert.equal(val(f('number'), ' 2300.0 '), '2300.0');
  assert.equal(val(f('number'), '1,200.5'), '1200.5');
  assert.equal(T.parse(f('number'), '12 est').ok, false);
  assert.equal(T.parse(f('number'), 'abc').ok, false);
  assert.equal(val(f('number'), ''), '');
});

test('rating: whole number within scale, accepts "4/5"; scale and floor configurable', () => {
  const r = f('rating', { max: '5' });
  assert.equal(val(r, '4'), '4');
  assert.equal(val(r, '4/5'), '4');
  assert.equal(val(r, '4 of 5'), '4');
  assert.equal(T.parse(r, '6').ok, false);
  assert.equal(T.parse(r, '0').ok, false); // floor defaults to 1
  assert.equal(val(f('rating', { min: '0', max: '5' }), '0'), '0');
  assert.equal(T.parse(r, '3/10').ok, false);
  assert.equal(T.parse(r, '2.5').ok, false);
  assert.equal(val(f('rating'), '5'), '5'); // default scale 5
});

test('ratio: x of y / x/y canonicalised', () => {
  assert.equal(val(f('ratio'), '3 of 5'), '3/5');
  assert.equal(val(f('ratio'), '3/5'), '3/5');
  assert.equal(val(f('ratio'), '3.50/10'), '3.5/10');
  assert.equal(T.parse(f('ratio'), '3').ok, false);
  assert.equal(T.toNumber(f('ratio'), '3/4'), 0.75);
});

test('yes/no: synonyms map to Yes / No', () => {
  for (const y of ['yes', 'Y', 'ok', 'PASS', 'true']) assert.equal(val(f('yesno'), y), 'Yes');
  for (const n of ['no', 'N', 'NG', 'fail']) assert.equal(val(f('yesno'), n), 'No');
  assert.equal(T.parse(f('yesno'), 'maybe').ok, false);
});

test('time of day: 24 h canonical, am/pm and compact forms accepted', () => {
  assert.equal(val(f('time'), '6:05'), '06:05');
  assert.equal(val(f('time'), '6:05 PM'), '18:05');
  assert.equal(val(f('time'), '12:00 AM'), '00:00');
  assert.equal(val(f('time'), '12:30pm'), '12:30');
  assert.equal(val(f('time'), '0605'), '06:05');
  assert.equal(val(f('time'), '7pm'), '19:00');
  assert.equal(T.parse(f('time'), '25:00').ok, false);
  assert.equal(T.parse(f('time'), '6:75').ok, false);
  assert.equal(T.toNumber(f('time'), '06:30'), 390);
  assert.equal(T.fmtAxis('time', 390), '06:30');
});

test('duration: seconds, mm:ss, h:mm:ss, 1m30s all become seconds', () => {
  assert.equal(val(f('duration'), '90'), '90');
  assert.equal(val(f('duration'), '1:30'), '90');
  assert.equal(val(f('duration'), '1:02:03'), '3723');
  assert.equal(val(f('duration'), '1m30s'), '90');
  assert.equal(val(f('duration'), '2.5'), '2.5');
  assert.equal(T.parse(f('duration'), 'soon').ok, false);
});

test('date: ISO or m/d/yyyy, real dates only', () => {
  assert.equal(val(f('date'), '2026-3-9'), '2026-03-09');
  assert.equal(val(f('date'), '3/9/2026'), '2026-03-09');
  assert.equal(T.parse(f('date'), '2026-02-30').ok, false);
  assert.equal(T.parse(f('date'), 'yesterday').ok, false);
});

test('choice: matched to the list ignoring case; open when the list is empty', () => {
  const c = f('choice', { choices: 'Standard\nHeavy' });
  assert.equal(val(c, 'heavy'), 'Heavy');
  assert.equal(T.parse(c, 'Light').ok, false);
  assert.match(T.parse(c, 'Light').error, /Standard, Heavy/);
  assert.equal(val(f('choice'), 'anything'), 'anything');
});

test('comparison is type-aware: legacy "5/5" equals rating 5; 90 equals 1:30; times by value', () => {
  assert.ok(T.same(f('rating', { max: '5' }), '5/5', '5'));
  assert.ok(T.same(f('duration'), '90', '1:30'));
  assert.ok(T.same(f('time'), '6:05', '06:05'));
  assert.ok(T.same(f('number'), '2300', '2300.0'));
  assert.ok(T.same(f('yesno'), 'ok', 'Yes'));
  assert.ok(T.changed(f('yesno'), 'Yes', 'No'));
  assert.ok(!T.changed(f('number'), '', '5'));
  assert.ok(T.drifted(f('choice', { choices: 'A\nB' }), 'A', 'B'));
});

test('out of range: only number-like kinds with a min/max', () => {
  const n = f('number', { min: '2200', max: '2300' });
  assert.equal(T.outOfRange(n, '2150'), 'low');
  assert.equal(T.outOfRange(n, '2350'), 'high');
  assert.equal(T.outOfRange(n, '2250'), null);
  assert.equal(T.outOfRange(f('time', { min: '06:00', max: '18:00' }), '05:30'), 'low');
  assert.equal(T.outOfRange(f('text', { min: '1', max: '2' }), 'x'), null);
});

test('kindFrom accepts keys, labels and common aliases', () => {
  assert.equal(T.kindFrom('Yes / No'), 'yesno');
  assert.equal(T.kindFrom('time of day'), 'time');
  assert.equal(T.kindFrom('Pick-list'), 'choice');
  assert.equal(T.kindFrom('RATING'), 'rating');
  assert.equal(T.kindFrom('nonsense'), '');
});

// ---- through the service
test('service: new field types validate on save and store canonical text', () => {
  const { svc } = make();
  svc.addField({ label: 'Pump check', kind: 'yesno', has_sp: false });
  svc.addField({ label: 'Start time', kind: 'time', has_sp: false });
  svc.addField({ label: 'Cycle', kind: 'duration', has_sp: false, unit: 's' });
  svc.addField({ label: 'Grade', kind: 'choice', has_sp: true, choices: 'A\nB' });
  svc.addField({ label: 'Smoothness', kind: 'rating', has_sp: false, max: '10' });
  const keys = Object.fromEntries(svc.getFields().filter((x) => x.custom).map((x) => [x.label, x.key]));
  const r = entry(svc, '2026-03-10T08:00', {
    [keys['Pump check']]: { actual: 'ok' }, [keys['Start time']]: { actual: '6:05 PM' }, [keys.Cycle]: { actual: '1:30' },
    [keys.Grade]: { setpoint: 'a', actual: 'B' }, [keys.Smoothness]: { actual: '7/10' },
  });
  const e = svc.getEntry(r.id);
  assert.equal(e.values[keys['Pump check']].actual, 'Yes');
  assert.equal(e.values[keys['Start time']].actual, '18:05');
  assert.equal(e.values[keys.Cycle].actual, '90');
  assert.equal(e.values[keys.Grade].setpoint, 'A');
  assert.equal(e.values[keys.Smoothness].actual, '7');
  assert.ok(e.drift[keys.Grade]);
});

test('service: bad values are rejected together with the field named', () => {
  const { svc } = make();
  svc.addField({ label: 'Pump check', kind: 'yesno', has_sp: false });
  const k = svc.getFields().find((x) => x.label === 'Pump check').key;
  assert.throws(() => entry(svc, '2026-03-10T08:00', { [k]: { actual: 'maybe' }, billet_temp: { actual: 'hot' } }),
    (err) => /Pump check/.test(err.message) && /Billet temperature/.test(err.message) && /not Yes or No/.test(err.message) && /not a number/.test(err.message));
  assert.equal(svc.listEntries({}).total, 0);
});

test('service: field type edits are validated; min/max stored; out-of-range flagged', () => {
  const { svc } = make();
  svc.updateField('billet_temp', { min: '2200', max: '2300' });
  assert.throws(() => svc.updateField('billet_temp', { min: 'abc' }), /Minimum/);
  assert.throws(() => svc.updateField('billet_temp', { min: '2400' }), /above the maximum/);
  assert.throws(() => svc.updateField('billet_temp', { kind: 'rating', max: '0' }), /Scale/);
  const r = entry(svc, '2026-03-10T08:00', { billet_temp: { actual: '2350' } });
  assert.equal(svc.getEntry(r.id).range.billet_temp, 'high');
});

test('service: rating "4/5" stored before the type change still compares equal (no phantom change)', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { dousing_pump: { actual: '4/5' } });
  const r = entry(svc, '2026-03-11T08:00', { dousing_pump: { actual: '4' } });
  assert.equal(r.changes, 0);
});

test('service: dousing pump is a rating out of 5 on a fresh install', () => {
  const { svc } = make();
  const f1 = svc.getFields().find((x) => x.key === 'dousing_pump');
  assert.equal(f1.kind, 'rating'); assert.equal(f1.max, '5');
  assert.throws(() => entry(svc, '2026-03-10T08:00', { dousing_pump: { actual: '6' } }), /rating/);
});

test('service: charts accept rating/duration/time; yes/no and text have no series', () => {
  const { svc } = make();
  svc.addField({ label: 'Start time', kind: 'time', has_sp: false });
  const k = svc.getFields().find((x) => x.label === 'Start time').key;
  entry(svc, '2026-03-10T08:00', { [k]: { actual: '06:30' }, dousing_pump: { actual: '4' } });
  assert.deepEqual(svc.trend({ line: 5, part: 'P-1', key: k }).points.map((p) => p.actual), [390]);
  assert.deepEqual(svc.trend({ line: 5, part: 'P-1', key: 'dousing_pump' }).points.map((p) => p.actual), [4]);
  assert.equal(svc.trend({ line: 5, part: 'P-1', key: 'heat_no' }).points.length, 0);
});

test('service: sections live in the database; add/rename/delete', () => {
  const { svc } = make();
  assert.ok(svc.getSections().some((s) => s.key === 'heat'));
  const s = svc.addSection('Coolant loop');
  assert.equal(s.key, 'coolant_loop');
  assert.equal(svc.addSection('coolant LOOP').key, 'coolant_loop'); // no duplicate
  svc.addField({ label: 'Coolant ppm', section: 'coolant_loop' });
  assert.throws(() => svc.deleteSection('coolant_loop'), /still in this section/);
  assert.throws(() => svc.addField({ label: 'X', section: 'nope' }), /Unknown section/);
  svc.renameSection('coolant_loop', 'Coolant');
  assert.equal(svc.getSections().find((x) => x.key === 'coolant_loop').label, 'Coolant');
});

test('service: identifier names flow into exports, reports and messages', () => {
  const { svc } = make();
  entry(svc, '2026-03-17T08:00', { billet_temp: { actual: '2250' } });
  entry(svc, '2026-03-18T08:00', { billet_temp: { actual: '2275' } });
  assert.deepEqual(svc.exportRows({}).headers.slice(0, 2), ['Line', 'Part No']);
  svc.setSettings({ label_line: 'Station', label_part: 'Product' });
  assert.deepEqual(svc.exportRows({}).headers.slice(0, 2), ['Station', 'Product']);
  assert.throws(() => svc.saveEntry({ line: 99, part_no: 'X', values: { billet_temp: { actual: '1' } } }), /Station 99 is not configured/);
  assert.throws(() => svc.saveEntry({ line: 5, part_no: '', values: { billet_temp: { actual: '1' } } }), /Product is required/);
  const html = require('../app/main/report').reportHtml(svc.weeklyReportData('2026-03-18'), { title: 'Job X' });
  assert.match(html, /Station 5/); assert.match(html, /<th>Station<\/th><th>Product<\/th>|<th>S5<\/th>/); assert.match(html, /Job X/);
  assert.doesNotMatch(html, /Viking Forge/);
});
