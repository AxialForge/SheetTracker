'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { toCsv, toXlsx, crc32 } = require('../app/main/export');
const { reportHtml } = require('../app/main/report');
const { make, entry } = require('./helpers');

test('csv quoting and BOM', () => {
  const s = toCsv(['a', 'b'], [['x,y', 'He said "hi"'], ['line\nbreak', 5]]);
  assert.ok(s.startsWith('﻿a,b\r\n'));
  assert.match(s, /"x,y","He said ""hi"""/);
  assert.match(s, /"line\nbreak",5/);
});

// Minimal zip reader to verify the XLSX package is structurally valid.
function unzip(buf) {
  const out = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16); const csz = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28); const el = buf.readUInt16LE(p + 30); const cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42); const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26); const lel = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csz);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(crc32(raw), crc, `crc of ${name}`);
    out[name] = raw.toString('utf8');
    p += 46 + nl + el + cl;
  }
  return out;
}

test('xlsx is a valid zip with the expected parts and typed cells', () => {
  const files = unzip(toXlsx(['Line', 'Part No', 'Date/Time', 'Notes', 'Changed Fields', 'Die temp - Actual'], [[5, '007', '2026-03-10 08:00', 'a & <b>', '', '450.5']]));
  for (const f of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) assert.ok(files[f], f);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="A2"><v>5<\/v><\/c>/);
  assert.match(sheet, /<c r="F2"><v>450.5<\/v><\/c>/);          // numeric value column
  assert.match(sheet, />007<\/t>/);                              // part no stays text (leading zeros kept)
  assert.match(sheet, /a &amp; &lt;b&gt;/);
});

test('exportRows: setpoint/actual columns, changed fields, reasons toggle, filters', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { die_temp: { setpoint: '450', actual: '450' }, ptp_time: { actual: '6' } });
  entry(svc, '2026-03-11T08:00', { die_temp: { setpoint: '450', actual: '470' } }, { reason: 'Die change' });
  const all = svc.exportRows({});
  assert.ok(all.headers.includes('Reason'));
  assert.ok(all.headers.includes('Die temp (°F) - Setpoint') && all.headers.includes('Die temp (°F) - Actual'));
  assert.ok(all.headers.includes('Part-to-part time (s)'));
  const changedCol = all.headers.indexOf('Changed Fields');
  assert.ok(all.rows.some((r) => r[changedCol] === 'Die temp'));
  assert.ok(!svc.exportRows({ includeReason: false }).headers.includes('Reason'));
  assert.equal(svc.exportRows({ from: '2026-03-11' }).rows.length, 1);
  assert.equal(svc.exportRows({ line: 5, part: 'nope' }).rows.length, 0);
});

test('weekly report data + html', () => {
  const { svc } = make();
  entry(svc, '2026-03-10T08:00', { die_temp: { actual: '450' } });
  entry(svc, '2026-03-16T08:00', { die_temp: { actual: '470' } }, { reason: 'Quality' });
  entry(svc, '2026-03-01T08:00', { die_temp: { actual: '1' } }); // outside window
  const d = svc.weeklyReportData('2026-03-18');
  assert.equal(d.start, '2026-03-12');
  assert.equal(d.entries, 1);
  assert.equal(d.changes.length, 1);
  assert.deepEqual(d.reasons, { Quality: 1 });
  const html = reportHtml(d, { version: '0.1.0' });
  assert.match(html, /Weekly change report/);
  assert.match(html, /Die temp/);
  assert.match(html, /450/); assert.match(html, /470/);
});
