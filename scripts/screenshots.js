'use strict';
// Headless smoke run: every tab in every theme against sample data. Writes PNGs to docs/screenshots.
// Exits non-zero on any renderer error, so it doubles as an end-to-end check.  Usage: npm run screenshots
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-shots-'));
process.env.SETUP_TRACKER_DATA_DIR = dataDir;
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const TABS = ['dashboard', 'entry', 'data', 'export', 'forms', 'settings', 'about'];
const THEMES = ['crimson', 'amber', 'steel'];

app.whenReady().then(async () => {
  // Reuse the real main process wiring (IPC handlers, service) but drive our own window.
  const { SetupService } = require('../app/main/service');
  const { readXlsx, toXlsxBook } = require('../app/main/export');
  const svc = new SetupService({ dataDir });
  svc.setSettings({ opt_missing: '1', weekly_auto: '0', report_dir: path.join(dataDir, 'reports') });
  svc.loadSampleData();
  // an edited Excel template for the import flow below: one rename, one role change, new fields, and a second job's form
  const hdr = ['Form', 'Section', 'Field', 'Type', 'Unit', 'Entry', 'Role', 'Options', 'Min', 'Max', 'Key'];
  const rows = readXlsx(svc.exportTemplate({ forms: [10899] })).find((x) => x.name === 'Fields').rows.slice(1).map((r) => {
    if (r[10] === 'billet_temp') r[2] = 'Billet temperature (smoke)';
    if (r[10] === 'lube_head') r[6] = 'Set once';
    return r;
  });
  rows.push([10899, 'Coolant', 'Coolant ppm', 'Number', 'ppm', 'Reading', 'Tracked', '', '100', '300', ''], [10899, 'Coolant', 'Coolant clear?', 'Yes / No', '', 'Reading', 'Tracked', '', '', '', ''],
    [200, 'Second job', 'Thing', 'Choice', '', 'Setting', 'Tracked', 'x; y', '', '', '']);
  const tpl = path.join(dataDir, 'edited-template.xlsx');
  fs.writeFileSync(tpl, toXlsxBook([{ name: 'Fields', headers: hdr, rows }, { name: 'Forms', headers: ['Form', 'Name', 'Notes', 'Lines'], rows: [[200, 'Second job', '', '12']] }]));
  // a filled-in history template for the import flow below (one row has a bad value on purpose)
  const hsheets = readXlsx(svc.exportHistoryTemplate({ form: 10899 }));
  const hhead = hsheets.find((x) => x.name === 'Entries').rows[0];
  const hrow = (o) => hhead.map((c) => (c in o ? o[c] : ''));
  const hfile = path.join(dataDir, 'history.xlsx');
  fs.writeFileSync(hfile, toXlsxBook([{ name: 'Entries', headers: hhead, rows: [
    hrow({ Line: '5', 'Part No.': 'HIST-1', 'Date/Time': '2026-01-05 07:00', 'Source file': 'HIST-1_0105.pdf', 'Billet temperature (°F) - Setpoint': '2300' }),
    hrow({ Line: '5', 'Part No.': 'HIST-1', 'Date/Time': '2026-01-06 07:00', 'Billet temperature (°F) - Setpoint': '2300', 'Billet temperature (°F) - Actual': '2310', Review: 'hard to read' }),
    hrow({ Line: '5', 'Part No.': 'HIST-1', 'Date/Time': '2026-01-07 07:00', 'Billet temperature (°F) - Setpoint': '2300', 'Billet temperature (°F) - Actual': 'hot' }),
  ] }, { name: 'Columns', headers: ['Header', 'Field key', 'Value'], rows: hsheets.find((x) => x.name === 'Columns').rows.slice(1) }]));
  svc.close();
  require('../app/main/main.js');
  await new Promise((r) => setTimeout(r, 800));
  const win = BrowserWindow.getAllWindows()[0];
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  win.setSize(1360, 900);
  const run = (js) => win.webContents.executeJavaScript(js);
  fs.mkdirSync(OUT, { recursive: true });
  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 450));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  };
  for (const theme of THEMES) {
    await run(`ST.api('setSettings', {theme: '${theme}'})`);
    for (const tab of TABS) {
      if (tab === 'entry') {
        await run(`(async () => { const E = ST.tabs.entry; E.S = null; await ST.show('entry'); await E.setLinePart('5', '6120-C'); E.fillBlanks(); const inp = document.querySelector('input[data-key="billet_temp"][data-which="actual"]'); inp.value = '2275'; inp.dispatchEvent(new Event('input', {bubbles: true})); })()`);
      } else await run(`ST.show('${tab}')`);
      await shot(`${theme}-${tab}`);
    }
  }
  await run(`ST.api('setSettings', {theme: 'crimson'})`); // the committed screenshots are the crimson ones
  // exercise save + export + report paths for real
  const saved = await run(`ST.api('saveEntry', {line: 5, part_no: '6120-C', values: {billet_temp: {setpoint: '2250', actual: '2300'}}, notes: 'smoke'})`);
  const csv = await run(`ST.main('report:create', new Date().toLocaleDateString('en-CA'))`);
  const pdfOk = fs.existsSync(csv.file) && fs.statSync(csv.file).size > 1000;
  console.log('saved', JSON.stringify(saved), 'pdf', csv.file, pdfOk);
  // the first entry for a new part asks only for setpoints; the next one asks for actuals
  const setup = await run(`(async () => {
    const E = ST.tabs.entry; const out = {};
    E.S = null; await ST.show('entry'); await E.setLinePart('5', 'setup-flow-1');
    out.banner = document.body.innerText.includes('enter the sheet setpoints only');
    out.noActuals = !document.querySelector('[data-which="actual"]') && document.querySelectorAll('.readings, .tonnage-card').length === 0;
    out.hasSetpoints = !!document.querySelector('[data-which="setpoint"]');
    E.S.newPartOk = E.S.line + '|' + E.S.part;
    E.val('billet_temp').setpoint = '2300'; E.val('billet_temp').actual = '9999'; E.val('heat_no').actual = 'X1'; // strays must not be saved
    await E.save();
    const row = (await ST.api('listEntries', { part: 'setup-flow-1' })).rows[0];
    out.savedSetpointsOnly = !!row && row.values.billet_temp.setpoint === '2300' && !row.values.billet_temp.actual && !row.values.heat_no;
    await E.setLinePart('5', 'setup-flow-1');
    out.nextAsksActual = !!document.querySelector('[data-key="billet_temp"][data-which="actual"]') && !document.body.innerText.includes('enter the sheet setpoints only');
    out.sheetValueHint = document.querySelector('[data-key="billet_temp"][data-which="actual"]').placeholder === '2300';
    await E.setLinePart('5', 'setup-flow-2'); E.S.actualsNow = true; E.draw();
    out.alsoActuals = !!document.querySelector('[data-key="billet_temp"][data-which="actual"]');
    return out;
  })()`);
  console.log('setup-first', JSON.stringify(setup));
  // v0.2.0 flows through the real renderer: new-part confirmation, correct, void
  const flow = await run(`(async () => {
    const E = ST.tabs.entry; const out = {};
    E.S = null; await ST.show('entry');
    await E.setLinePart('5', 'smoke-new-1');
    out.banner = !!document.getElementById('newpart-note');
    E.val('nitrogen').setpoint = '450'; // a new part's first entry is its sheet: setpoints only
    await E.save();
    out.blockedUntilConfirmed = (await ST.api('listEntries', { part: 'smoke-new-1' })).total === 0;
    E.S.newPartOk = E.S.line + '|' + E.S.part;
    await E.save();
    const first = (await ST.api('listEntries', { part: 'smoke-new-1' })).rows[0];
    out.saved = !!first;
    await E.setLinePart('5', 'SMOKE-NEW-1');
    out.sameSpelling = E.S.partInfo.exists && E.S.part === 'smoke-new-1';
    E.prefill(first, true); await ST.show('entry');
    E.val('nitrogen').actual = '455'; E.S.correctReason = 'smoke typo';
    await E.save();
    const live = (await ST.api('listEntries', { part: 'smoke-new-1' })).rows;
    out.corrected = live.length === 1 && live[0].values.nitrogen.actual === '455';
    const all = (await ST.api('listEntries', { part: 'smoke-new-1', includeVoided: true })).rows;
    out.keptOnRecord = all.length === 2 && all.some((e) => e.voided && e.void_reason === 'smoke typo');
    await ST.api('voidEntry', live[0].id, 'smoke void');
    out.voided = (await ST.api('listEntries', { part: 'smoke-new-1' })).total === 0;
    await ST.show('data'); await ST.show('settings');
    out.partsCard = document.body.innerText.includes('Parts (');
    return out;
  })()`);
  console.log('flow', JSON.stringify(flow));
  const flowOk = Object.values(flow).every(Boolean);
  // field types through the real renderer: dropdowns / pickers, canonical storage, validation
  const types = await run(`(async () => {
    const out = {};
    const add = (label, kind, extra = {}) => ST.api('addField', { label, kind, has_sp: false, forms: [10899], section: 'readings', ...extra });
    await add('Smoke pump OK', 'yesno'); await add('Smoke start', 'time'); await add('Smoke cycle', 'duration', { unit: 's', min: '5', max: '9' });
    await add('Smoke surface', 'rating', { max: '10' }); await add('Smoke fill', 'ratio');
    await ST.refreshCore();
    const key = (l) => ST.state.fields.find((f) => f.label === l).key;
    const E = ST.tabs.entry; E.S = null; await ST.show('entry'); await E.setLinePart('5', '6120-C');
    out.dropdowns = !!document.querySelector('select[data-key="' + key('Smoke pump OK') + '"]') && !!document.querySelector('select[data-key="' + key('Smoke surface') + '"]');
    out.timePicker = !!document.querySelector('input[type=time][data-key="' + key('Smoke start') + '"]');
    const type = (l, v) => { const el = document.querySelector('[data-key="' + key(l) + '"][data-which="actual"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    type('Smoke pump OK', 'Yes'); type('Smoke start', '18:05'); type('Smoke cycle', '12'); type('Smoke surface', '7'); type('Smoke fill', '3 of 5');
    out.rangeFlag = document.querySelector('[data-key="' + key('Smoke cycle') + '"]').classList.contains('oor');
    await E.save();
    const row = (await ST.api('listEntries', { part: '6120-C', limit: 1 })).rows[0];
    const v = (l) => row.values[key(l)] && row.values[key(l)].actual;
    out.canonical = v('Smoke pump OK') === 'Yes' && v('Smoke start') === '18:05' && v('Smoke surface') === '7' && v('Smoke fill') === '3/5';
    out.rangeStored = row.range[key('Smoke cycle')] === 'high';
    let rejected = false;
    try { await ST.api('saveEntry', { line: 5, part_no: '6120-C', values: { [key('Smoke surface')]: { actual: '99' } } }); } catch (e) { rejected = /rating/.test(e.message); }
    out.rejectsBad = rejected;
    const t = await ST.api('trend', { line: 5, part: '6120-C', key: key('Smoke start') });
    out.timeCharted = t.points.length === 1 && t.points[0].actual === 1085;
    return out;
  })()`);
  console.log('types', JSON.stringify(types));
  await shot('crimson-types');
  // Excel template: preview modal, then apply it
  await run(`ST.tabs.forms.sel = 10899; ST.show('forms')`);
  await run(`ST.main = ((orig) => (name, ...a) => (name === 'template:pick' ? Promise.resolve(${JSON.stringify(tpl)}) : orig(name, ...a)))(ST.main); window.__imp = ST.tabs.forms.importTemplate(async () => { await ST.refreshCore(); }); 0`);
  await new Promise((r) => setTimeout(r, 800));
  const modalShown = await run(`!!document.querySelector('.modal .plan-sum') && document.querySelector('.modal').innerText.includes('Coolant ppm')`);
  await shot('crimson-import');
  await run(`document.querySelector('.modal .btn.primary').click(); 0`);
  await run(`window.__imp.then(() => true)`);
  const imported = await run(`(async () => {
    const f = await ST.api('getFields'); const out = {};
    out.renamed = f.some((x) => x.key === 'billet_temp' && x.label === 'Billet temperature (smoke)');
    out.newFields = f.some((x) => x.label === 'Coolant ppm' && x.min === '100') && f.some((x) => x.label === 'Coolant clear?' && x.kind === 'yesno');
    out.newForm = (await ST.api('getForms')).some((x) => x.form_no === 200 && x.name === 'Second job');
    out.line = (await ST.api('getLineForms')).some((l) => l.line === 12 && l.form_no === 200);
    out.role = (await ST.api('getFormFields', 10899)).find((x) => x.key === 'lube_head').role === 'initial';
    return out;
  })()`);
  console.log('template', JSON.stringify({ modalShown, ...imported }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // choosing a type in the field creator offers that type's setup (rating scale, allowed values, limits)
  const creator = await run(`(async () => {
    ST.tabs.forms.sel = 10899; await ST.show('forms');
    const out = {};
    const q = (label) => document.querySelector('[aria-label="' + label + '"]');
    const pick = (value) => { const t = q('Type'); t.value = value; t.dispatchEvent(new Event('change', { bubbles: true })); };
    const fill = (label, v) => { const el = q(label); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    pick('rating');
    out.ratingInputs = !!q('Rating from') && !!q('to') && q('to').value === '5';
    fill('New field name', 'Smoke rating'); fill('to', '10');
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create field').click();
    await new Promise((r) => setTimeout(r, 600));
    pick('choice');
    out.choiceInput = !!q('Allowed values') && !q('Rating from');
    pick('number');
    out.limitInputs = !!q('Min') && !!q('Max');
    const f = (await ST.api('getFields')).find((x) => x.label === 'Smoke rating');
    out.created = !!f && f.kind === 'rating' && f.min === '1' && f.max === '10';
    return out;
  })()`);
  console.log('creator', JSON.stringify(creator));
  // in-app updater: the card and the header pill follow what the updater reports (a development run has no real updater)
  const upd = {};
  upd.devMessage = await run(`(async () => { await ST.show('about'); return document.getElementById('update-card').innerText.includes('development run'); })()`);
  const push = async (st) => { win.webContents.send('update:status', { current: '0.3.0', auto: true, ...st }); await sleep(250); };
  await push({ state: 'available', latest: '9.9.9', notes: 'Adds rating setup\nIn-app updates' });
  upd.pill = await run(`!!document.querySelector('.update-pill')`);
  upd.available = await run(`document.getElementById('update-card').innerText.includes('Version 9.9.9 is available') && document.getElementById('update-card').innerText.includes('Download 9.9.9')`);
  await shot('crimson-update');
  await push({ state: 'downloading', latest: '9.9.9', percent: 40 });
  upd.progress = await run(`document.getElementById('update-card').innerText.includes('40%')`);
  await push({ state: 'ready', latest: '9.9.9', percent: 100 });
  upd.ready = await run(`document.getElementById('update-card').innerText.includes('Restart and update') && document.querySelector('.update-pill.ready') !== null`);
  await push({ state: 'error', error: 'Could not reach GitHub.', silent: true });
  upd.error = await run(`document.getElementById('update-card').innerText.includes('Could not reach GitHub') && !document.querySelector('.update-pill')`);
  await push({ state: 'none', checkedAt: Date.now() });
  upd.upToDate = await run(`document.getElementById('update-card').innerText.includes('up to date')`);
  console.log('updater', JSON.stringify(upd));
  // old setup sheets in from Excel: preview with a bad row, skip it, import the rest
  await run(`ST.main = ((orig) => (name, ...a) => (name === 'history:pick' ? Promise.resolve(${JSON.stringify(hfile)}) : orig(name, ...a)))(ST.main); ST.show('export').then(() => { window.__hist = ST.importHistory(async () => {}); }); 0`);
  await sleep(1000);
  const histModal = await run(`(() => { const t = document.querySelector('.modal')?.innerText || ''; return { shown: t.includes('Entries to add') && t.includes('Row 4') && t.includes('not a number'), cannotApplyYet: !!document.querySelector('.modal .btn.primary') && document.querySelector('.modal .btn.primary').textContent === 'Close' }; })()`);
  await run(`document.querySelector('.modal input[type=checkbox]').click(); 0`);
  await sleep(700);
  histModal.canSkip = await run(`document.querySelector('.modal .btn.primary').textContent.startsWith('Import 2 entries')`);
  await shot('crimson-history-import');
  await run(`document.querySelector('.modal .btn.primary').click(); 0`);
  await run(`window.__hist.then(() => true)`);
  const histDone = await run(`(async () => {
    const rows = (await ST.api('listEntries', { part: 'HIST-1' })).rows.slice().reverse();
    return rows.length === 2 && rows[0].values.billet_temp.setpoint === '2300' && !rows[0].values.billet_temp.actual && /Source: HIST-1_0105.pdf/.test(rows[0].notes) && rows[1].values.billet_temp.actual === '2310' && /NEEDS REVIEW: hard to read/.test(rows[1].notes);
  })()`);
  console.log('history', JSON.stringify({ ...histModal, imported: histDone }));
  const histOk = Object.values(histModal).every(Boolean) && histDone;
  // Profiles: a second, separate database; the window reloads onto it
  const reloaded = () => new Promise((r) => win.webContents.once('did-finish-load', r));
  let wait = reloaded();
  await run(`void ST.main('profile:create', { name: 'Second job', blank: true, copyForms: false }); 0`);
  await wait; await sleep(900);
  const second = await run(`(async () => {
    await ST.show('dashboard');
    const out = {};
    out.emptyGuide = document.body.innerText.includes('Set up this profile');
    out.switcher = !!document.querySelector('.profile-sel');
    out.separate = (await ST.api('getFields')).length === 0 && (await ST.api('listEntries', {})).total === 0 && (await ST.api('getForms')).length === 0;
    return out;
  })()`);
  await shot('crimson-profile-empty');
  await run(`ST.main = ((orig) => (name, ...a) => (name === 'template:pick' ? Promise.resolve(${JSON.stringify(tpl)}) : orig(name, ...a)))(ST.main); ST.tabs.forms.sel = 200; ST.show('forms').then(() => { window.__imp = ST.tabs.forms.importTemplate(async () => { await ST.refreshCore(); }); }); 0`);
  await sleep(1200);
  await run(`document.querySelector('.modal .btn.primary').click(); 0`);
  await run(`window.__imp.then(() => true)`);
  const second2 = await run(`(async () => {
    const out = {};
    await ST.api('setSettings', { label_line: 'Station', label_part: 'Product' });
    await ST.refreshCore();
    out.labels = ST.L.line === 'Station' && ST.L.parts === 'Products';
    out.forms = (await ST.api('getForms')).map((f) => f.form_no).sort((a, b) => a - b).join(',') === '200,10899';
    out.lines = (await ST.api('getLineForms')).some((l) => l.line === 12 && l.form_no === 200);
    const E = ST.tabs.entry; E.S = null; await ST.show('entry'); await E.setLinePart('12', 'P-1');
    const text = document.body.innerText.toLowerCase();
    out.entryUsesLabels = text.includes('product') && text.includes('station 12') && !text.includes('part no');
    return out;
  })()`);
  await shot('crimson-profile-job');
  wait = reloaded();
  await run(`void ST.main('profile:switch', 'default'); 0`);
  await wait; await sleep(900);
  const back = await run(`(async () => {
    await ST.show('dashboard');
    const out = {};
    out.entriesBack = (await ST.api('listEntries', {})).total > 100;
    out.labelsBack = ST.L.line === 'Line';
    out.fieldsBack = (await ST.api('getFields')).length > 50;
    return out;
  })()`);
  console.log('profiles', JSON.stringify({ ...second, ...second2, ...back }));
  const profilesOk = [second, second2, back].every((o) => Object.values(o).every(Boolean));
  const typesOk = profilesOk && histOk && Object.values(setup).every(Boolean) && Object.values(creator).every(Boolean) && Object.values(upd).every(Boolean) && Object.values(types).every(Boolean) && modalShown && Object.values(imported).every(Boolean);
  const bad = errors.length || !pdfOk || !flowOk || !typesOk;
  if (errors.length) console.error('Renderer errors:\n' + errors.join('\n'));
  console.log(bad ? 'SMOKE FAILED' : `SMOKE OK (${THEMES.length * TABS.length} screenshots in docs/screenshots)`);
  app.exit(bad ? 1 : 0);
});
