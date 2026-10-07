'use strict';
// Setup Tracker data service: SQLite schema, change detection, drift, backups, import.
// Pure Node (node:sqlite) so it is unit-testable without Electron.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const C = require('../shared/compare');
const T = require('../shared/types');
const F = require('./fields');
const Tpl = require('./template');
const Hist = require('./history');

const SCHEMA_VERSION = 6;
const ROLES = ['tracked', 'initial']; // tracked = changes day to day; initial = set once when a Line+Part is first entered
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

// Part numbers: trimmed with inner whitespace collapsed. "Fold" ignores case; "loose" also ignores punctuation and spaces.
const partNorm = (s) => C.norm(s);
const partFold = (s) => partNorm(s).toLowerCase();
const partLoose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Pick-list text as stored on a field: one value per line, no blanks, no case-insensitive duplicates.
function choicesText(v) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[\n;]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const t = C.norm(item);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out.join('\n');
}

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
  if (v < 4) {
    // Forms and which fields each one carries (previously hard-coded). Rows are seeded by SetupService._seedForms().
    db.exec(`
      CREATE TABLE IF NOT EXISTS forms(form_no INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS form_fields(form_no INTEGER NOT NULL, key TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'tracked' CHECK (role IN ('tracked','initial')), PRIMARY KEY(form_no, key));
      CREATE INDEX IF NOT EXISTS ix_form_fields_key ON form_fields(key);
      PRAGMA user_version = 4;`);
  }
  if (v < 5) {
    // Voiding keeps an entry on record but takes it out of change detection; pick-lists for text fields.
    const have = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const ecols = have('entries');
    const add = (name, ddl) => { if (!ecols.includes(name)) db.exec(`ALTER TABLE entries ADD COLUMN ${ddl}`); };
    add('voided', 'voided INTEGER NOT NULL DEFAULT 0');
    add('void_reason', "void_reason TEXT NOT NULL DEFAULT ''");
    add('voided_ts', "voided_ts TEXT NOT NULL DEFAULT ''");
    add('corrected_by', 'corrected_by INTEGER');
    if (!have('fields').includes('choices')) db.exec("ALTER TABLE fields ADD COLUMN choices TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE INDEX IF NOT EXISTS ix_entry_values_key ON entry_values(key)');
    const relabel = db.prepare('UPDATE fields SET label=? WHERE key=? AND label=?');
    for (const [key, from, to] of F.RELABEL_V5) relabel.run(to, key, from);
    db.prepare("UPDATE fields SET unit='µF' WHERE key='capacitance' AND (unit IS NULL OR unit='')").run();
    db.exec('PRAGMA user_version = 5;');
    v = 5;
  }
  if (v < 6) {
    // Field types beyond number/text: optional min/max (also the scale of a rating); sections move from code into the database.
    const fcols = db.prepare('PRAGMA table_info(fields)').all().map((c) => c.name);
    if (!fcols.includes('min')) db.exec("ALTER TABLE fields ADD COLUMN min TEXT NOT NULL DEFAULT ''");
    if (!fcols.includes('max')) db.exec("ALTER TABLE fields ADD COLUMN max TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE TABLE IF NOT EXISTS sections(key TEXT PRIMARY KEY, label TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0)');
    // An existing database is a press-setup one: keep the sections it has always had. A new one is seeded by _seed().
    if (db.prepare('SELECT COUNT(*) c FROM fields').get().c > 0 && db.prepare('SELECT COUNT(*) c FROM sections').get().c === 0) {
      const ins = db.prepare('INSERT INTO sections(key,label,sort) VALUES(?,?,?)');
      F.SECTIONS.forEach((sec, i) => ins.run(sec.key, sec.label, (i + 1) * 10));
    }
    // "x/5" dousing-pump condition is a rating out of 5; older values like "4/5" still read correctly.
    db.prepare("UPDATE fields SET kind='rating', min='0', max='5', unit='' WHERE key='dousing_pump' AND kind='text' AND unit='x/5'").run();
    db.exec('PRAGMA user_version = 6;');
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
    this.blank = !!opts.blank; // a new, empty profile: no press-setup fields, forms or lines
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
    this._seedForms();
    this._cache = null;
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  _seed() {
    const db = this.db;
    if (db.prepare('SELECT COUNT(*) c FROM sections').get().c === 0) {
      const ins = db.prepare('INSERT INTO sections(key,label,sort) VALUES(?,?,?)');
      (this.blank ? [{ key: 'general', label: 'General' }] : F.SECTIONS).forEach((sec, i) => ins.run(sec.key, sec.label, (i + 1) * 10));
    }
    const n = db.prepare('SELECT COUNT(*) c FROM fields').get().c;
    if (n === 0 && !this.blank) {
      const ins = db.prepare('INSERT OR IGNORE INTO fields(key,label,section,kind,unit,visible,sort,custom,has_sp) VALUES(?,?,?,?,?,1,?,0,?)');
      F.catalogDefaults().forEach((f, i) => ins.run(f[0], f[1], f[2], f[3], f[4], (i + 1) * 10, f[5]));
      this._applyExtras();
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(\'field_map\',?)').run(F.FIELD_MAP_ID);
    }
    if (db.prepare('SELECT COUNT(*) c FROM line_forms').get().c === 0 && !this.blank) {
      const ins = db.prepare('INSERT INTO line_forms(line, form_no) VALUES(?,?)');
      Object.entries(F.DEFAULT_LINE_FORMS).forEach(([l, f]) => ins.run(Number(l), f));
    }
    const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
    Object.entries(F.DEFAULT_SETTINGS).forEach(([k, v]) => ins.run(k, v));
    if (this.blank) ins.run('blank_profile', '1'); // a job set up from a template: no press-setup fields to offer
  }

  // Type details of factory fields that are not number/text (rating scale, ...).
  _applyExtras() {
    const upd = this.db.prepare('UPDATE fields SET kind=?, min=?, max=?, unit=? WHERE key=?');
    for (const [key, x] of Object.entries(F.FIELD_EXTRAS)) upd.run(x.kind, x.min || '', x.max || '', x.unit ?? '', key);
  }

  // First run on schema v4: create the forms that exist today with exactly the fields they always had.
  _seedForms() {
    if (this.blank || this.db.prepare('SELECT COUNT(*) c FROM forms').get().c > 0) return;
    const nums = new Set(F.FORMS);
    Object.values(F.DEFAULT_LINE_FORMS).forEach((n) => nums.add(n));
    this.db.prepare('SELECT DISTINCT form_no FROM line_forms').all().forEach((r) => nums.add(r.form_no));
    this._tx(() => [...nums].sort((a, b) => a - b).forEach((n) => this._createForm(n)));
  }
  // A form created without an explicit field list carries every field that is not specific to another form.
  _createForm(formNo, name = '') {
    const meta = this._mapped() ? F.FORM_META[formNo] : null;
    this.db.prepare('INSERT OR IGNORE INTO forms(form_no,name,notes) VALUES(?,?,?)').run(formNo, name || meta?.name || '', meta?.notes || '');
    if (this._mapped()) {
      const layout = F.formLayout(formNo);
      const ins2 = this.db.prepare('INSERT OR IGNORE INTO form_fields(form_no,key,role) VALUES(?,?,?)');
      const have = new Set(this.getFields().map((f) => f.key));
      if (layout) {
        for (const l of layout) if (have.has(l.key)) ins2.run(formNo, l.key, l.role);
        for (const f of this.getFields()) if (f.custom) ins2.run(formNo, f.key, 'tracked');
      }
      else { // unknown form number: the fields every real form shares, plus readings, tonnage grid and custom fields
        const core = new Set([...F.TRACKED_ALL, ...F.READINGS.map((f) => f[0]), ...F.TONNAGE.map((f) => f[0])]);
        for (const f of this.getFields()) if (f.custom || core.has(f.key)) ins2.run(formNo, f.key, 'tracked');
      }
      return;
    }
    const specific = this._specific();
    const keys = F.formKeys(formNo);
    const ins = this.db.prepare('INSERT OR IGNORE INTO form_fields(form_no,key,role) VALUES(?,?,\'tracked\')');
    for (const f of this.getFields()) if (f.custom || !specific.has(f.key) || keys.has(f.key)) ins.run(formNo, f.key);
  }
  _mapped() { return this.db.prepare('SELECT value FROM settings WHERE key=\'field_map\'').get()?.value === F.FIELD_MAP_ID; }
  // Switch an existing install to the real sheet fields: adds/updates the catalogue and re-lays the four known forms.
  // Stored entry values are never touched; generic fields stay in the field list (unattached) so history still reads.
  applyFieldMap() {
    this._tx(() => {
      const have = new Map(this.getFields().map((f) => [f.key, f]));
      let sort = (this.db.prepare('SELECT MAX(sort) m FROM fields').get().m || 0);
      const ins = this.db.prepare('INSERT INTO fields(key,label,section,kind,unit,visible,sort,custom,has_sp) VALUES(?,?,?,?,?,1,?,0,?)');
      const upd = this.db.prepare('UPDATE fields SET label=?, section=?, kind=?, unit=?, has_sp=?, visible=1 WHERE key=?');
      F.catalogDefaults().forEach((f, i) => { if (have.has(f[0])) upd.run(f[1], f[2], f[3], f[4], f[5], f[0]); else ins.run(f[0], f[1], f[2], f[3], f[4], (sort += 10), f[5]); });
      this._applyExtras();
      this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(\'field_map\',?)').run(F.FIELD_MAP_ID);
      for (const n of Object.keys(F.TRACKED_BY_FORM).map(Number)) {
        this.db.prepare('INSERT OR IGNORE INTO forms(form_no,name,notes) VALUES(?,?,?)').run(n, F.FORM_META[n].name, F.FORM_META[n].notes);
        this.db.prepare('DELETE FROM form_fields WHERE form_no=?').run(n);
        this._createForm(n);
      }
      for (const [l, fm] of Object.entries(F.DEFAULT_LINE_FORMS)) this.db.prepare('INSERT OR IGNORE INTO line_forms(line,form_no) VALUES(?,?)').run(Number(l), fm);
      this.audit('apply-field-map', F.FIELD_MAP_ID);
    });
    this._cache = null;
    return { forms: this.getForms(), fields: this.getFields() };
  }
  ensureForm(formNo) {
    formNo = parseInt(formNo, 10);
    if (!formNo) throw new Error('Form number must be a number');
    if (!this.db.prepare('SELECT 1 FROM forms WHERE form_no=?').get(formNo)) this._tx(() => this._createForm(formNo));
    return formNo;
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

  // What this profile calls its two identifiers (Settings → Names).
  _labels() {
    const s = this.getSettings();
    const line = C.norm(s.label_line) || 'Line';
    const part = C.norm(s.label_part) || 'Part No.';
    return { line, part, partShort: part.replace(/\s*(no\.?|number|#)$/i, '').trim() || part };
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
  getSections() { return this.db.prepare('SELECT key, label FROM sections ORDER BY sort, key').all(); }
  _hasSection(key) { return !!this.db.prepare('SELECT 1 FROM sections WHERE key=?').get(key); }
  // Create a section from a label (or return the existing one with that label/key).
  addSection(label) {
    const text = C.norm(label);
    if (!text) throw new Error('Section name is required');
    const hit = this.getSections().find((x) => x.key === text || x.label.toLowerCase() === text.toLowerCase());
    if (hit) return hit;
    let key = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'section';
    const base = key; let i = 2;
    while (this._hasSection(key)) key = `${base}_${i++}`;
    const sort = (this.db.prepare('SELECT MAX(sort) m FROM sections').get().m || 0) + 10;
    this.db.prepare('INSERT INTO sections(key,label,sort) VALUES(?,?,?)').run(key, text, sort);
    this.audit('section-add', `${key} (${text})`);
    return { key, label: text };
  }
  renameSection(key, label) {
    const text = C.norm(label);
    if (!text) throw new Error('Section name is required');
    if (!this._hasSection(key)) throw new Error(`Unknown section: ${key}`);
    this.db.prepare('UPDATE sections SET label=? WHERE key=?').run(text, key);
    this.audit('section-rename', `${key} -> ${text}`);
    return this.getSections();
  }
  deleteSection(key) {
    const n = this.db.prepare('SELECT COUNT(*) c FROM fields WHERE section=?').get(key).c;
    if (n) throw new Error(`${n} field${n === 1 ? ' is' : 's are'} still in this section. Move them first.`);
    this.db.prepare('DELETE FROM sections WHERE key=?').run(key);
    this.audit('section-delete', key);
    return this.getSections();
  }
  fieldsForForm(form) {
    return this.getFormFields(this.ensureForm(form));
  }
  updateField(key, patch) {
    const cur = this.db.prepare('SELECT * FROM fields WHERE key=?').get(key);
    if (!cur) throw new Error(`Unknown field: ${key}`);
    if (patch.section !== undefined && !this._hasSection(patch.section)) throw new Error(`Unknown section: ${patch.section}`);
    if (patch.kind !== undefined && !T.KINDS.some((k) => k.key === patch.kind)) throw new Error(`Unknown type: ${patch.kind}`);
    const next = {
      label: (patch.label ?? cur.label).trim() || cur.label,
      visible: patch.visible === undefined ? cur.visible : (patch.visible ? 1 : 0),
      unit: patch.unit ?? cur.unit,
      section: patch.section ?? cur.section,
      kind: patch.kind ?? cur.kind,
      has_sp: patch.has_sp === undefined ? cur.has_sp : (patch.has_sp ? 1 : 0),
      choices: patch.choices === undefined ? cur.choices : choicesText(patch.choices),
      min: patch.min === undefined ? cur.min : C.norm(patch.min),
      max: patch.max === undefined ? cur.max : C.norm(patch.max),
    };
    this._checkBounds(next);
    this.db.prepare('UPDATE fields SET label=?, visible=?, unit=?, section=?, kind=?, has_sp=?, choices=?, min=?, max=? WHERE key=?')
      .run(next.label, next.visible, next.unit, next.section, next.kind, next.has_sp, next.choices, next.min, next.max, key);
    this.audit('field-update', `${key}: ${JSON.stringify(patch)}`);
    this._cache = null;
    return this.getFields();
  }
  // min/max must parse as the field's own type; a rating's max is its scale (a whole number).
  _checkBounds(f) {
    for (const which of ['min', 'max']) {
      if (C.blank(f[which])) continue;
      if (f.kind === 'rating' || f.kind === 'choice' || f.kind === 'text' || f.kind === 'yesno' || f.kind === 'ratio' || f.kind === 'date') {
        if (f.kind === 'rating' && !/^\d+$/.test(String(f[which]).trim())) throw new Error(`${which === 'max' ? 'Scale' : 'Lowest rating'} must be a whole number`);
        continue;
      }
      const r = T.parse({ kind: f.kind }, f[which]);
      if (!r.ok) throw new Error(`${which === 'min' ? 'Minimum' : 'Maximum'}: ${r.error}`);
    }
    if (f.kind === 'rating' && !C.blank(f.max) && parseInt(f.max, 10) < 1) throw new Error('Scale must be at least 1');
    if (T.NUMERIC.has(f.kind) && f.kind !== 'rating' && f.kind !== 'ratio' && !C.blank(f.min) && !C.blank(f.max)
      && T.toNumber({ kind: f.kind }, f.min) > T.toNumber({ kind: f.kind }, f.max)) throw new Error('Minimum is above the maximum');
  }
  // forms: 'all' (default) or a list of form numbers the new field is added to; role: tracked | initial
  addField({ label, section = 'custom', kind = 'number', unit = '', has_sp = 1, forms = 'all', role = 'tracked', choices = '', min = '', max = '' }) {
    label = String(label || '').trim();
    if (!label) throw new Error('Field name is required');
    if (!T.KINDS.some((k) => k.key === kind)) throw new Error(`Unknown type: ${kind}`);
    if (!this._hasSection(section)) {
      if (section === 'custom') this.addSection('Custom'); // the default home for new fields, created on demand
      else throw new Error(`Unknown section: ${section}`);
    }
    const bounds = { kind, min: C.norm(min), max: C.norm(max) };
    this._checkBounds(bounds);
    if (!ROLES.includes(role)) throw new Error('Role must be tracked or initial');
    let base = 'x_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    let key = base; let i = 2;
    while (this.db.prepare('SELECT 1 FROM fields WHERE key=?').get(key)) key = `${base}_${i++}`;
    const sort = (this.db.prepare('SELECT MAX(sort) m FROM fields').get().m || 0) + 10;
    const targets = forms === 'all' ? this.db.prepare('SELECT form_no FROM forms').all().map((r) => r.form_no) : [].concat(forms).map(Number);
    for (const n of targets) if (!this.db.prepare('SELECT 1 FROM forms WHERE form_no=?').get(n)) throw new Error(`Form ${n} does not exist`);
    this._tx(() => {
      this.db.prepare('INSERT INTO fields(key,label,section,kind,unit,visible,sort,custom,has_sp,choices,min,max) VALUES(?,?,?,?,?,1,?,1,?,?,?,?)')
        .run(key, label, section, kind, unit, sort, has_sp ? 1 : 0, choicesText(choices), bounds.min, bounds.max);
      const ins = this.db.prepare('INSERT OR IGNORE INTO form_fields(form_no,key,role) VALUES(?,?,?)');
      targets.forEach((n) => ins.run(n, key, role));
    });
    this.audit('field-add', `${key} (${label}) -> ${targets.length ? targets.join(', ') : 'no forms'}`);
    this._cache = null;
    return this.getFields();
  }
  deleteField(key) {
    const f = this.db.prepare('SELECT * FROM fields WHERE key=?').get(key);
    if (!f || !f.custom) throw new Error('Only custom fields can be deleted; hide factory fields instead.');
    this._tx(() => {
      this.db.prepare('DELETE FROM entry_values WHERE key=?').run(key);
      this.db.prepare('DELETE FROM form_fields WHERE key=?').run(key);
      this.db.prepare('DELETE FROM fields WHERE key=?').run(key);
    });
    this.audit('field-delete', key);
    return this.getFields();
  }

  // ---------- forms ----------
  getForms() {
    const lines = this.db.prepare('SELECT line, form_no FROM line_forms ORDER BY line').all();
    const counts = this.db.prepare('SELECT form_no, role, COUNT(*) n FROM form_fields GROUP BY form_no, role').all();
    return this.db.prepare('SELECT * FROM forms ORDER BY form_no').all().map((f) => ({
      ...f,
      lines: lines.filter((l) => l.form_no === f.form_no).map((l) => l.line),
      tracked: counts.find((c) => c.form_no === f.form_no && c.role === 'tracked')?.n || 0,
      initial: counts.find((c) => c.form_no === f.form_no && c.role === 'initial')?.n || 0,
    }));
  }
  _form(formNo) {
    const f = this.db.prepare('SELECT * FROM forms WHERE form_no=?').get(Number(formNo));
    if (!f) throw new Error(`Form ${formNo} does not exist`);
    return f;
  }
  // copyFrom: a form number whose field list (and roles) the new form starts with; otherwise it starts empty.
  addForm({ form_no, name = '', notes = '', copyFrom } = {}) {
    const n = parseInt(form_no, 10);
    if (!n || n < 1) throw new Error('Form number must be a positive number');
    if (this.db.prepare('SELECT 1 FROM forms WHERE form_no=?').get(n)) throw new Error(`Form ${n} already exists`);
    if (copyFrom !== undefined && copyFrom !== null && copyFrom !== '') this._form(copyFrom);
    this._tx(() => {
      this.db.prepare('INSERT INTO forms(form_no,name,notes) VALUES(?,?,?)').run(n, String(name).trim(), String(notes).trim());
      if (copyFrom !== undefined && copyFrom !== null && copyFrom !== '') {
        this.db.prepare('INSERT INTO form_fields(form_no,key,role) SELECT ?, key, role FROM form_fields WHERE form_no=?').run(n, Number(copyFrom));
      }
    });
    this.audit('form-add', `${n}${copyFrom ? ` (copied from ${copyFrom})` : ''}`);
    return this.getForms();
  }
  updateForm(formNo, patch = {}) {
    const cur = this._form(formNo);
    this.db.prepare('UPDATE forms SET name=?, notes=? WHERE form_no=?')
      .run(String(patch.name ?? cur.name).trim(), String(patch.notes ?? cur.notes).trim(), cur.form_no);
    this.audit('form-update', `${cur.form_no}: ${JSON.stringify(patch)}`);
    return this.getForms();
  }
  // Change a form's number everywhere it is used (field list and line mapping). Stored entries are unaffected.
  renameForm(oldNo, newNo) {
    const cur = this._form(oldNo);
    const n = parseInt(newNo, 10);
    if (!n || n < 1) throw new Error('Form number must be a positive number');
    if (n === cur.form_no) return this.getForms();
    if (this.db.prepare('SELECT 1 FROM forms WHERE form_no=?').get(n)) throw new Error(`Form ${n} already exists`);
    this._tx(() => {
      this.db.prepare('UPDATE forms SET form_no=? WHERE form_no=?').run(n, cur.form_no);
      this.db.prepare('UPDATE form_fields SET form_no=? WHERE form_no=?').run(n, cur.form_no);
      this.db.prepare('UPDATE line_forms SET form_no=? WHERE form_no=?').run(n, cur.form_no);
    });
    this.audit('form-renumber', `${cur.form_no} -> ${n}`);
    return this.getForms();
  }
  deleteForm(formNo) {
    const cur = this._form(formNo);
    const used = this.db.prepare('SELECT line FROM line_forms WHERE form_no=? ORDER BY line').all(cur.form_no).map((r) => r.line);
    if (used.length) throw new Error(`Form ${cur.form_no} is used by line${used.length > 1 ? 's' : ''} ${used.join(', ')}. Point ${used.length > 1 ? 'them' : 'it'} at another form first (Settings → Line → Form).`);
    this._tx(() => {
      this.db.prepare('DELETE FROM form_fields WHERE form_no=?').run(cur.form_no);
      this.db.prepare('DELETE FROM forms WHERE form_no=?').run(cur.form_no);
    });
    this.audit('form-delete', String(cur.form_no));
    return this.getForms();
  }
  // Fields on a form, each with its role. Removing a field from a form never deletes stored values.
  getFormFields(formNo) {
    return this.db.prepare(`SELECT f.*, ff.role FROM form_fields ff JOIN fields f ON f.key = ff.key
      WHERE ff.form_no=? ORDER BY f.sort, f.key`).all(Number(formNo));
  }
  setFormField(formNo, key, role = 'tracked') {
    const form = this._form(formNo);
    if (!this.db.prepare('SELECT 1 FROM fields WHERE key=?').get(key)) throw new Error(`Unknown field: ${key}`);
    if (!ROLES.includes(role)) throw new Error('Role must be tracked or initial');
    this.db.prepare(`INSERT INTO form_fields(form_no,key,role) VALUES(?,?,?)
      ON CONFLICT(form_no,key) DO UPDATE SET role=excluded.role`).run(form.form_no, key, role);
    this.audit('form-field', `${form.form_no}: ${key} = ${role}`);
    this._cache = null;
    return this.getFormFields(form.form_no);
  }
  removeFormField(formNo, key) {
    const form = this._form(formNo);
    this.db.prepare('DELETE FROM form_fields WHERE form_no=? AND key=?').run(form.form_no, key);
    this.audit('form-field-remove', `${form.form_no}: ${key}`);
    this._cache = null;
    return this.getFormFields(form.form_no);
  }
  getLineForms() {
    return this.db.prepare('SELECT line, form_no FROM line_forms ORDER BY line').all()
      .map((r) => ({ ...r, tonnage: F.PRESS_TONNAGE[r.line] || '' }));
  }
  setLineForm(line, form) {
    line = parseInt(line, 10); form = parseInt(form, 10);
    if (!line || !form) throw new Error('Line and form must be numbers');
    this.ensureForm(form);
    this.db.prepare('INSERT INTO line_forms(line,form_no) VALUES(?,?) ON CONFLICT(line) DO UPDATE SET form_no=excluded.form_no').run(line, form);
    this.audit('line-form', `L${line} -> ${form}`);
    return this.getLineForms();
  }
  removeLine(line) {
    const used = this.db.prepare('SELECT COUNT(*) c FROM entries WHERE line=?').get(line).c;
    if (used) throw new Error(`${this._labels().line} ${line} has ${used} entries and cannot be removed.`);
    this.db.prepare('DELETE FROM line_forms WHERE line=?').run(line);
    this.audit('line-remove', String(line));
    return this.getLineForms();
  }
  formFor(line) {
    const r = this.db.prepare('SELECT form_no FROM line_forms WHERE line=?').get(Number(line));
    return r ? r.form_no : null;
  }
  // Parts that have at least one live (not voided) entry.
  listParts(line) {
    const live = 'EXISTS (SELECT 1 FROM entries e WHERE e.line=p.line AND e.part_no=p.part_no AND e.voided=0)';
    const rows = line
      ? this.db.prepare(`SELECT part_no FROM parts p WHERE line=? AND ${live} ORDER BY part_no`).all(Number(line))
      : this.db.prepare(`SELECT DISTINCT part_no FROM parts p WHERE ${live} ORDER BY part_no`).all();
    return rows.map((r) => r.part_no);
  }
  allParts() {
    return this.db.prepare(`SELECT line, part_no FROM parts p WHERE EXISTS
      (SELECT 1 FROM entries e WHERE e.line=p.line AND e.part_no=p.part_no AND e.voided=0) ORDER BY line, part_no`).all();
  }
  // Live entry count and first/last timestamps for every Line + Part.
  listPartsDetailed() {
    return this.db.prepare(`SELECT line, part_no, COUNT(*) entries, MIN(entry_ts) first_ts, MAX(entry_ts) last_ts
      FROM entries WHERE voided=0 GROUP BY line, part_no ORDER BY line, part_no`).all()
      .map((r) => ({ ...r, entries: Number(r.entries) }));
  }
  // The stored spelling of a part on a line when it matches ignoring case and spacing; otherwise the part as typed.
  _canonPart(line, part, except) {
    const rows = this.db.prepare('SELECT part_no FROM parts WHERE line=?').all(Number(line)).map((r) => r.part_no).filter((p) => p !== except);
    if (rows.includes(part)) return part;
    return rows.find((p) => partFold(p) === partFold(part)) || part;
  }
  // Before saving: is this a part we already have on this line, and if not, is it close to one (a likely typo)?
  checkPart(line, part) {
    line = Number(line);
    const p = partNorm(part);
    const out = { exists: false, canonical: null, similar: [], otherLines: [] };
    if (!line || !p) return out;
    const stats = this.listPartsDetailed();
    const mine = stats.filter((s) => s.line === line);
    const hit = mine.find((s) => s.part_no === p) || mine.find((s) => partFold(s.part_no) === partFold(p));
    if (hit) return { ...out, exists: true, canonical: hit.part_no };
    const loose = partLoose(p);
    out.similar = mine
      .map((s) => ({ ...s, dist: partLoose(s.part_no) === loose ? 0 : editDistance(partLoose(s.part_no), loose) }))
      .filter((s) => s.dist <= 1)
      .sort((a, b) => a.dist - b.dist || b.entries - a.entries)
      .slice(0, 5)
      .map(({ dist, ...s }) => s);
    out.otherLines = stats.filter((s) => s.line !== line && partFold(s.part_no) === partFold(p)).map((s) => ({ line: s.line, entries: s.entries }));
    return out;
  }
  // Change a part number on one line. If the new number already exists there, the two histories are merged.
  // Entry values are never edited; only the part number they hang off moves. Audit-logged.
  renamePart(line, from, to) {
    line = Number(line);
    const target = partNorm(to);
    if (!line) throw new Error('Line is required');
    if (!target) throw new Error('New part number is required');
    const count = (p) => Number(this.db.prepare('SELECT COUNT(*) c FROM entries WHERE line=? AND part_no=?').get(line, p).c);
    const moved = count(from);
    if (!moved && !this.db.prepare('SELECT 1 FROM parts WHERE line=? AND part_no=?').get(line, from)) throw new Error(`Part ${from} was not found on line ${line}.`);
    if (target === from) return { moved: 0, merged: false, part_no: from };
    const dest = this._canonPart(line, target, from);
    const merged = !!this.db.prepare('SELECT 1 FROM parts WHERE line=? AND part_no=?').get(line, dest);
    this._tx(() => {
      this.db.prepare('UPDATE entries SET part_no=? WHERE line=? AND part_no=?').run(dest, line, from);
      this.db.prepare('INSERT OR IGNORE INTO parts(line,part_no) VALUES(?,?)').run(line, dest);
      this.db.prepare('DELETE FROM parts WHERE line=? AND part_no=?').run(line, from);
      this.db.prepare('DELETE FROM drift_ack WHERE line=? AND part_no=?').run(line, from);
    });
    this.audit(merged ? 'part-merge' : 'part-rename', `L${line} ${from} -> ${dest} (${moved} entr${moved === 1 ? 'y' : 'ies'})`);
    return { moved, merged, part_no: dest };
  }

  // ---------- entries ----------
  // Known spellings for text fields: the field's pick-list first, then values already stored (most used first).
  // key -> Map(lower-case normalized text -> spelling to use).
  _textCanons(fields) {
    const out = new Map();
    const text = fields.filter((f) => f.kind === 'text' && f.has_sp);
    for (const f of text) {
      const m = new Map();
      for (const c of String(f.choices || '').split('\n')) if (c && !m.has(c.toLowerCase())) m.set(c.toLowerCase(), c);
      out.set(f.key, m);
    }
    if (!text.length) return out;
    const marks = text.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT key, v, COUNT(*) n FROM (
        SELECT key, setpoint v FROM entry_values UNION ALL SELECT key, actual v FROM entry_values)
      WHERE key IN (${marks}) AND v IS NOT NULL AND TRIM(v) <> '' GROUP BY key, v ORDER BY n DESC`).all(...text.map((f) => f.key));
    for (const r of rows) {
      const t = C.norm(r.v);
      const m = out.get(r.key);
      if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t);
    }
    return out;
  }
  // Suggestions for the entry form: text field key -> spellings, pick-list first.
  valueSuggestions() {
    const out = {};
    for (const [key, m] of this._textCanons(this.getFields())) if (m.size) out[key] = [...m.values()].slice(0, 60);
    return out;
  }

  // e.corrects: id of an earlier entry this one replaces. The earlier entry is voided (with e.correct_reason)
  // in the same transaction, so it drops out of change detection but stays on record.
  saveEntry(e) {
    const line = parseInt(e.line, 10);
    let part = partNorm(e.part_no);
    const L = this._labels();
    if (!line) throw new Error(`${L.line} # is required`);
    if (!part) throw new Error(`${L.part} is required`);
    if (!this.db.prepare('SELECT 1 FROM line_forms WHERE line=?').get(line)) throw new Error(`${L.line} ${line} is not configured (Settings → ${L.line} → Form, or import a template with a Forms sheet).`);
    part = this._canonPart(line, part);
    const fields = this.getFields();
    const fieldMap = new Map(fields.map((f) => [f.key, f]));
    const canons = this._textCanons(fields);
    const problems = [];
    const tidy = (f, v, which) => {
      if (C.blank(v)) return null;
      if (f.kind === 'text') {
        const t = C.norm(v);
        return canons.get(f.key)?.get(t.toLowerCase()) ?? t;
      }
      const r = T.parse(f, v);
      if (!r.ok) { problems.push(`${f.label}${f.has_sp ? ` (${which})` : ''}: ${r.error}`); return null; }
      return r.value;
    };
    const values = [];
    for (const [key, v] of Object.entries(e.values || {})) {
      const f = fieldMap.get(key);
      if (!f) continue;
      const sp = tidy(f, v.setpoint, 'setpoint');
      const ac = tidy(f, v.actual, 'actual');
      if (sp === null && ac === null) continue;
      values.push([key, sp, ac]);
    }
    if (problems.length) throw new Error(`Fix ${problems.length === 1 ? 'this entry' : 'these entries'} before saving:\n• ${problems.slice(0, 8).join('\n• ')}${problems.length > 8 ? `\n• …and ${problems.length - 8} more` : ''}`);
    const notes = String(e.notes || '').trim();
    if (!values.length && !notes) throw new Error('Nothing to save: enter at least one value or a note.');
    const correctReason = String(e.correct_reason || '').trim();
    if (e.corrects) {
      this._voidable(e.corrects);
      if (!correctReason) throw new Error('A reason is required to correct an entry.');
    }
    const ts = e.entry_ts || tsLocal(this.now());
    let photo = '';
    if (e.photo_src) photo = this._storePhoto(e.photo_src, line, part, ts);
    let changes = 0;
    let old = null;
    const id = this._tx(() => {
      if (e.corrects) {
        old = this._voidable(e.corrects);
        this.db.prepare('UPDATE entries SET voided=1, void_reason=?, voided_ts=? WHERE id=?').run(correctReason, tsLocal(this.now()), old.id);
        this._cache = null;
      }
      const before = this.latestValues(line, part, ts); // after the void, so a mistyped entry is not the baseline
      for (const [key, , ac] of values) {
        if (fieldMap.get(key).has_sp && ac !== null && before[key] && T.changed(fieldMap.get(key), before[key].actual, ac)) changes++;
      }
      this.db.prepare('INSERT OR IGNORE INTO parts(line,part_no) VALUES(?,?)').run(line, part);
      const r = this.db.prepare(`INSERT INTO entries(line,part_no,entry_ts,entered_by,sheet_rev,sheet_revised,hmi_file,notes,source,reason,photo_path)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(line, part, ts, e.entered_by || '', e.sheet_rev || '', e.sheet_revised || '',
        e.hmi_file || '', notes, e.corrects ? 'correction' : (e.source || 'manual'), e.reason || '', photo);
      const id = Number(r.lastInsertRowid);
      const ins = this.db.prepare('INSERT INTO entry_values(entry_id,key,setpoint,actual) VALUES(?,?,?,?)');
      values.forEach(([k, sp, ac]) => ins.run(id, k, sp, ac));
      if (old) this.db.prepare('UPDATE entries SET corrected_by=? WHERE id=?').run(id, old.id);
      return id;
    });
    if (old) this.audit('entry-void', `#${old.id} L${old.line} ${old.part_no} ${old.entry_ts}: ${correctReason} (corrected by #${id})`, e.entered_by);
    this.audit('entry-add', `#${id} L${line} ${part} ${ts} (${values.length} values, ${changes} changes${old ? `, corrects #${old.id}` : ''})`, e.entered_by);
    if (!e.noBackup) { try { this.backupNow('auto', false); } catch { /* a failed auto backup must never block saving */ } }
    return { id, changes };
  }

  _voidable(id) {
    const cur = this.db.prepare('SELECT * FROM entries WHERE id=?').get(Number(id));
    if (!cur) throw new Error('Entry not found');
    if (cur.voided) throw new Error(`Entry #${cur.id} is already voided.`);
    return cur;
  }
  // Take a wrong entry out of change detection, trends, drift, exports and reports. It stays on record with its reason.
  voidEntry(id, reason) {
    const why = String(reason || '').trim();
    if (!why) throw new Error('A reason is required to void an entry.');
    const cur = this._voidable(id);
    this.db.prepare('UPDATE entries SET voided=1, void_reason=?, voided_ts=? WHERE id=?').run(why, tsLocal(this.now()), cur.id);
    this._cache = null;
    this.audit('entry-void', `#${cur.id} L${cur.line} ${cur.part_no} ${cur.entry_ts}: ${why}`);
    return true;
  }
  // Undo a void. Not offered for an entry that a correction already replaced.
  restoreEntry(id) {
    const cur = this.db.prepare('SELECT * FROM entries WHERE id=?').get(Number(id));
    if (!cur) throw new Error('Entry not found');
    if (!cur.voided) throw new Error(`Entry #${cur.id} is not voided.`);
    if (cur.corrected_by) throw new Error(`Entry #${cur.id} was replaced by entry #${cur.corrected_by}. Void that one instead.`);
    this.db.prepare("UPDATE entries SET voided=0, void_reason='', voided_ts='' WHERE id=?").run(cur.id);
    this._cache = null;
    this.audit('entry-restore', `#${cur.id} L${cur.line} ${cur.part_no} ${cur.entry_ts} (was voided: ${cur.void_reason})`);
    return true;
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
    for (const e of entries) { e.values = {}; e.changed = {}; e.drift = {}; e.range = {}; byId.set(e.id, e); }
    for (const r of this.db.prepare('SELECT * FROM entry_values').all()) {
      const e = byId.get(r.entry_id);
      if (e) e.values[r.key] = { setpoint: r.setpoint, actual: r.actual };
    }
    const lastKnown = new Map();
    const live = entries.filter((e) => !e.voided); // voided entries never take part in change or drift detection
    for (const e of live) {
      const lp = `${e.line}|${e.part_no}`;
      if (!lastKnown.has(lp)) lastKnown.set(lp, {});
      const known = lastKnown.get(lp);
      for (const [key, v] of Object.entries(e.values)) {
        const f = fm.get(key);
        if (!f || !f.has_sp) continue;
        if (!C.blank(v.actual)) {
          if (known[key] !== undefined && T.changed(f, known[key], v.actual)) e.changed[key] = { from: known[key], to: v.actual };
          known[key] = v.actual;
        }
        if (T.drifted(f, v.setpoint, v.actual)) e.drift[key] = true;
      }
      for (const [key, v] of Object.entries(e.values)) {
        const r = T.outOfRange(fm.get(key), v.actual);
        if (r) e.range[key] = r;
      }
    }
    this._cache = { entries: live, all: entries, byId, fm };
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
    let rows = f.includeVoided ? this._all().all : this._all().entries;
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
      const fld = fm.get(gk.split('|')[2]);
      for (let i = list.length - 1; i >= 0 && T.drifted(fld, list[i].v.setpoint, list[i].v.actual); i--) streak++;
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
      const num = T.toNumber(f, v.actual);
      if (num === null) continue;
      pts.push({ ts: e.entry_ts, actual: num, setpoint: T.toNumber(f, v.setpoint), entry_id: e.id });
    }
    return { key, label: f?.label || key, unit: f?.unit || '', kind: f?.kind || 'number', points: pts };
  }
  // One series per line (that line's part with the most data for the field).
  compareTrend({ key, part }) {
    const f = this._all().fm.get(key);
    const best = new Map();
    for (const e of this._all().entries) {
      const v = e.values[key];
      if (!v || T.toNumber(f, v.actual) === null) continue;
      if (part && e.part_no !== part && this.allParts().some((p) => p.part_no === part)) continue;
      const k = `${e.line}|${e.part_no}`;
      if (!best.has(k)) best.set(k, { line: e.line, part_no: e.part_no, points: [] });
      best.get(k).points.push({ ts: e.entry_ts, actual: T.toNumber(f, v.actual) });
    }
    const perLine = new Map();
    for (const s of best.values()) {
      const cur = perLine.get(s.line);
      if (!cur || s.points.length > cur.points.length) perLine.set(s.line, s);
    }
    return { key, label: f?.label || key, unit: f?.unit || '', kind: f?.kind || 'number', series: [...perLine.values()].sort((a, b) => a.line - b.line) };
  }

  // ---------- export ----------
  exportRows({ line, part, from, to, includeReason = true } = {}) {
    const fields = this.getFields().filter((f) => f.visible);
    const { rows } = this.listEntries({ line, part, from, to });
    const used = new Set();
    rows.forEach((e) => Object.keys(e.values).forEach((k) => used.add(k)));
    const cols = fields.filter((f) => used.has(f.key));
    const L = this._labels();
    const headers = [L.line, L.part.replace(/\.$/, ''), 'Date/Time', 'Sheet Rev', 'Revised', 'HMI File', 'Entered By'];
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
    return { labels: this._labels(), start, end, entries: entries.length, changes, reasons, drift: this.driftAlerts(), lines: this.getLineForms().map((l) => ({
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
          // imported fields join every form that already exists (as tracked)
          for (const fm of this.db.prepare('SELECT form_no FROM forms').all()) {
            this.db.prepare('INSERT OR IGNORE INTO form_fields(form_no,key,role) VALUES(?,?,\'tracked\')').run(fm.form_no, f.key);
          }
        }
        for (const l of src.prepare('SELECT * FROM line_forms').all()) {
          this.ensureForm(l.form_no);
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

  // ---------- Excel form templates ----------
  // opts: { forms: 'all' | [form numbers], blank: true } -> .xlsx bytes
  exportTemplate(opts = {}) { return Tpl.buildTemplate(this, opts); }
  // What importing this workbook would do. Writes nothing.
  previewTemplate(file, opts = {}) {
    if (!fs.existsSync(file)) throw new Error('File not found');
    return Tpl.planTemplate(this, Tpl.parseTemplate(fs.readFileSync(file)), opts);
  }
  applyTemplate(file, opts = {}) {
    const plan = this.previewTemplate(file, opts);
    if (plan.errors.length) throw new Error(`The template has ${plan.errors.length} problem${plan.errors.length === 1 ? '' : 's'}; nothing was imported.`);
    if (!plan.changed) return { applied: false, summary: plan.summary };
    this.backupNow('pre-template', true);
    Tpl.applyPlan(this, plan);
    return { applied: true, summary: plan.summary };
  }

  // ---------- history from Excel (old setup sheets) ----------
  exportHistoryTemplate(opts = {}) { return Hist.buildHistoryTemplate(this, opts); }
  previewHistory(file, opts = {}) {
    if (!fs.existsSync(file)) throw new Error('File not found');
    const plan = Hist.planHistory(this, fs.readFileSync(file), opts);
    delete plan.entries; // the preview is a summary; apply re-reads the file
    return plan;
  }
  applyHistory(file, opts = {}) {
    if (!fs.existsSync(file)) throw new Error('File not found');
    const plan = Hist.planHistory(this, fs.readFileSync(file), opts);
    if (!plan.canApply) throw new Error(plan.entries.length ? `${plan.skipped.length} row${plan.skipped.length === 1 ? ' has' : 's have'} problems. Fix them, or choose to skip those rows.` : 'There is nothing to import.');
    this.backupNow('pre-history', true);
    Hist.applyHistory(this, plan);
    return { added: plan.entries.length, skipped: plan.skipped.length, newParts: plan.summary.newParts.length };
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
