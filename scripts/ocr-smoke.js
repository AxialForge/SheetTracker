'use strict';
// Headless end-to-end check of the sheet scanning in the real window: PDF text layer, scanned PDF, scan and photo through
// pdf.js + the OCR engine, the entry-form fill, and the folder import. Exits non-zero on any failure.  Usage: npm run ocr-smoke
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ocr');
// OCR_SMOKE_ASAR: run against a packaged app's app.asar (CI checks the installer's layout this way).
// OCR_SMOKE_OUT: where screenshots go.  OCR_SMOKE_LOG: also write the log to a file (a GUI exe on Windows has no console).
const MAIN = process.env.OCR_SMOKE_ASAR ? path.join(process.env.OCR_SMOKE_ASAR, 'app', 'main', 'main.js') : path.join(ROOT, 'app', 'main', 'main.js');
const OUT = process.env.OCR_SMOKE_OUT || path.join(ROOT, 'docs', 'screenshots');
if (process.env.OCR_SMOKE_LOG) {
  fs.writeFileSync(process.env.OCR_SMOKE_LOG, '');
  for (const k of ['log', 'error']) { const orig = console[k].bind(console); console[k] = (...a) => { orig(...a); fs.appendFileSync(process.env.OCR_SMOKE_LOG, `${a.map(String).join(' ')}\n`); }; }
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ocr-'));
const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-ocr-sheets-')), 'Line 9');
process.env.SETUP_TRACKER_DATA_DIR = dataDir;
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(folder, { recursive: true });
  const files = ['sheet-10899.png', 'sheet-10899-photo.jpg', 'sheet-10899-scan.pdf', 'sheet-10899-text.pdf'];
  for (const f of files) fs.copyFileSync(path.join(FIX, f), path.join(folder, f));
  require(MAIN);
  await sleep(1000);
  const win = BrowserWindow.getAllWindows()[0];
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  win.setSize(1360, 900);
  const run = (js) => win.webContents.executeJavaScript(js);
  fs.mkdirSync(OUT, { recursive: true });
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const until = async (js, ms = 240000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await run(js)) return true; await sleep(300); } throw new Error(`timed out waiting for: ${js}`); };
  const results = {};
  let failed = false;
  const check = (name, ok) => { results[name] = !!ok; if (!ok) failed = true; };
  try {
    await run(`ST.refreshCore().then(() => ST.show('entry')).then(() => 0)`);
    await sleep(500);

    // 1. every kind of file through the real reader
    for (const f of files) {
      const r = await run(`(async () => {
        const t = Date.now();
        const scan = await ST.scan.read({ path: ${JSON.stringify(path.join(folder, f))}, name: ${JSON.stringify(f)} });
        const item = await ST.api('reviewScan', scan);
        const v = Object.fromEntries(item.fields.map((x) => [x.key, x.value]));
        return { via: scan.pages.map((p) => p.via).join(','), n: item.fields.length, part: item.part, line: item.line, form: item.form, temp: v.billet_temp, kick: v.kick_hit3, ms: Date.now() - t };
      })()`);
      console.log('read', f, JSON.stringify(r));
      check(`read ${f}`, r.n >= 40 && r.part === '40-7731-02' && r.line === 9 && r.form === 10899 && r.temp === '2275' && r.kick === '3 / 3 / 1.00');
      check(`path ${f}`, f.endsWith('text.pdf') ? r.via === 'text' : r.via === 'ocr');
    }

    // 2. one sheet into the entry form
    await run(`ST.main = ((orig) => (name, ...a) => (name === 'ocr:pickFiles' ? orig('ocr:describe', ${JSON.stringify(path.join(folder, 'sheet-10899-photo.jpg'))}).then((f) => ({ files: [f] })) : orig(name, ...a)))(ST.main); 0`);
    await run(`void ST.tabs.entry.scanSheet(); 0`);
    await until(`!!document.querySelector('.scan-tbl') && document.querySelectorAll('.scan-row').length > 30`);
    await shot('crimson-scan-review');
    const seen = await run(`(() => ({ rows: document.querySelectorAll('.scan-row').length, check: document.querySelectorAll('.scan-row.check').length, banner: !!document.querySelector('.setup-note') }))()`);
    console.log('review', JSON.stringify(seen));
    check('review shows the sheet', seen.rows >= 40 && seen.banner);
    await run(`[...document.querySelectorAll('.modal .btn.primary')].find((b) => /Fill the entry form/.test(b.textContent)).click(); 0`);
    await until(`!document.querySelector('.scan-tbl')`);
    await sleep(600);
    const filled = await run(`(() => { const S = ST.tabs.entry.S; return { line: S.line, part: S.part, temp: S.values.billet_temp && S.values.billet_temp.setpoint, notes: S.notes, source: S.source, first: S.first, inputs: document.querySelectorAll('input[data-key][data-which="setpoint"]').length }; })()`);
    console.log('entry', JSON.stringify(filled));
    check('entry form filled', filled.line === '9' && filled.part === '40-7731-02' && filled.temp === '2275' && filled.source === 'ocr' && filled.first && filled.inputs > 30);
    await shot('crimson-scan-entry');
    const saved = await run(`(async () => { const E = ST.tabs.entry; E.S.newPartOk = E.S.line + '|' + E.S.part; await E.save(); await new Promise((r) => setTimeout(r, 400)); return ST.api('listEntries', { line: 9, part: '40-7731-02' }); })()`);
    check('filled entry saves', saved.total === 1 && saved.rows[0].source === 'ocr');

    // 3. a folder of sheets
    await run(`ST.main = ((orig) => (name, ...a) => (name === 'ocr:pickFolder' ? orig('ocr:folder', ${JSON.stringify(folder)}) : orig(name, ...a)))(ST.main); ST.show('export').then(() => { window.__bulk = ST.scan.bulk('folder'); }); 0`);
    await until(`!!document.querySelector('.scan-tbl') && document.querySelectorAll('.scan-row').length === 4`);
    await shot('crimson-scan-folder');
    const bulk = await run(`(() => ({ rows: document.querySelectorAll('.scan-row').length, lines: [...document.querySelectorAll('.scan-row select')].map((s) => s.value) }))()`);
    console.log('folder', JSON.stringify(bulk));
    check('folder: 4 sheets, line taken from the folder name', bulk.rows === 4 && bulk.lines.every((l) => l === '9'));
    await run(`[...document.querySelectorAll('.modal .btn')].find((b) => /Select all that can be imported/.test(b.textContent)).click(); 0`);
    await sleep(300);
    await run(`[...document.querySelectorAll('.modal .btn.primary')].find((b) => /Preview import/.test(b.textContent)).click(); 0`);
    await until(`[...document.querySelectorAll('.modal .btn.primary')].some((b) => /^Import \\d+ entr/.test(b.textContent))`);
    await shot('crimson-scan-import');
    await run(`[...document.querySelectorAll('.modal .btn.primary')].find((b) => /^Import \\d+ entr/.test(b.textContent)).click(); 0`);
    await run(`window.__bulk`);
    await sleep(500);
    const after = await run(`ST.api('listEntries', { line: 9, part: '40-7731-02' }).then((r) => ({ total: r.total, sources: [...new Set(r.rows.map((e) => e.source))] }))`);
    console.log('imported', JSON.stringify(after));
    check('folder import adds entries (and keeps the earlier one)', after.total >= 2 && after.sources.includes('ocr'));
  } catch (e) { console.error(e); failed = true; }
  console.log('ocr smoke', JSON.stringify(results));
  if (errors.length) console.error('Renderer errors:\n' + errors.join('\n'));
  const bad = failed || errors.length;
  console.log(bad ? 'OCR SMOKE FAILED' : 'OCR SMOKE OK');
  app.exit(bad ? 1 : 0);
});
