'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SetupService, dayLocal } = require('./service');
const { toCsv, toXlsx } = require('./export');
const { reportHtml } = require('./report');
const { ProfileManager } = require('./profiles');
const { createUpdater } = require('./updater');

const API = new Set([
  'getSettings', 'setSettings', 'getPaths', 'getFields', 'fieldsForForm', 'updateField', 'addField', 'deleteField',
  'getSections', 'getForms', 'addForm', 'updateForm', 'renameForm', 'deleteForm', 'getFormFields', 'setFormField', 'removeFormField', 'applyFieldMap',
  'getLineForms', 'setLineForm', 'removeLine', 'formFor', 'listParts', 'allParts', 'listPartsDetailed', 'checkPart', 'renamePart',
  'valueSuggestions', 'saveEntry', 'voidEntry', 'restoreEntry', 'updateNotes',
  'latestValues', 'lastHeader', 'listEntries', 'getEntry', 'dashboard', 'trend', 'compareTrend', 'driftAlerts',
  'addSection', 'renameSection', 'deleteSection', 'previewTemplate', 'applyTemplate', 'previewHistory', 'applyHistory',
  'ackDrift', 'listBackups', 'integrityCheck', 'backupNow', 'getAudit', 'loadSampleData', 'removeSampleData',
]);

let svc;
let win;
let pm;
let updater;

const rootDir = () => process.env.SETUP_TRACKER_DATA_DIR || path.join(os.homedir(), '.setup_tracker');
function openProfile(id) {
  return new SetupService({ dataDir: pm.dirOf(id), blank: !!pm.get(id).blank });
}
function updateTitle() {
  const list = pm.list();
  const name = list.find((p) => p.active)?.name;
  win?.setTitle(list.length > 1 && name ? `Setup Tracker — ${name}` : 'Setup Tracker');
}
// Open another profile's database and reload the window onto it.
function switchTo(id) {
  const next = openProfile(id);
  const prev = svc;
  svc = next;
  pm.setActive(id);
  try { prev?.close(); } catch { /* ignore */ }
  updateTitle();
  win?.webContents.reload();
}

function reportDir() {
  const s = svc.getSettings();
  const id = pm.activeId();
  return s.report_dir || path.join(os.homedir(), 'Documents', 'SetupTracker', 'Reports', ...(id === 'default' ? [] : [id]));
}

async function makePdf(endDay) {
  const data = svc.weeklyReportData(endDay);
  const html = reportHtml(data, { version: app.getVersion(), title: pm.get(pm.activeId()).name });
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
  h('update:state', () => ({ ...updater.getState(), auto: pm.getApp().autoUpdate }));
  h('update:check', () => updater.check({ silent: false }));
  h('update:download', () => updater.download());
  h('update:install', () => updater.install());
  h('update:setAuto', (on) => { pm.setApp({ autoUpdate: !!on }); return pm.getApp().autoUpdate; });
  h('profile:list', () => ({ active: pm.activeId(), profiles: pm.list() }));
  h('profile:switch', (id) => { switchTo(id); return true; });
  h('profile:create', ({ name, blank = true, copyForms = false }) => {
    const id = pm.create({ name, blank });
    try {
      if (copyForms) {
        const tmp = path.join(os.tmpdir(), `st-forms-${Date.now()}.xlsx`);
        fs.writeFileSync(tmp, svc.exportTemplate({ forms: 'all' }));
        const fresh = openProfile(id);
        try { fresh.applyTemplate(tmp); } finally { fresh.close(); try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      }
      switchTo(id);
    } catch (e) { try { pm.remove(id); } catch { /* ignore */ } throw e; }
    return id;
  });
  h('profile:rename', (id, name) => { pm.rename(id, name); updateTitle(); return pm.list(); });
  h('profile:remove', (id) => ({ kept: pm.remove(id) }));
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
  h('template:export', async (opts) => {
    const bytes = svc.exportTemplate(opts || {});
    const one = opts?.forms && opts.forms !== 'all' && [].concat(opts.forms).length === 1 ? `form-${[].concat(opts.forms)[0]}` : (opts?.blank ? 'blank' : 'all-forms');
    const r = await dialog.showSaveDialog(win, { title: 'Save form template', defaultPath: `setup-tracker-template-${one}.xlsx`, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, bytes);
    svc.audit('template-export', r.filePath);
    return { file: r.filePath };
  });
  h('history:export', async ({ form }) => {
    const bytes = svc.exportHistoryTemplate({ form });
    const r = await dialog.showSaveDialog(win, { title: 'Save history template', defaultPath: `setup-tracker-history-form-${form}.xlsx`, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, bytes);
    svc.audit('history-template-export', r.filePath);
    return { file: r.filePath };
  });
  h('history:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import entries from Excel', properties: ['openFile'], filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('template:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import form template', properties: ['openFile'], filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    return r.canceled ? null : r.filePaths[0];
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
  win.on('page-title-updated', (e) => e.preventDefault()); // the title shows the active profile
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
      pm = new ProfileManager(rootDir());
      svc = openProfile(pm.activeId());
    } catch (e) {
      dialog.showErrorBox('Setup Tracker cannot open its database', String(e.stack || e));
      app.quit();
      return;
    }
    updater = createUpdater({
      autoUpdater: app.isPackaged ? require('electron-updater').autoUpdater : null,
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion(),
      send: (st) => win?.webContents.send('update:status', { ...st, auto: pm.getApp().autoUpdate }),
      beforeInstall: async () => { svc.backupNow('pre-update', true); },
    });
    register();
    createWindow();
    updateTitle();
    updater.startAutoCheck({ enabled: () => pm.getApp().autoUpdate });
    win.webContents.once('did-finish-load', () => setTimeout(autoReport, 1500));
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('before-quit', () => { try { svc?.close(); } catch { /* ignore */ } });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { makePdf };
