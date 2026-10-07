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
  const svc = new SetupService({ dataDir });
  svc.setSettings({ opt_missing: '1', weekly_auto: '0', report_dir: path.join(dataDir, 'reports') });
  svc.loadSampleData();
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
  // exercise save + export + report paths for real
  const saved = await run(`ST.api('saveEntry', {line: 5, part_no: '6120-C', values: {billet_temp: {setpoint: '2250', actual: '2300'}}, notes: 'smoke'})`);
  const csv = await run(`ST.main('report:create', new Date().toLocaleDateString('en-CA'))`);
  const pdfOk = fs.existsSync(csv.file) && fs.statSync(csv.file).size > 1000;
  console.log('saved', JSON.stringify(saved), 'pdf', csv.file, pdfOk);
  const bad = errors.length || !pdfOk;
  if (errors.length) console.error('Renderer errors:\n' + errors.join('\n'));
  console.log(bad ? 'SMOKE FAILED' : `SMOKE OK (${THEMES.length * TABS.length} screenshots in docs/screenshots)`);
  app.exit(bad ? 1 : 0);
});
