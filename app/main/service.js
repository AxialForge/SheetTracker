'use strict';
// Setup Tracker data service: SQLite schema, change detection, drift, backups, import.
// Pure Node (node:sqlite) so it is unit-testable without Electron.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const C = require('../shared/compare');
const F = require('./fields');

const SCHEMA_VERSION = 3;
const BACKUP_THROTTLE_MS = 5 * 60 * 1000;
const BACKUP_KEEP = 100;
const MISSING = 'MISSING';

const pad = (n) => String(n).padStart(2, '0');
function tsLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dayLocal(d = new Date()) { return tsLocal(d).slice(0, 10); }
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);

function migrate(db) {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  if (v < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fields(key TEXT PRIMARY KEY, label TEXT NOT NULL, section TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'number', unit TEXT DEFAULT '', visible INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0, custom INTEGER NOT NULL DEFAULT 0, has_sp INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS parts(line INTEGER NOT NULL, part_no TEXT NOT NULL, PRIMARY KEY(line, part_no));
      CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY AUTOINCREMENT, line INTEGER NOT NULL,
        part_no TEXT NOT NULL, entry_ts TEXT NOT NULL, entered_by TEXT DEFAULT '', sheet_rev TEXT DEFAULT '',
        sheet_revised TEXT DEFAULT '', hmi_file TEXT DEFAULT '', notes TEXT DEFAULT '', source TEXT DEFAULT 'manual');
      CREATE TABLE IF NOT EXISTS entry_values(entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        key TEXT NOT NULL, setpoint TEXT, actual TEXT, PRIMARY KEY(entry_id, key));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
        user TEXT DEFAULT '', action TEXT NOT NULL, detail TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS line_forms(line INTEGER PRIMARY KEY, form_no INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_entries_lp ON entries(line, part_no, entry_ts);
      PRAGMA user_version = 2;`);
    v = 2;
  }
  if (v < 3) {
    const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
    if (!cols.includes('reason')) db.exec('ALTER TABLE entries ADD COLUMN reason TEXT DEFAULT \'\'');
    if (!cols.includes('photo_path')) db.exec('ALTER TABLE entries ADD COLUMN photo_path TEXT DEFAULT \'\'');
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS drift_ack(line INTEGER NOT NULL, part_no TEXT NOT NULL, key TEXT NOT NULL,
        acked_ts TEXT NOT NULL, PRIMARY KEY(line, part_no, key));
      PRAGMA user_version = 3;`);
  }
}

class SetupService {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || path.join(os.homedir(), '.setup_tracker');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.configPath = path.join(this.dataDir, 'config.json');
    this.config = this._readConfig();
    this.dbPath = opts.dbPath || this.config.dbPath || path.join(this.dataDir, 'setups.db');
    this.photosDir = opts.photosDir || this.config.photosDir || path.join(this.dataDir, 'photos');
    this.backupDir = opts.backupDir || this.config.backupDir || path.join(this.dataDir, 'backups');
    this.now = opts.now || (() => new Date());
    this.lastBackupAt = 0;
    this._depth = 0;
    this._cache = null;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(this.photosDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    this._open();
  }

  // ---------- lifecycle ----------
  _readConfig() {
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch { return {}; }
  }
  _writeConfig(patch) {
    this.config = { ...this.config, ...patch };
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }
  _open() {
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;');
    const before = this.db.prepare('PRAGMA user_version').get().user_version;
    const hasData = before > 0;
    if (hasData && before < SCHEMA_VERSION) this.backupNow('pre-migrate', true);
    migrate(this.db);
    this._seed();
    this._cache = null;
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  _seed() {
    const db = this.db;
    const n = db.prepare('SELECT COUNT(*) c FROM fields').get().c;
    if (n === 0) {
      const ins = db.prepare('INSERT OR IGNORE INTO fields(key,label,section,kind,unit,visible,sort,custom,has_sp) VALUES(?,?,?,?,?,1,?,0,?)');
      F.allDefaults().forEach((f, i) => ins.run(f[0], f[1], f[2], f[3], f[4], (i + 1) * 10, f[5]));
    }
    if (db.prepare('SELECT COUNT(*) c FROM line_forms').get().c === 0) {
      const ins = db.prepare('INSERT INTO line_forms(line, form_no) VALUES(?,?)');
      Object.entries(F.DEFAULT_LINE_FORMS).forEach(([l, f]) => ins.run(Number(l), f));
    }
    const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
    Object.entries(F.DEFAULT_SETTINGS).forEach(([k, v]) => ins.run(k, v));
  }

  _tx(fn) {
    if (this._depth > 0) { this._cache = null; return fn(); } // nested: ride the outer transaction
    this._depth = 1;
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); this._cache = null; return r; } catch (e) { this.db.exec('ROLLBACK'); this._cache = null; throw e; } finally { this._depth = 0; }
  }
  audit(action, detail = '', user) {
    this.db.prepare('INSERT INTO audit(ts,user,action,detail) VALUES(?,?,?,?)')
      .run(new Date(this.now()).toISOString(), user ?? this.getSettings().entered_by ?? '', action, detail);
  }

  // ---------- settings ----------
  getSettings() {
    const out = {};
    for (const r of this.db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
    return out;
  }
  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value ?? ''));
    return true;
  }
  setSettings(map) {
    this._tx(() => Object.entries(map).forEach(([k, v]) => this.setSetting(k, v)));
    return this.getSettings();
  }
  getPaths() {
    return { dataDir: this.dataDir, dbPath: this.dbPath, backupDir: this.backupDir, photosDir: this.photosDir };
  }
  setBackupDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.backupDir = dir;
    this._writeConfig({ backupDir: dir });
    this.audit('backup-folder', dir);
    return this.getPaths();
  }

  // ---------- fields / lines ----------
  getFields() {
    return this.db.prepare('SELECT * FROM fields ORDER BY sort, key').all();
  }
  _specific() {
    const s = new Set();
    Object.values(F.FORM_SPECIFIC).forEach((arr) => arr.forEach((f) => s.add(f[0])));
    return s;
  }
  fieldsForForm(form) {
    const specific = this._specific();
    const keys = F.formKeys(Number(form));
    return this.getFields().filter((f) => f.custom || !specific.has(f.key) || keys.has(f.key));
  }
  updateField(key, patch) {
    const cur = this.db.prepare('SELECT * FROM fields WHERE key=?').get(key);
    if (!cur) throw new Error(`Unknown field: ${key}`);
    const next = {
      label: (patch.label ?? cur.label).trim() || cur.label,
      visible: patch.visible === undefined ? cur.visible : (patch.visible ? 1 : 0),
      unit: patch.unit ?? cur.unit,
      section: patch.section ?? cur.section,
    };
    this.db.prepare('UPDATE fields SET label=?, visible=?, unit=?, section=? WHERE key=?').run(next.label, next.visible, next.unit, next.section, key);
    this.audit('field-update', `${key}: ${JSON.stringify(patch)}`);
    this._cache = null;
    return this.getFields();
  }
  addField({ label, section = 'custom', kind = 'number', unit = '', has_sp = 1 }) {
    label = String(label || '').trim();
    if (!label) throw new Error('Field name is required');
    let base = 'x_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    let key = base; let i = 2;
    while (this.db.prepare('SELECT 1 FROM fields WHERE key=?').get(key)) key = `${base}_${i++}`;
    const sort = (this.db.prepare('SELECT MAX(sort) m FROM fields').get().m || 0) + 10;
    this.db.prepare('INSERT INTO fields(key,label,section,kind,unit,visible,sort,custom,has_sp) VALUES(?,?,?,?,?,1,?,1,?)')
      .run(key, label, section, kind === 'text' ? 'text' : 'number', unit, sort, has_sp ? 1 : 0);
    this.audit('field-add', `${key} (${label})`);
    this._cache = null;
    return this.getFields();
  }
  deleteField(key) {
    const f = this.db.prepare('SELECT * FROM fields WHERE key=?').get(key);
    if (!f || !f.custom) throw new Error('Only custom fields can be deleted; hide factory fields instead.');
    this._tx(() => {
      this.db.prepare('DELETE FROM entry_values WHERE key=?').run(key);
      this.db.prepare('DELETE FROM fields WHERE key=?').run(key);
    });
    this.audit('field-delete', key);
    return this.getFields();
  }
  getLineForms() {
    return this.db.prepare('SELECT line, form_no FROM line_forms ORDER BY line').all()
      .map((r) => ({ ...r, tonnage: F.PRESS_TONNAGE[r.line] || '' }));
  }
  setLineForm(line, form) {
    line = parseInt(line, 10); form = parseInt(form, 10);
    if (!line || !form) throw new Error('Line and form must be numbers');
    this.db.prepare('INSERT INTO line_forms(line,form_no) VALUES(?,?) ON CONFLICT(line) DO UPDATE SET form_no=excluded.form_no').run(line, form);
    this.audit('line-form', `L${line} -> ${form}`);
    return this.getLineForms();
  }
  removeLine(line) {
    const used = this.db.prepare('SELECT COUNT(*) c FROM entries WHERE line=?').get(line).c;
    if (used) throw new Error(`Line ${line} has ${used} entries and cannot be removed.`);
    this.db.prepare('DELETE FROM line_forms WHERE line=?').run(line);
    this.audit('line-remove', String(line));
    return this.getLineForms();
  }
  formFor(line) {
    const r = this.db.prepare('SELECT form_no FROM line_forms WHERE line=?').get(Number(line));
    return r ? r.form_no : null;
  }
  listParts(line) {
    const rows = line
      ? this.db.prepare('SELECT part_no FROM parts WHERE line=? ORDER BY part_no').all(Number(line))
      : this.db.prepare('SELECT DISTINCT part_no FROM parts ORDER BY part_no').all();
    return rows.map((r) => r.part_no);
  }
  allParts() { return this.db.prepare('SELECT line, part_no FROM parts ORDER BY line, part_no').all(); }

  // ---------- entries ----------
  saveEntry(e) {
    const line = parseInt(e.line, 10);
    const part = String(e.part_no || '').trim();
    if (!line) throw new Error('Line # is required');
    if (!part) throw new Error('Part No. is required');
    if (!this.db.prepare('SELECT 1 FROM line_forms WHERE line=?').get(line)) throw new Error(`Line ${line} is not configured (Settings → Line → Form).`);
    const fieldKeys = new Set(this.getFields().map((f) => f.key));
    const values = [];
    for (const [key, v] of Object.entries(e.values || {})) {
      if (!fieldKeys.has(key)) continue;
      const sp = C.blank(v.setpoint) ? null : String(v.setpoint).trim();
      const ac = C.blank(v.actual) ? null : String(v.actual).trim();
      if (sp === null && ac === null) continue;
      values.push([key, sp, ac]);
    }
    const notes = String(e.notes || '').trim();
    if (!values.length && !notes) throw new Error('Nothing to save: enter at least one value or a note.');
    const ts = e.entry_ts || tsLocal(this.now());
    const before = this.latestValues(line, part, ts);
    let changes = 0;
    const fieldMap = new Map(this.getFields().map((f) => [f.key, f]));
    for (const [key, , ac] of values) {
      if (fieldMap.get(key).has_sp && ac !== null && before[key] && C.changed(before[key].actual, ac)) changes++;
    }
    let photo = '';
    if (e.photo_src) photo = this._storePhoto(e.photo_src, line, part, ts);
    const id = this._tx(() => {
      this.db.prepare('INSERT OR IGNORE INTO parts(line,part_no) VALUES(?,?)').run(line, part);
      const r = this.db.prepare(`INSERT INTO entries(line,part_no,entry_ts,entered_by,sheet_rev,sheet_revised,hmi_file,notes,source,reason,photo_path)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(line, part, ts, e.entered_by || '', e.sheet_rev || '', e.sheet_revised || '',
        e.hmi_file || '', notes, e.source || 'manual', e.reason || '', photo);
      const id = Number(r.lastInsertRowid);
      const ins = this.db.prepare('INSERT INTO entry_values(entry_id,key,setpoint,actual) VALUES(?,?,?,?)');
      values.forEach(([k, sp, ac]) => ins.run(id, k, sp, ac));
      return id;
    });
    this.audit('entry-add', `#${id} L${line} ${part} ${ts} (${values.length} values, ${changes} changes)`, e.entered_by);
    if (!e.noBackup) { try { this.backupNow('auto', false); } catch { /* a failed auto backup must never block saving */ } }
    return { id, changes };
  }

  _storePhoto(src, line, part, ts) {
    if (!fs.existsSync(src)) throw new Error(`Photo not found: ${src}`);
    const ext = path.extname(src).toLowerCase() || '.jpg';
    let name = `L${line}_${safe(part)}_${ts.replace(/[-:T]/g, '')}${ext}`;
    let i = 2;
    while (fs.existsSync(path.join(this.photosDir, name))) name = name.replace(/(_\d+)?(\.[^.]+)$/, `_${i++}$2`);
    fs.copyFileSync(src, path.join(this.photosDir, name));
    return name;
  }
  photoPath(name) { return name ? path.join(this.photosDir, path.basename(name)) : ''; }

  updateNotes(id, notes) {
    const cur = this.db.prepare('SELECT notes FROM entries WHERE id=?').get(id);
    if (!cur) throw new Error('Entry not found');
    this.db.prepare('UPDATE entries SET notes=? WHERE id=?').run(String(notes || '').trim(), id);
    this.audit('notes-edit', `#${id}: "${cur.notes}" -> "${String(notes || '').trim()}"`);
    this._cache = null;
    return true;
  }

  // Load every entry once, with change/drift flags computed in chronological order per Line+Part.
  _all() {
    if (this._cache) return this._cache;
    const fields = this.getFields();
    const fm = new Map(fields.map((f) => [f.key, f]));
    const entries = this.db.prepare('SELECT * FROM entries ORDER BY line, part_no, entry_ts, id').all();
    const byId = new Map();
    for (const e of entries) { e.values = {}; e.changed = {}; e.drift = {}; byId.set(e.id, e); }
    for (const r of this.db.prepare('SELECT * FROM entry_values').all()) {
      const e = byId.get(r.entry_id);
      if (e) e.values[r.key] = { setpoint: r.setpoint, actual: r.actual };
    }
    const lastKnown = new Map();
    for (const e of entries) {
      const lp = `${e.line}|${e.part_no}`;
      if (!lastKnown.has(lp)) lastKnown.set(lp, {});
      const known = lastKnown.get(lp);
      for (const [key, v] of Object.entries(e.values)) {
        const f = fm.get(key);
        if (!f || !f.has_sp) continue;
        if (!C.blank(v.actual)) {
          if (known[key] !== undefined && C.changed(known[key], v.actual)) e.changed[key] = { from: known[key], to: v.actual };
          known[key] = v.actual;
        }
        if (C.drifted(v.setpoint, v.actual)) e.drift[key] = true;
      }
    }
    this._cache = { entries, byId, fm };
    return this._cache;
  }

  // Last known non-blank setpoint/actual for a Line+Part (carry-forward), optionally strictly before a timestamp.
  latestValues(line, part, before) {
    const out = {};
    for (const e of this._all().entries) {
      if (e.line !== Number(line) || e.part_no !== part) continue;
      if (before && e.entry_ts >= before) continue;
      for (const [key, v] of Object.entries(e.values)) {
        const cur = out[key] || { setpoint: null, actual: null, ts: null };
        if (!C.blank(v.setpoint)) cur.setpoint = v.setpoint;
        if (!C.blank(v.actual)) { cur.actual = v.actual; cur.ts = e.entry_ts; }
        out[key] = cur;
      }
    }
    return out;
  }
  lastHeader(line, part) {
    const list = this._all().entries.filter((e) => e.line === Number(line) && e.part_no === part);
    const e = list[list.length - 1];
    return e ? { sheet_rev: e.sheet_rev, sheet_revised: e.sheet_revised, hmi_file: e.hmi_file } : null;
  }

  listEntries(f = {}) {
    let rows = this._all().entries;
    if (f.line) rows = rows.filter((e) => e.line === Number(f.line));
    if (f.part) rows = rows.filter((e) => e.part_no === f.part);
    if (f.from) rows = rows.filter((e) => e.entry_ts.slice(0, 10) >= f.from);
    if (f.to) rows = rows.filter((e) => e.entry_ts.slice(0, 10) <= f.to);
    if (f.changesOnly) rows = rows.filter((e) => Object.keys(e.changed).length);
    rows = rows.slice().sort((a, b) => a.line - b.line || (a.part_no < b.part_no ? -1 : a.part_no > b.part_no ? 1 : 0) || (a.entry_ts < b.entry_ts ? 1 : a.entry_ts > b.entry_ts ? -1 : b.id - a.id));
    const total = rows.length;
    if (f.limit) rows = rows.slice(0, f.limit);
    return { total, rows };
  }
  getEntry(id) { return this._all().byId.get(Number(id)) || null; }

  allChanges(sinceTs) {
    const out = [];
    for (const e of this._all().entries) {
      if (sinceTs && e.entry_ts < sinceTs) continue;
      for (const [key, c] of Object.entries(e.changed)) {
        out.push({ entry_id: e.id, line: e.line, part_no: e.part_no, ts: e.entry_ts, key, label: this._all().fm.get(key)?.label || key, from: c.from, to: c.to, reason: e.reason });
      }
    }
    return out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.entry_id - a.entry_id));
  }

  // ---------- drift ----------
  driftAlerts() {
    const s = this.getSettings();
    if (s.opt_drift !== '1') return [];
    const n = Math.max(2, parseInt(s.drift_n, 10) || 3);
    const acks = new Map(this.db.prepare('SELECT * FROM drift_ack').all().map((a) => [`${a.line}|${a.part_no}|${a.key}`, a.acked_ts]));
    const { entries, fm } = this._all();
    const groups = new Map();
    for (const e of entries) {
      for (const [key, v] of Object.entries(e.values)) {
        const f = fm.get(key);
        if (!f || !f.has_sp || C.blank(v.setpoint) || C.blank(v.actual)) continue;
        const gk = `${e.line}|${e.part_no}|${key}`;
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push({ e, v });
      }
    }
    const out = [];
    for (const [gk, list] of groups) {
      let streak = 0;
      for (let i = list.length - 1; i >= 0 && C.drifted(list[i].v.setpoint, list[i].v.actual); i--) streak++;
      if (streak < n) continue;
      const last = list[list.length - 1];
      const acked = acks.get(gk);
      if (acked && last.e.entry_ts <= acked) continue;
      const key = gk.split('|')[2];
      out.push({
        line: last.e.line, part_no: last.e.part_no, key,
        label: fm.get(key).label, streak, setpoint: last.v.setpoint, actual: last.v.actual,
        entry_id: last.e.id, ts: last.e.entry_ts,
      });
    }
    return out.sort((a, b) => b.streak - a.streak || a.line - b.line);
  }
  ackDrift(line, part_no, key) {
    const list = this.driftAlerts().filter((a) => a.line === Number(line) && a.part_no === part_no && a.key === key);
    const ts = list[0] ? list[0].ts : tsLocal(this.now());
    this.db.prepare('INSERT INTO drift_ack(line,part_no,key,acked_ts) VALUES(?,?,?,?) ON CONFLICT(line,part_no,key) DO UPDATE SET acked_ts=excluded.acked_ts').run(Number(line), part_no, key, ts);
    this.audit('drift-ack', `L${line} ${part_no} ${key}`);
    return true;
  }

  // ---------- dashboard / charts ----------
  dashboard() {
    const now = new Date(this.now());
    const s = this.getSettings();
    const { entries, fm } = this._all();
    const dow = (now.getDay() + 6) % 7; // Monday = 0
    const wk = new Date(now); wk.setDate(now.getDate() - dow);
    const weekStart = dayLocal(wk);
    const d30 = new Date(now); d30.setDate(now.getDate() - 30);
    const since30 = tsLocal(d30);
    const today = dayLocal(now);
    const changes30 = this.allChanges(since30);
    const counts = new Map();
    changes30.forEach((c) => counts.set(c.key, (counts.get(c.key) || 0) + 1));
    const mostChanged = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([key, count]) => ({ key, label: fm.get(key)?.label || key, count }));
    const lineStatus = this.getLineForms().map((l) => {
      const mine = entries.filter((e) => e.line === l.line);
      const last = mine.reduce((m, e) => (e.entry_ts > m ? e.entry_ts : m), '');
      return { line: l.line, form_no: l.form_no, last_ts: last || null, today: mine.some((e) => e.entry_ts.slice(0, 10) === today) };
    });
    return {
      entriesThisWeek: entries.filter((e) => e.entry_ts.slice(0, 10) >= weekStart).length,
      changes30: changes30.length,
      notLoggedToday: s.opt_missing === '1' ? lineStatus.filter((l) => !l.today).length : null,
      driftAlerts: this.driftAlerts(),
      mostChanged,
      recentChanges: changes30.slice(0, 12),
      lineStatus: s.opt_missing === '1' ? lineStatus : null,
      totalEntries: entries.length,
    };
  }
  trend({ line, part, key }) {
    const f = this._all().fm.get(key);
    const pts = [];
    for (const e of this._all().entries) {
      if (e.line !== Number(line) || e.part_no !== part) continue;
      const v = e.values[key];
      if (!v || C.blank(v.actual)) continue;
      const num = parseFloat(v.actual);
      if (Number.isNaN(num)) continue;
      pts.push({ ts: e.entry_ts, actual: num, setpoint: C.blank(v.setpoint) || Number.isNaN(parseFloat(v.setpoint)) ? null : parseFloat(v.setpoint), entry_id: e.id });
    }
    return { key, label: f?.label || key, unit: f?.unit || '', points: pts };
  }
  // One series per line (that line's part with the most data for the field).
  compareTrend({ key, part }) {
    const f = this._all().fm.get(key);
    const best = new Map();
    for (const e of this._all().entries) {
      const v = e.values[key];
      if (!v || C.blank(v.actual) || Number.isNaN(parseFloat(v.actual))) continue;
      if (part && e.part_no !== part && this.allParts().some((p) => p.part_no === part)) continue;
      const k = `${e.line}|${e.part_no}`;
      if (!best.has(k)) best.set(k, { line: e.line, part_no: e.part_no, points: [] });
      best.get(k).points.push({ ts: e.entry_ts, actual: parseFloat(v.actual) });
    }
    const perLine = new Map();
    for (const s of best.values()) {
      const cur = perLine.get(s.line);
      if (!cur || s.points.length > cur.points.length) perLine.set(s.line, s);
    }
    return { key, label: f?.label || key, unit: f?.unit || '', series: [...perLine.values()].sort((a, b) => a.line - b.line) };
  }

  // ---------- export ----------
  exportRows({ line, part, from, to, includeReason = true } = {}) {
    const fields = this.getFields().filter((f) => f.visible);
    const { rows } = this.listEntries({ line, part, from, to });
    const used = new Set();
    rows.forEach((e) => Object.keys(e.values).forEach((k) => used.add(k)));
    const cols = fields.filter((f) => used.has(f.key));
    const headers = ['Line', 'Part No', 'Date/Time', 'Sheet Rev', 'Revised', 'HMI File', 'Entered By'];
    if (includeReason) headers.push('Reason');
    headers.push('Notes', 'Changed Fields');
    cols.forEach((f) => {
      const u = f.unit ? ` (${f.unit})` : '';
      if (f.has_sp) { headers.push(`${f.label}${u} - Setpoint`, `${f.label}${u} - Actual`); } else headers.push(`${f.label}${u}`);
    });
    const labels = new Map(this.getFields().map((f) => [f.key, f.label]));
    const data = rows.map((e) => {
      const r = [e.line, e.part_no, e.entry_ts.replace('T', ' '), e.sheet_rev, e.sheet_revised, e.hmi_file, e.entered_by];
      if (includeReason) r.push(e.reason);
      r.push(e.notes, Object.keys(e.changed).map((k) => labels.get(k) || k).join('; '));
      for (const f of cols) {
        const v = e.values[f.key] || {};
        if (f.has_sp) r.push(v.setpoint ?? '', v.actual ?? ''); else r.push(v.actual ?? '');
      }
      return r;
    });
    return { headers, rows: data };
  }

  // ---------- weekly report data ----------
  weeklyReportData(endDay) {
    const end = endDay || dayLocal(new Date(this.now()));
    const d = new Date(`${end}T00:00:00`); d.setDate(d.getDate() - 6);
    const start = dayLocal(d);
    const entries = this.listEntries({ from: start, to: end }).rows;
    const changes = this.allChanges().filter((c) => c.ts.slice(0, 10) >= start && c.ts.slice(0, 10) <= end)
      .sort((a, b) => a.line - b.line || (a.part_no < b.part_no ? -1 : 1) || (a.ts < b.ts ? -1 : 1));
    const reasons = {};
    entries.forEach((e) => { if (e.reason) reasons[e.reason] = (reasons[e.reason] || 0) + 1; });
    return { start, end, entries: entries.length, changes, reasons, drift: this.driftAlerts(), lines: this.getLineForms().map((l) => ({
      line: l.line, entries: entries.filter((e) => e.line === l.line).length })) };
  }

  // ---------- backups ----------
  backupNow(reason = 'manual', force = true) {
    const nowMs = new Date(this.now()).getTime();
    if (!force && nowMs - this.lastBackupAt < BACKUP_THROTTLE_MS) return null;
    fs.mkdirSync(this.backupDir, { recursive: true });
    let file = path.join(this.backupDir, `setups-${stamp(new Date(this.now()))}-${safe(reason)}.db`);
    let i = 2;
    while (fs.existsSync(file)) file = file.replace(/(-\d+)?\.db$/, `-${i++}.db`);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    this.lastBackupAt = nowMs;
    // photos ride along: mirror any new files into <backupDir>/photos
    try {
      const pdst = path.join(this.backupDir, 'photos');
      fs.mkdirSync(pdst, { recursive: true });
      for (const f of fs.readdirSync(this.photosDir)) {
        if (!fs.existsSync(path.join(pdst, f))) fs.copyFileSync(path.join(this.photosDir, f), path.join(pdst, f));
      }
    } catch { /* photo mirroring is best effort */ }
    this._prune();
    return file;
  }
  _prune() {
    const list = this.listBackups();
    list.slice(BACKUP_KEEP).forEach((b) => { try { fs.unlinkSync(b.path); } catch { /* ignore */ } });
  }
  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir).filter((n) => /^setups-.*\.db$/.test(n)).map((n) => {
      const p = path.join(this.backupDir, n); const st = fs.statSync(p);
      const m = n.match(/^setups-(\d{8}-\d{6})-(.*?)(?:-\d+)?\.db$/);
      return { name: n, path: p, size: st.size, mtime: st.mtimeMs, reason: m ? m[2] : '' };
    }).sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  }
  integrityCheck(file) {
    const target = file ? new DatabaseSync(file, { readOnly: true }) : this.db;
    try {
      const rows = target.prepare('PRAGMA integrity_check').all();
      const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
      return { ok, messages: rows.map((r) => r.integrity_check) };
    } finally { if (file) target.close(); }
  }
  restore(file) {
    if (!fs.existsSync(file)) throw new Error('Backup file not found');
    let probe;
    try {
      probe = new DatabaseSync(file, { readOnly: true });
      const res = probe.prepare('PRAGMA integrity_check').all();
      if (!(res.length === 1 && res[0].integrity_check === 'ok')) throw new Error('Integrity check failed: ' + res.map((r) => r.integrity_check).join('; '));
      if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE name='entries'").get()) throw new Error('Not a Setup Tracker database');
    } finally { if (probe) probe.close(); }
    const safety = this.backupNow('pre-restore', true);
    this.close();
    for (const ext of ['-journal', '-wal', '-shm']) { try { fs.unlinkSync(this.dbPath + ext); } catch { /* none */ } }
    fs.copyFileSync(file, this.dbPath);
    const pdir = path.join(path.dirname(file), 'photos');
    if (fs.existsSync(pdir)) {
      for (const f of fs.readdirSync(pdir)) {
        if (!fs.existsSync(path.join(this.photosDir, f))) fs.copyFileSync(path.join(pdir, f), path.join(this.photosDir, f));
      }
    }
    this._open();
    this.audit('restore', `${path.basename(file)} (safety copy: ${safety ? path.basename(safety) : 'none'})`);
    return { restored: path.basename(file), safety };
  }

  // ---------- import (v3 Python prototype DB, or any Setup Tracker DB) ----------
  importDatabase(file) {
    if (!fs.existsSync(file)) throw new Error('File not found');
    const src = new DatabaseSync(file, { readOnly: true });
    try {
      const ok = src.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('entries','entry_values','fields')").get().c === 3;
      if (!ok) throw new Error('Not a Setup Tracker / v3 database');
      this.backupNow('pre-import', true);
      const have = new Set(this.db.prepare('SELECT key FROM fields').all().map((f) => f.key));
      const srcCols = src.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
      let added = 0; let skipped = 0; let newFields = 0;
      this._tx(() => {
        for (const f of src.prepare('SELECT * FROM fields').all()) {
          if (have.has(f.key)) continue;
          this.db.prepare('INSERT INTO fields(key,label,section,kind,unit,visible,sort,custom,has_sp) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(f.key, f.label, f.section || 'custom', f.kind || 'number', f.unit || '', f.visible ?? 1, f.sort ?? 999, f.custom ?? 1, f.has_sp ?? 1);
          newFields++;
        }
        for (const l of src.prepare('SELECT * FROM line_forms').all()) {
          this.db.prepare('INSERT OR IGNORE INTO line_forms(line,form_no) VALUES(?,?)').run(l.line, l.form_no);
        }
        const dup = this.db.prepare('SELECT 1 FROM entries WHERE line=? AND part_no=? AND entry_ts=?');
        const vals = src.prepare('SELECT * FROM entry_values WHERE entry_id=?');
        for (const e of src.prepare('SELECT * FROM entries ORDER BY id').all()) {
          if (dup.get(e.line, e.part_no, e.entry_ts)) { skipped++; continue; }
          this.db.prepare('INSERT OR IGNORE INTO parts(line,part_no) VALUES(?,?)').run(e.line, e.part_no);
          const r = this.db.prepare(`INSERT INTO entries(line,part_no,entry_ts,entered_by,sheet_rev,sheet_revised,hmi_file,notes,source,reason,photo_path)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(e.line, e.part_no, e.entry_ts, e.entered_by || '', e.sheet_rev || '', e.sheet_revised || '',
            e.hmi_file || '', e.notes || '', 'import', srcCols.includes('reason') ? e.reason || '' : '', '');
          const id = Number(r.lastInsertRowid);
          for (const v of vals.all(e.id)) {
            this.db.prepare('INSERT OR IGNORE INTO entry_values(entry_id,key,setpoint,actual) VALUES(?,?,?,?)').run(id, v.key, v.setpoint, v.actual);
          }
          added++;
        }
      });
      this.audit('import', `${path.basename(file)}: ${added} entries, ${skipped} duplicates skipped, ${newFields} new fields`);
      return { added, skipped, newFields };
    } finally { src.close(); }
  }

  // ---------- sample data ----------
  loadSampleData() {
    const { generate } = require('./sample');
    this.backupNow('pre-sample', true);
    const n = this._tx(() => generate(this));
    this.audit('sample-load', `${n} entries`);
    return { added: n };
  }
  removeSampleData() {
    const n = this.db.prepare("SELECT COUNT(*) c FROM entries WHERE source='sample'").get().c;
    this._tx(() => {
      this.db.prepare("DELETE FROM entries WHERE source='sample'").run();
      this.db.prepare('DELETE FROM parts WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.line=parts.line AND e.part_no=parts.part_no)').run();
    });
    this.audit('sample-remove', `${n} entries`);
    return { removed: n };
  }

  getAudit(limit = 200) { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit); }
}

module.exports = { SetupService, migrate, SCHEMA_VERSION, tsLocal, dayLocal, MISSING };
