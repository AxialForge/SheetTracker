'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toXlsxBook, readXlsx, toXlsx } = require('../app/main/export');

test('multi-sheet workbook round-trips through our writer and reader', () => {
  const buf = toXlsxBook([
    { name: 'Fields', headers: ['Form', 'Field', 'Note'], rows: [[10880, 'Billet temp', 'a & <b>'], [10899, 'Zeta "q"', '']], freeze: { x: 0, y: 1 },
      validations: [{ col: 2, list: ['x', 'y'] }] },
    { name: 'Lists', headers: ['Types'], rows: [['Number'], ['Text']], hidden: true },
  ]);
  const sheets = readXlsx(buf);
  assert.deepEqual(sheets.map((s) => s.name), ['Fields', 'Lists']);
  assert.deepEqual(sheets[0].rows, [['Form', 'Field', 'Note'], ['10880', 'Billet temp', 'a & <b>'], ['10899', 'Zeta "q"']]); // empty trailing cells are simply absent
  assert.deepEqual(sheets[1].rows, [['Types'], ['Number'], ['Text']]);
});

test('reads a workbook written by a real spreadsheet library (shared strings, sparse cells, numbers)', () => {
  const sheets = readXlsx(fs.readFileSync(path.join(__dirname, 'fixtures', 'openpyxl.xlsx')));
  const f = sheets.find((s) => s.name === 'Fields');
  assert.ok(f);
  assert.deepEqual(f.rows[0].slice(0, 3), ['Form', 'Field', 'Type']);
  assert.deepEqual(f.rows[1].slice(0, 3), ['10880', 'Billet temperature', 'Number']);
  assert.equal(f.rows[2][1], 'Café ünïcode — “quotes”');
  assert.equal(f.rows[3][0], '');            // blank cell in a sparse row
  assert.equal(f.rows[3][1], 'After a gap');
  assert.equal(f.rows[4][0], '12.5');        // a float cell
  assert.equal(f.rows[4][1], 'TRUE');        // a boolean cell
});

test('legacy single-sheet export still numbers the value columns', () => {
  const sheets = readXlsx(toXlsx(['Line', 'Part No', 'Changed Fields', 'Temp'], [[5, '007', '', '450.5']]));
  assert.deepEqual(sheets[0].rows[1], ['5', '007', '', '450.5']);
});

test('garbage is rejected with a readable error', () => {
  assert.throws(() => readXlsx(Buffer.from('this is not a zip file')), /Not an Excel/);
});
