'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractSheet, extractFields, readHeader } = require('../app/main/ocr/extract');
const Clean = require('../app/shared/clean');
const { make } = require('./helpers');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ocr', n), 'utf8'));
const resolver = (svc) => (h) => {
  const form = h.form ? +h.form : (svc.getLineForms().find((l) => l.line === +h.line) || {}).form_no;
  return { form, fields: svc.getFormFields(form) };
};
const byKey = (out) => Object.fromEntries(out.fields.map((f) => [f.key, f]));

// A one-row sheet from [text, x] pairs (word width 10 per char, 20 high).
const row = (y, ...cells) => cells.map(([text, x, conf]) => ({ text, conf: conf ?? 95, x0: x, x1: x + text.length * 10, y0: y, y1: y + 20 }));
const F = (key, label, kind = 'number', extra = {}) => ({ key, label, kind, unit: '', has_sp: 1, ...extra });

test('values and units: printed units are dropped, placeholders are blank, fractions become decimals', () => {
  const num = { key: 'x', kind: 'number' };
  assert.equal(Clean.cleanValue(num, '500 PSI').value, '500');
  assert.equal(Clean.cleanValue(num, '14 secs').value, '14');
  assert.equal(Clean.cleanValue(num, '3.250"').value, '3.250');
  assert.equal(Clean.cleanValue(num, '16-1/4"').value, '16.25');
  assert.equal(Clean.cleanValue(num, '182 tons').value, '182');
  assert.equal(Clean.cleanValue(num, '2300 °F').value, '2300');
  assert.equal(Clean.cleanValue({ key: 'coil2_amps', kind: 'number' }, 'Coil#2: OFF').value, '0');
  for (const p of ['X.XX', 'XX', '0.XXX', '40-XXXX-01', 'N/A', 'T', 'NONE PSI']) assert.ok(Clean.cleanValue(num, p).blank, p);
  const bad = Clean.cleanValue(num, '2250-2300');
  assert.equal(bad.ok, false);
  assert.equal(Clean.cleanValue(num, 'OFF').ok, false);
  assert.equal(Clean.cleanValue({ kind: 'text' }, 'CARBON').value, 'CARBON');
});

test('a real OCR of the sample 2500T sheet (clean scan) reads every printed field', () => {
  const { svc } = make();
  const w = fx('words-10899.json');
  const out = extractSheet(w.words, resolver(svc), { skew: w.skew });
  assert.deepEqual(out.header, { line: '9', part: '40-7731-02', rev: 'B2', revised: '2026-09-22', revisedBy: 'JRK', hmi: '47', form: '10899' });
  assert.equal(out.form, 10899);
  const k = byKey(out);
  const want = {
    station1_label: 'EMPTY', station2_label: 'PREFORM', station3_label: 'FINISH', tonnage_s1: '850', tonnage_s2: '1400', tonnage_s3: '1180',
    leave_tongs: 'YES', special_forge: 'RUN HOT, WATCH FLASH', special_trim: 'TRIM FROM TOP', num_coils: '3', billet_temp: '2275',
    low_reject_temp: '2200', hi_reject_temp: '2400', scrap_temp: '2425', billet_diameter: '2.375', billet_length: '3.944', billet_weight: '4.95',
    billet_grade: '1045 STEEL', coil1_amps: '46.5', coil2_amps: '54.5', coil3_amps: '61.0', cycle_time: '12', wedge: '0.125', die_stations: '3',
    kick_hit1: '1 / 1 / 0.50', kick_hit2: '2 / 2 / 0.75', kick_hit3: '3 / 3 / 1.00', lube_type: 'CONDAT ORAFOR 630', lube_concentration: '2100',
    lube_program: '14', lube_head: 'LARGE CONE', spacer_diameter: '2.500', num_spacers: '5', robot_head: '2', cool_down: '8', drop_position: '3',
    z_offset: '0.040', shut_height: '16.250', nitrogen: '500', part_cooling: 'FANS ON; 1 SLOW CONVEYOR; HOT BOX', scrap_disposal: 'CARBON',
  };
  for (const [key, value] of Object.entries(want)) assert.equal(k[key] && k[key].value, value, key);
  // the OCR read 25Z3 as 2573: it must be flagged, not silently trusted
  assert.equal(k.coil_no.value, '2573');
  assert.equal(k.coil_no.status, 'check');
  assert.ok(out.fields.filter((f) => f.status === 'bad').length === 0);
});

test('a skewed, grainy photo of the same sheet reads the same values (tilt removed before rows are built)', () => {
  const { svc } = make();
  const w = fx('words-10899-photo.json');
  assert.ok(w.skew < -0.02, 'the photo is tilted');
  const out = extractSheet(w.words, resolver(svc), { skew: w.skew });
  const k = byKey(out);
  assert.equal(out.header.part, '40-7731-02');
  for (const [key, value] of Object.entries({ billet_temp: '2275', coil3_amps: '61.0', kick_hit3: '3 / 3 / 1.00', tonnage_s2: '1400', coil_no: '25Z3', part_cooling: 'FANS ON; 1 SLOW CONVEYOR; HOT BOX', special_trim: 'TRIM FROM TOP' })) assert.equal(k[key].value, value, key);
  assert.ok(out.fields.length >= 40);
});

test('without the tilt correction the photo reads worse (the correction is doing the work)', () => {
  const { svc } = make();
  const w = fx('words-10899-photo.json');
  const a = extractSheet(w.words, resolver(svc), { skew: w.skew }).fields.length;
  const b = extractSheet(w.words, resolver(svc), { skew: 0 }).fields.length;
  assert.ok(a > b, `${a} vs ${b}`);
});

test('labels glued together by OCR, columns merged into one row, values taken up to the next label', () => {
  const fields = [F('billet_temp', 'Billet temperature'), F('scrap_temp', 'Scrap temperature'), F('wedge', 'Wedge', 'text')];
  const words = [...row(100, ['BILLETTEMPERATURE', 10], ['2275', 400], ['°F', 480], ['SCRAP', 600], ['TEMPERATURE', 660], ['2425', 900]), ...row(140, ['WEDGE', 10], ['0.125', 400])];
  const k = byKey(extractFields(words, fields));
  assert.equal(k.billet_temp.value, '2275');
  assert.equal(k.scrap_temp.value, '2425');
  assert.equal(k.wedge.value, '0.125');
});

test('placeholders ("X.XX") on a blank form are not values; unreadable values are reported, not guessed', () => {
  const fields = [F('wedge', 'Wedge'), F('billet_temp', 'Billet temperature'), F('cycle_time', 'Cycle time', 'number', { unit: 's' })];
  const words = [...row(100, ['WEDGE', 10], ['0.XXX', 300]), ...row(140, ['BILLET', 10], ['TEMPERATURE', 80], ['2250-2300', 300]), ...row(180, ['CYCLE', 10], ['TIME', 80], ['XX', 300], ['secs', 400])];
  const out = extractFields(words, fields);
  const k = byKey(out);
  assert.equal(k.wedge, undefined);
  assert.equal(k.cycle_time, undefined);
  assert.equal(out.placeholders, 2);
  assert.equal(k.billet_temp.status, 'bad');
  assert.equal(k.billet_temp.raw, '2250-2300');
});

test('digits read as letters (2OO, l2) are corrected and flagged for review', () => {
  const k = byKey(extractFields([...row(100, ['SCRAP', 10], ['TEMPERATURE', 80], ['2OO0', 300])], [F('scrap_temp', 'Scrap temperature')]));
  assert.equal(k.scrap_temp.value, '2000');
  assert.equal(k.scrap_temp.status, 'check');
});

test('low OCR confidence is flagged; unscored words are not penalised; a unit mark does not drag confidence down', () => {
  const fields = [F('billet_temp', 'Billet temperature'), F('scrap_temp', 'Scrap temperature'), F('wedge', 'Wedge')];
  const words = [...row(100, ['BILLET', 10], ['TEMPERATURE', 80], ['2275', 400, 55], ['°F', 480, 20]), ...row(140, ['SCRAP', 10], ['TEMPERATURE', 80], ['2425', 400, 2], ['"', 480, 1]), ...row(180, ['WEDGE', 10], ['0.125', 400, 96], ['T', 480, 5])];
  const k = byKey(extractFields(words, fields));
  assert.equal(k.billet_temp.status, 'check');
  assert.equal(k.billet_temp.conf, 55);
  assert.equal(k.scrap_temp.status, 'ok');
  assert.equal(k.scrap_temp.conf, null);
  assert.equal(k.wedge.status, 'ok');
});

test('station tonnage follows its station; a value under a "below" label (special instruction) is picked up; kick hits are position / KO# / dwell', () => {
  const fields = [F('station1_label', 'Station 1 label', 'text'), F('station2_label', 'Station 2 label', 'text'), F('tonnage_s1', 'Tonnage setting - station 1'), F('tonnage_s2', 'Tonnage setting - station 2'),
    F('special_forge', 'Special forge instruction', 'text'), F('kick_hit1', 'Kick setup - hit 1', 'text')];
  const words = [...row(100, ['STATION#', 10], ['1:', 120], ['EMPTY', 200]), ...row(150, ['TONNAGE:', 10], ['850', 150], ['T', 200]),
    ...row(200, ['STATION#', 10], ['2:', 120], ['PREFORM', 200]), ...row(250, ['TONNAGE:', 10], ['1400', 150]),
    ...row(300, ['SPECIAL', 10], ['FORGE', 100], ['INSTRUCTION', 170]), ...row(330, ['RUN', 12], ['HOT', 60], ['HIT#', 500], ['1', 570], ['1', 640], ['1', 700], ['0.5', 760])];
  const k = byKey(extractFields(words, fields));
  assert.equal(k.tonnage_s1.value, '850');
  assert.equal(k.tonnage_s2.value, '1400');
  assert.equal(k.station2_label.value, 'PREFORM');
  assert.equal(k.special_forge.value, 'RUN HOT');
  assert.equal(k.kick_hit1.value, '1 / 1 / 0.5');
  const two = byKey(extractFields([...row(100, ['HIT#', 10], ['1', 80], ['1', 120], ['05', 150])], fields));
  assert.equal(two.kick_hit1.status, 'check');
});

test('the form is read from the footer (FORM# 10899); otherwise the press line decides', () => {
  const { svc } = make();
  const w = [...row(50, ['PRESS', 10], ['LINE:', 90], ['2', 200]), ...row(2000, ['FORM#:', 10], ['10903', 120])];
  assert.equal(extractSheet(w, resolver(svc)).form, 10903);
  const noFooter = [...row(50, ['PRESS', 10], ['LINE:', 90], ['2', 200])];
  assert.equal(extractSheet(noFooter, resolver(svc)).form, svc.getLineForms().find((l) => l.line === 2).form_no);
});

test('header: placeholders on a blank form are not read as a part number; revised by/date splits', () => {
  const h = readHeader([...row(50, ['PART', 10], ['NO.:', 80], ['40-XXXX-01', 200], ['REVISED', 400], ['BY/', 500], ['DATE:', 540], ['MAP', 640], ['3/9/2026', 700])]);
  assert.equal(h.part, '');
  assert.equal(h.revisedBy, 'MAP');
  assert.equal(h.revised, '2026-03-09');
});

test('fields the form does not have are ignored, and fields not found on the sheet are listed as missing', () => {
  const out = extractFields([...row(100, ['WEDGE', 10], ['0.125', 300]), ...row(140, ['NITROGEN', 10], ['500', 300])], [F('wedge', 'Wedge'), F('shut_height', 'Shut height')]);
  assert.deepEqual(out.fields.map((f) => f.key), ['wedge']);
  assert.deepEqual(out.missing.map((m) => m.key), ['shut_height']);
});
