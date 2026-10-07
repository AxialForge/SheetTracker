'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SetupService, dayLocal } = require('./service');
const { toCsv, toXlsx } = require('./export');
const { reportHtml } = require('./report');

const API = new Set([
  'getSettings', 'setSettings', 'getPaths', 'getFields', 'fieldsForForm', 'updateField', 'addField', 'deleteField',
  'getSections', 'getForms', 'addForm', 'updateForm', 'renameForm', 'deleteForm', 'getFormFields', 'setFormField', 'removeFormField', 'applyFieldMap',
  'getLineForms', 'setLineForm', 'removeLine', 'formFor', 'listParts', 'allParts', 'saveEntry', 'updateNotes',
  'latestValues', 'lastHeader', 'listEntries', 'getEntry', 'dashboard', 'trend', 'compareTrend', 'driftAlerts',
  'ackDrift', 'listBackups', 'integrityCheck', 'backupNow', 'getAudit', 'loadSampleData', 'removeSampleData',
]);

let svc;
let win;

function reportDir() {
  const s = svc.getSettings();
  return s.report_dir || path.join(os.homedir(), 'Documents', 'SetupTracker', 'Reports');
}

async function makePdf(endDay) {
  const data = svc.weeklyReportData(endDay);
  const html = reportHtml(data, { version: app.getVersion() });
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await w.webContents.printToPDF({ pageSize: 'Letter', printBackground: true });
    const dir = reportDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `weekly-change-report-${data.end}.pdf`);
    fs.writeFileSync(file, pdf);
    svc.setSetting('last_report_ts', new Date().toISOString());
    svc.audit('report', file);
    return { file, data };
  } finally { w.destroy(); }
}

async function autoReport() {
  const s = svc.getSettings();
  if (s.weekly_auto !== '1') return;
  const last = s.last_report_ts ? Date.parse(s.last_report_ts) : 0;
  if (Date.now() - last < 7 * 24 * 3600 * 1000) return;
  try {
    const r = await makePdf(dayLocal(new Date()));
    win?.webContents.send('report:auto', r.file);
  } catch (e) { console.error('auto report failed', e); }
}

function register() {
  ipcMain.handle('api', (_e, method, args) => {
    try {
      if (!API.has(method)) throw new Error(`Unknown method ${method}`);
      return { ok: true, value: svc[method](...(args || [])) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  const h = (name, fn) => ipcMain.handle(name, async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  h('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform }));
  h('dlg:pickPhoto', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Attach sheet photo', properties: ['openFile'], filters: [{ name: 'Images / PDF', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'pdf'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('photo:open', (name) => shell.openPath(svc.photoPath(name)));
  h('export:file', async ({ format, filters }) => {
    const { headers, rows } = svc.exportRows(filters || {});
    const base = `setup-tracker-${filters?.part ? `L${filters.line}-${filters.part}` : 'all'}-${dayLocal(new Date())}`;
    const r = await dialog.showSaveDialog(win, { title: 'Export', defaultPath: `${base}.${format}`, filters: [format === 'xlsx' ? { name: 'Excel workbook', extensions: ['xlsx'] } : { name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, format === 'xlsx' ? toXlsx(headers, rows) : toCsv(headers, rows));
    svc.audit('export', `${r.filePath} (${rows.length} rows)`);
    return { file: r.filePath, rows: rows.length };
  });
  h('chart:png', async (dataUrl, name) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save chart', defaultPath: `${name || 'chart'}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    return r.filePath;
  });
  h('report:create', (end) => makePdf(end).then((r) => ({ file: r.file, changes: r.data.changes.length })));
  h('report:dir', () => reportDir());
  h('dir:chooseReport', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Report folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    svc.setSetting('report_dir', r.filePaths[0]);
    return r.filePaths[0];
  });
  h('dir:chooseBackup', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Backup folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    return svc.setBackupDir(r.filePaths[0]);
  });
  h('backup:restore', (file) => svc.restore(file));
  h('backup:pickRestore', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Restore from backup file', defaultPath: svc.backupDir, properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('db:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import a v3 / Setup Tracker database', properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite'] }] });
    return r.canceled ? null : svc.importDatabase(r.filePaths[0]);
  });
  h('shell:openFolder', (p) => { fs.mkdirSync(p, { recursive: true }); return shell.openPath(p); });
  h('shell:showItem', (p) => shell.showItemInFolder(p));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 1000, minHeight: 640, backgroundColor: '#141312', title: 'Setup Tracker',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  return win;
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    try {
      svc = new SetupService({ dataDir: process.env.SETUP_TRACKER_DATA_DIR || undefined });
    } catch (e) {
      dialog.showErrorBox('Setup Tracker cannot open its database', String(e.stack || e));
      app.quit();
      return;
    }
    register();
    createWindow();
    win.webContents.once('did-finish-load', () => setTimeout(autoReport, 1500));
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('before-quit', () => { try { svc?.close(); } catch { /* ignore */ } });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { makePdf };
