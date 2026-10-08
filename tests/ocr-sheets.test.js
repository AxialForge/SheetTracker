'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { make } = require('./helpers');

const words = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ocr', n), 'utf8'));
const scanOf = (file, n = 'words-10899.json') => ({ file, pages: [words(n)] });
const toItem = (r, over = {}) => ({ file: r.file, line: r.line, part: r.part, rev: r.rev, revised: r.revised, revisedBy: r.revisedBy, hmi: r.hmi, fields: r.fields.map((f) => ({ ...f, include: true })), ...over });

test('reviewScan: header, form from the footer, every field with its status, nothing guessed for the missing ones', () => {
  const { svc } = make();
  const r = svc.reviewScan(scanOf('40-7731-02.pdf'));
  assert.equal(r.line, 9);
  assert.equal(r.part, '40-7731-02');
  assert.equal(r.form, 10899);
  assert.equal(r.formSource, 'sheet');
  assert.equal(r.rev, 'B2');
  assert.equal(r.revised, '2026-09-22');
  assert.equal(r.problems.length, 0);
  assert.ok(r.fields.length >= 42);
  assert.deepEqual(r.missing.map((m) => m.key), ['gripper_size']);
  assert.equal(r.partInfo.exists, false);
});

test('reviewScan: a sheet with no readable form asks for one; a form can be chosen; an unknown line is a problem', () => {
  const { svc } = make();
  const w = words('words-10899.json');
  const noFooter = { file: 'x.png', pages: [{ ...w, words: w.words.filter((x) => !/FORM|10899/.test(x.text)) }] };
  const r = svc.reviewScan(noFooter);
  assert.equal(r.form, 10899);                  // from line 9
  assert.equal(r.formSource, 'line');
  const noLine = { file: 'x.png', pages: [{ ...w, words: w.words.filter((x) => !/FORM|10899|^9$|PRESS|LINE/.test(x.text)) }] };
  const r2 = svc.reviewScan(noLine);
  assert.equal(r2.form, null);
  assert.ok(r2.problems.some((p) => /Choose the form/.test(p)));
  const r3 = svc.reviewScan(noLine, { form: 10903, line: 11 });
  assert.equal(r3.form, 10903);
  assert.equal(r3.line, 11);
  assert.ok(svc.reviewScan({ file: 'blank.png', pages: [{ words: [] }] }).problems[0].includes('No text'));
});

test('import scans: preview, apply, setpoints only, traced to the file; a second run adds nothing', () => {
  const { svc } = make();
  const r = svc.reviewScan(scanOf('40-7731-02.pdf'));
  const items = [toItem(r)];
  const plan = svc.previewScans(items);
  assert.equal(plan.canApply, true);
  assert.equal(plan.summary.toAdd, 1);
  assert.deepEqual(plan.summary.newParts, [{ line: 9, part: '40-7731-02' }]);
  const res = svc.applyScans(items);
  assert.equal(res.added, 1);
  const e = svc.listEntries({ line: 9, part: '40-7731-02' }).rows[0];
  assert.equal(e.source, 'ocr');
  assert.equal(e.sheet_rev, 'B2');
  assert.equal(e.hmi_file, '47');
  assert.equal(e.entered_by, 'JRK');
  assert.match(e.notes, /Setup sheet scanned \(OCR\)/);
  assert.match(e.notes, /Source: 40-7731-02\.pdf/);
  assert.match(e.notes, /NEEDS REVIEW: .*Coil number = 2573/);
  const full = svc.getEntry(e.id);
  assert.equal(full.values.billet_temp.setpoint, '2275');
  assert.equal(full.values.billet_temp.actual, null);
  assert.equal(full.values.kick_hit2.setpoint, '2 / 2 / 0.75');
  const again = svc.previewScans(items);
  assert.equal(again.canApply, false);
  assert.equal(again.summary.duplicates, 1);
  assert.equal(svc.listEntries({ line: 9, part: '40-7731-02' }).total, 1);
  // the review of the same sheet now shows what is stored
  assert.equal(svc.reviewScan(scanOf('again.pdf')).previous.billet_temp, '2275');
});

test('values the reviewer unticked or that could not be read are not imported but are listed in the notes', () => {
  const { svc } = make();
  const r = svc.reviewScan(scanOf('a.pdf'));
  const items = [toItem(r)];
  items[0].fields.find((f) => f.key === 'scrap_temp').include = false;
  items[0].fields.push({ key: 'wedge2', label: 'Wedge', raw: '2250-2300', status: 'bad', error: 'not a number', include: true });
  items[0].fields.find((f) => f.key === 'wedge').status = 'bad';
  svc.applyScans(items);
  const e = svc.listEntries({ line: 9, part: '40-7731-02' }).rows[0];
  const full = svc.getEntry(e.id);
  assert.equal(full.values.scrap_temp, undefined);
  assert.equal(full.values.wedge, undefined);
  assert.match(e.notes, /NOT IMPORTED Scrap temperature = 2425/);
  assert.match(e.notes, /NOT IMPORTED Wedge = 0\.125/);
});

test('two sheets of one part (an old revision and the current one) import oldest first; the newest is current', () => {
  const { svc } = make();
  const a = svc.reviewScan(scanOf('old.pdf'));
  const b = svc.reviewScan(scanOf('new.pdf'));
  const old = toItem(a, { revised: '2025-01-10', rev: 'A' });
  const cur = toItem(b, { revised: '2026-09-22', rev: 'B2' });
  cur.fields.find((f) => f.key === 'billet_temp').value = '2300';
  const res = svc.applyScans([cur, old]);                  // given out of order
  assert.equal(res.added, 2);
  const list = svc.listEntries({ line: 9, part: '40-7731-02' }).rows;
  const sorted = list.slice().sort((x, y) => x.entry_ts.localeCompare(y.entry_ts));
  assert.equal(sorted[0].sheet_rev, 'A');
  assert.equal(sorted[1].sheet_rev, 'B2');
  assert.equal(svc.latestValues(9, '40-7731-02').billet_temp.setpoint, '2300');
});

test('dating entries by the sheet\'s revised date', () => {
  const { svc } = make();
  const items = [toItem(svc.reviewScan(scanOf('d.pdf')), { revised: '2025-06-01' })];
  svc.applyScans(items, { dateBy: 'revised' });
  assert.equal(svc.listEntries({ line: 9, part: '40-7731-02' }).rows[0].entry_ts.slice(0, 10), '2025-06-01');
});

test('problems are reported by file name, and "skip bad" imports the rest', () => {
  const { svc } = make();
  const good = toItem(svc.reviewScan(scanOf('good.pdf')));
  const bad = toItem(svc.reviewScan(scanOf('broken.pdf')), { part: '', line: 9 });
  const plan = svc.previewScans([good, bad]);
  assert.equal(plan.canApply, false);
  assert.ok(plan.errors.some((e) => e.startsWith('broken.pdf:')), plan.errors.join('|'));
  assert.equal(svc.previewScans([good, bad], { skipBad: true }).canApply, true);
  assert.equal(svc.applyScans([good, bad], { skipBad: true }).added, 1);
});

test('the sheet\'s line can be overridden (a folder says line 7, the sheet prints 9)', () => {
  const { svc } = make();
  const r = svc.reviewScan(scanOf('f.pdf'), { line: 7 });
  assert.equal(r.line, 7);
  assert.equal(r.form, 10899);
  svc.applyScans([toItem(r)]);
  assert.equal(svc.listEntries({ line: 7, part: '40-7731-02' }).total, 1);
});

test('folder scan: finds sheets in sub-folders, ignores everything else, offers the folder as the line', () => {
  const { tmp } = require('./helpers');
  const Files = require('../app/main/ocr/files');
  const root = tmp();
  for (const d of ['Line 7', 'Line 9/old']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ['Line 7/40-1000-01.pdf', 'Line 7/notes.txt', 'Line 7/~$lock.pdf', 'Line 9/old/a.JPG', 'Line 9/b.png', 'c.pdf']) fs.writeFileSync(path.join(root, f), 'x');
  const r = Files.listFolder(root);
  assert.deepEqual(r.files.map((f) => f.rel.replace(/\\/g, '/')), ['c.pdf', 'Line 7/40-1000-01.pdf', 'Line 9/b.png', 'Line 9/old/a.JPG']);
  assert.deepEqual(r.files.map((f) => Files.lineFromFolder(f.folder)), [null, 7, 9, null]);
  assert.equal(Files.lineFromFolder('Press 11'), 11);
  assert.equal(Files.lineFromFolder('5'), 5);
  assert.equal(Files.lineFromFolder('Old sheets'), null);
  assert.throws(() => Files.readFile(path.join(root, 'Line 7', 'notes.txt')), /not a PDF or an image/);
});
