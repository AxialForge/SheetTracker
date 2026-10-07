'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toXlsxBook, toXlsx, readXlsx } = require('../app/main/export');
const { parseTs } = require('../app/main/history');
const { make, entry, tmp } = require('./helpers');

const TPL_FIXED = 11; // Line, Part, Date/Time, Entered by, Sheet rev, Revised, HMI file, Reason, Notes, Source file, Review
// Read the exported template, fill rows by header text, write it back (as a person would in Excel).
function fill(svc, form, rows, { drop = [] } = {}) {
  const sheets = readXlsx(svc.exportHistoryTemplate({ form }));
  const headers = sheets.find((s) => s.name === 'Entries').rows[0];
  const colsSheet = sheets.find((s) => s.name === 'Columns').rows.slice(1);
  const data = rows.map((r) => headers.map((h) => (h in r ? r[h] : '')));
  const file = path.join(tmp(), 'filled.xlsx');
  fs.writeFileSync(file, toXlsxBook([{ name: 'Entries', headers: headers.filter((h) => !drop.includes(h)), rows: data.map((r) => r.filter((_, i) => !drop.includes(headers[i]))) },
    { name: 'Columns', headers: ['Header', 'Field key', 'Value'], rows: colsSheet }]));
  return file;
}

test('the blank template for a form: fixed columns, setpoint/actual per setting, one column per reading, a Columns map', () => {
  const { svc } = make();
  const sheets = readXlsx(svc.exportHistoryTemplate({ form: 10899 }));
  assert.deepEqual(sheets.map((s) => s.name), ['Read me', 'Entries', 'Columns']);
  const h = sheets.find((s) => s.name === 'Entries').rows[0];
  assert.deepEqual(h.slice(0, TPL_FIXED), ['Line', 'Part No.', 'Date/Time', 'Entered by', 'Sheet rev', 'Revised', 'HMI file', 'Reason', 'Notes', 'Source file', 'Review']);
  assert.ok(h.includes('Billet temperature (°F) - Setpoint') && h.includes('Billet temperature (°F) - Actual'));
  assert.ok(h.includes('Heat #') && !h.includes('Heat # - Actual'));
  const map = sheets.find((s) => s.name === 'Columns').rows.slice(1);
  assert.deepEqual(map.find((r) => r[0] === 'Billet temperature (°F) - Actual').slice(1), ['billet_temp', 'actual']);
  assert.equal(sheets.find((s) => s.name === 'Entries').rows.length, 1); // blank
});

test('fill the template → preview → import: entries land with setpoints, actuals, header data and a source note', () => {
  const { svc } = make();
  const file = fill(svc, 10899, [
    { Line: '5', 'Part No.': '40-1000-01', 'Date/Time': '2026-02-02 07:30', 'Entered by': 'JC', 'Sheet rev': 'A', 'HMI file': 'H1', 'Billet temperature (°F) - Setpoint': '2300', 'Source file': 'sheets/40-1000-01_0202.pdf' },
    { Line: '5', 'Part No.': '40-1000-01', 'Date/Time': '2026-02-03 07:30', 'Billet temperature (°F) - Setpoint': '2300', 'Billet temperature (°F) - Actual': '2310', 'Heat #': 'H77', Review: 'actual looks like 2310 or 2370' },
    { Line: '5', 'Part No.': '40-1000-01', 'Date/Time': '2026-02-04 07:30', 'Billet temperature (°F) - Setpoint': '2300', 'Billet temperature (°F) - Actual': '2350' },
  ]);
  const plan = svc.previewHistory(file);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.summary.toAdd, 3);
  assert.equal(plan.summary.newParts.length, 1);
  assert.equal(plan.summary.first, '2026-02-02T07:30');
  assert.equal(plan.canApply, true);
  const before = svc.listEntries({}).total;
  const res = svc.applyHistory(file);
  assert.deepEqual(res, { added: 3, skipped: 0, newParts: 1 });
  assert.equal(svc.listEntries({}).total, before + 3);
  const rows = svc.listEntries({ part: '40-1000-01' }).rows.slice().reverse();
  assert.equal(rows[0].values.billet_temp.setpoint, '2300'); assert.equal(rows[0].values.billet_temp.actual, null);
  assert.equal(rows[0].source, 'import'); assert.equal(rows[0].entered_by, 'JC'); assert.equal(rows[0].hmi_file, 'H1');
  assert.match(rows[0].notes, /Source: sheets\/40-1000-01_0202\.pdf/);
  assert.match(rows[1].notes, /NEEDS REVIEW: actual looks like/);
  assert.equal(rows[1].values.heat_no.actual, 'H77');
  // history is usable: the 2310 -> 2350 step is a change, the first actual is a baseline
  assert.equal(Object.keys(rows[1].changed).length, 0);
  assert.deepEqual(rows[2].changed.billet_temp, { from: '2310', to: '2350' });
  assert.ok(svc.listBackups().some((b) => b.reason === 'pre-history'));
  assert.ok(svc.getAudit().some((a) => a.action === 'history-import'));
});

test('a second import of the same file adds nothing (duplicates by line, part and date/time are skipped)', () => {
  const { svc } = make();
  const file = fill(svc, 10899, [{ Line: '5', 'Part No.': 'P-1', 'Date/Time': '2026-02-02 07:30', 'Billet temperature (°F) - Setpoint': '2300' }]);
  svc.applyHistory(file);
  const plan = svc.previewHistory(file);
  assert.equal(plan.summary.duplicates, 1);
  assert.equal(plan.summary.toAdd, 0);
  assert.throws(() => svc.applyHistory(file), /nothing to import/);
});

test('every problem is reported with its row; nothing is saved unless the bad rows are skipped on request', () => {
  const { svc } = make();
  const file = fill(svc, 10899, [
    { Line: '5', 'Part No.': 'OK-1', 'Date/Time': '2026-02-02 07:30', 'Billet temperature (°F) - Setpoint': '2300' },
    { Line: '99', 'Part No.': 'X', 'Date/Time': '2026-02-02 07:30', 'Billet temperature (°F) - Setpoint': '2300' },
    { Line: '5', 'Part No.': '', 'Date/Time': '2026-02-02 07:30', 'Billet temperature (°F) - Setpoint': '2300' },
    { Line: '5', 'Part No.': 'OK-2', 'Date/Time': 'last tuesday', 'Billet temperature (°F) - Setpoint': '2300' },
    { Line: '5', 'Part No.': 'OK-3', 'Date/Time': '2026-02-02', 'Billet temperature (°F) - Setpoint': 'hot' },
    { Line: '5', 'Part No.': 'OK-4', 'Date/Time': '2026-02-02' },
    { Line: '5', 'Part No.': 'OK-1', 'Date/Time': '2026-02-02 07:30', 'Billet temperature (°F) - Actual': '2301' },
  ]);
  const plan = svc.previewHistory(file);
  assert.equal(plan.canApply, false);
  assert.equal(plan.summary.skipped, 6);
  const text = plan.errors.join('\n');
  assert.match(text, /Row 3: .*Line 99 is not set up/);
  assert.match(text, /Row 4: .*Part No\. is empty/);
  assert.match(text, /Row 5: .*“last tuesday” is not a date/);
  assert.match(text, /Row 6: .*not a number/);
  assert.match(text, /Row 7: .*no values and no notes/);
  assert.match(text, /Row 8: .*same line, part no\. and date\/time as row 2/);
  const total = svc.listEntries({}).total;
  assert.throws(() => svc.applyHistory(file), /6 rows have problems/);
  assert.equal(svc.listEntries({}).total, total);
  const skip = svc.previewHistory(file, { skipBad: true });
  assert.equal(skip.canApply, true);
  assert.deepEqual(svc.applyHistory(file, { skipBad: true }), { added: 1, skipped: 6, newParts: 1 });
});

test('date/time forms: ISO, US with am/pm, date only, and Excel serial numbers', () => {
  assert.equal(parseTs('2026-03-10 08:05'), '2026-03-10T08:05');
  assert.equal(parseTs('2026-03-10T08:05:30'), '2026-03-10T08:05');
  assert.equal(parseTs('3/10/2026 8:05 PM'), '2026-03-10T20:05');
  assert.equal(parseTs('3/10/26'), '2026-03-10T00:00');
  assert.equal(parseTs('2026-03-10'), '2026-03-10T00:00');
  assert.equal(parseTs('46091.3333333'), '2026-03-10T08:00'); // Excel serial: 46091 = 2026-03-10
  assert.equal(parseTs('2026-02-30'), null);
  assert.equal(parseTs('soon'), null);
  assert.equal(parseTs('3/10/2026 13:00 PM'), null);
});

test('values typed as Excel numbers are repaired for time and date fields; types are validated', () => {
  const { svc } = make();
  svc.addField({ label: 'Started', kind: 'time', has_sp: false, forms: [10899] });
  svc.addField({ label: 'Checked on', kind: 'date', has_sp: false, forms: [10899] });
  svc.addField({ label: 'Pump OK', kind: 'yesno', has_sp: false, forms: [10899] });
  const file = fill(svc, 10899, [
    { Line: '5', 'Part No.': 'T-1', 'Date/Time': '46091.5', Started: '0.25', 'Checked on': '46091', 'Pump OK': 'ok' },
    { Line: '5', 'Part No.': 'T-1', 'Date/Time': '2026-03-11 06:00', 'Pump OK': 'maybe' },
  ]);
  const plan = svc.previewHistory(file);
  assert.equal(plan.summary.toAdd, 1);
  assert.match(plan.errors.join('\n'), /Row 3: Pump OK: .*not Yes or No/);
  svc.applyHistory(file, { skipBad: true });
  const e = svc.listEntries({ part: 'T-1' }).rows[0];
  const k = Object.fromEntries(svc.getFields().filter((f) => f.custom).map((f) => [f.label, f.key]));
  assert.equal(e.entry_ts, '2026-03-10T12:00');
  assert.equal(e.values[k.Started].actual, '06:00');
  assert.equal(e.values[k['Checked on']].actual, '2026-03-10');
  assert.equal(e.values[k['Pump OK']].actual, 'Yes');
});

test('part names: stored spelling wins, one spelling per file, near-misses of stored or new parts are warned about', () => {
  const { svc } = make();
  entry(svc, '2026-01-01T08:00', { billet_temp: { actual: '2250' } }, { part_no: 'AB-100' });
  const file = fill(svc, 10899, [
    { Line: '5', 'Part No.': 'ab-100', 'Date/Time': '2026-02-01 08:00', 'Billet temperature (°F) - Actual': '2250' },
    { Line: '5', 'Part No.': 'AB-10O', 'Date/Time': '2026-02-02 08:00', 'Billet temperature (°F) - Actual': '2250' },
    { Line: '5', 'Part No.': 'ZZ-9', 'Date/Time': '2026-02-03 08:00', 'Billet temperature (°F) - Actual': '2250' },
    { Line: '5', 'Part No.': 'zz-9', 'Date/Time': '2026-02-04 08:00', 'Billet temperature (°F) - Actual': '2250' },
  ]);
  const plan = svc.previewHistory(file);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.summary.newParts.map((p) => p.part), ['AB-10O', 'ZZ-9']);
  assert.ok(plan.warnings.some((w) => /AB-10O/.test(w) && /AB-100/.test(w)), plan.warnings.join('|'));
  svc.applyHistory(file);
  assert.equal(svc.listEntries({ part: 'AB-100' }).total, 2);   // ab-100 joined the stored spelling
  assert.equal(svc.listEntries({ part: 'ZZ-9' }).total, 2);      // zz-9 joined the file's first spelling
});

test('the app\'s own Excel data export can be imported into another profile with the same forms', () => {
  const { svc: a } = make();
  a.loadSampleData();
  const { headers, rows } = a.exportRows({ line: 5 });
  const file = path.join(tmp(), 'export.xlsx');
  fs.writeFileSync(file, toXlsx(headers, rows));
  const { svc: b } = make();
  const plan = b.previewHistory(file);
  assert.deepEqual(plan.errors, [], plan.errors.slice(0, 3).join('\n'));
  b.applyHistory(file);
  const src = a.listEntries({ line: 5 }).rows;
  const dst = b.listEntries({ line: 5 }).rows;
  assert.equal(dst.length, src.length);
  const sig = (e) => `${e.part_no}|${e.entry_ts}|${JSON.stringify(Object.fromEntries(Object.entries(e.values).sort()))}`;
  assert.deepEqual(dst.map(sig).sort(), src.map(sig).sort());
});

test('unknown columns and missing key columns are refused with a clear message; garbage files too', () => {
  const { svc } = make();
  const odd = path.join(tmp(), 'odd.xlsx');
  fs.writeFileSync(odd, toXlsxBook([{ name: 'Entries', headers: ['Line', 'Part No.', 'Date/Time', 'Mystery column'], rows: [['5', 'P', '2026-01-01', 'x']] }]));
  assert.match(svc.previewHistory(odd).errors.join('\n'), /Column “Mystery column” does not match any field/);
  const nodate = path.join(tmp(), 'nodate.xlsx');
  fs.writeFileSync(nodate, toXlsxBook([{ name: 'Entries', headers: ['Line', 'Part No.'], rows: [['5', 'P']] }]));
  assert.match(svc.previewHistory(nodate).errors.join('\n'), /no Date\/Time column/);
  const junk = path.join(tmp(), 'junk.xlsx'); fs.writeFileSync(junk, 'not excel');
  assert.match(svc.previewHistory(junk).errors[0], /Not an Excel/);
  assert.throws(() => svc.previewHistory(path.join(tmp(), 'none.xlsx')), /not found/i);
});

test('identifier names flow into the template and the import (Station / Product)', () => {
  const { svc } = make();
  svc.setSettings({ label_line: 'Station', label_part: 'Product' });
  const sheets = readXlsx(svc.exportHistoryTemplate({ form: 10899 }));
  assert.deepEqual(sheets.find((s) => s.name === 'Entries').rows[0].slice(0, 2), ['Station', 'Product']);
  const file = fill(svc, 10899, [{ Station: '5', Product: 'P-9', 'Date/Time': '2026-02-02 07:30', 'Billet temperature (°F) - Setpoint': '2300' }]);
  assert.equal(svc.previewHistory(file).summary.toAdd, 1);
  const bad = fill(svc, 10899, [{ Station: '77', Product: 'P-9', 'Date/Time': '2026-02-02 07:30', 'Billet temperature (°F) - Setpoint': '2300' }]);
  assert.match(svc.previewHistory(bad).errors.join('\n'), /Station 77 is not set up/);
});

test('the committed per-form history templates are what the generator makes (run `npm run templates`)', () => {
  const { svc } = make();
  const strip = (b) => readXlsx(b).map((s) => ({ name: s.name, rows: s.rows }));
  for (const f of svc.getForms()) {
    const file = path.join(__dirname, '..', 'templates', 'history', `history-template-form-${f.form_no}.xlsx`);
    assert.deepEqual(strip(fs.readFileSync(file)), strip(svc.exportHistoryTemplate({ form: f.form_no })), `form ${f.form_no}`);
  }
});
