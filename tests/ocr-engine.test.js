'use strict';
// Real OCR (tesseract.js + the bundled English data) on invented sample sheets: image in, field values out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OcrEngine } = require('../app/main/ocr/engine');
const { extractSheet } = require('../app/main/ocr/extract');
const { make } = require('./helpers');

const img = (n) => path.join(__dirname, 'fixtures', 'ocr', n);
const resolver = (svc) => (h) => { const form = +h.form; return { form, fields: svc.getFormFields(form) }; };

test('OCR of a clean scan and of a tilted, grainy photo gives the same sheet', { timeout: 120000 }, async () => {
  const { svc } = make();
  const eng = new OcrEngine();
  try {
    const seen = [];
    const clean = await eng.recognize(fs.readFileSync(img('sheet-10899.png')), { onProgress: (p) => seen.push(p) });
    const photo = await eng.recognize(fs.readFileSync(img('sheet-10899-photo.jpg')));
    assert.ok(seen.length > 0 && seen.every((p) => p >= 0 && p <= 1), 'progress is reported');
    assert.ok(photo.skew < -0.02 && clean.skew === 0, 'tilt is measured');
    const a = extractSheet(clean.words, resolver(svc), { skew: clean.skew });
    const b = extractSheet(photo.words, resolver(svc), { skew: photo.skew });
    assert.equal(a.header.part, '40-7731-02');
    assert.equal(b.header.part, '40-7731-02');
    const va = Object.fromEntries(a.fields.map((f) => [f.key, f.value]));
    const vb = Object.fromEntries(b.fields.map((f) => [f.key, f.value]));
    for (const k of ['billet_temp', 'scrap_temp', 'tonnage_s2', 'coil2_amps', 'kick_hit2', 'lube_type', 'shut_height', 'part_cooling']) assert.equal(vb[k], va[k], k);
    assert.ok(a.fields.length >= 42 && b.fields.length >= 42, `${a.fields.length} / ${b.fields.length}`);
  } finally { await eng.terminate(); }
});

test('calls queue on one worker, and run side by side on a pool; a bad image does not poison the pool', { timeout: 180000 }, async () => {
  const buf = fs.readFileSync(img('sheet-10899.png'));
  const one = new OcrEngine({ max: 1 });
  const two = new OcrEngine({ max: 2 });
  try {
    const [x, y] = await Promise.all([one.recognize(buf), one.recognize(buf)]);
    assert.equal(x.words.length, y.words.length);
    assert.equal(one.workers.length, 1);
    const rs = await Promise.all([two.recognize(buf), two.recognize(buf), two.recognize(buf)]);
    assert.ok(rs.every((r) => r.words.length === x.words.length));
    assert.equal(two.workers.length, 2);
    await assert.rejects(two.recognize(Buffer.from('not an image')));
    const after = await two.recognize(buf);
    assert.equal(after.words.length, x.words.length);
  } finally { await one.terminate(); await two.terminate(); }
});
