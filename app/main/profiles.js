'use strict';
// Profiles: one independent database (forms, fields, entries, photos, backups) per job.
// The first profile is the original data folder, untouched. Others live in <root>/profiles/<id>/.
const fs = require('node:fs');
const path = require('node:path');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

class ProfileManager {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'profiles.json');
    fs.mkdirSync(root, { recursive: true });
    this.data = this._load();
  }
  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(d.profiles) && d.profiles.length) {
        if (!d.profiles.some((p) => p.id === d.active)) d.active = d.profiles[0].id;
        return d;
      }
    } catch { /* first run, or unreadable: start from the default profile */ }
    const d = { active: 'default', profiles: [{ id: 'default', name: 'Viking Forge', dir: '', blank: false }] };
    this._write(d);
    return d;
  }
  _write(d = this.data) { fs.writeFileSync(this.file, JSON.stringify(d, null, 2)); }

  dirOf(id) {
    const p = this.get(id);
    return p.dir ? path.join(this.root, p.dir) : this.root;
  }
  get(id) {
    const p = this.data.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Profile not found');
    return p;
  }
  activeId() { return this.data.active; }
  list() {
    return this.data.profiles.map((p) => ({ ...p, path: this.dirOf(p.id), active: p.id === this.data.active }));
  }
  create({ name, blank = true }) {
    const label = String(name || '').trim();
    if (!label) throw new Error('A profile needs a name');
    if (this.data.profiles.some((p) => p.name.toLowerCase() === label.toLowerCase())) throw new Error(`There is already a profile called “${label}”`);
    const base = slug(label) || 'profile';
    let id = base; let i = 2;
    while (this.data.profiles.some((p) => p.id === id) || fs.existsSync(path.join(this.root, 'profiles', id))) id = `${base}-${i++}`;
    const profile = { id, name: label, dir: path.join('profiles', id), blank: !!blank };
    fs.mkdirSync(path.join(this.root, profile.dir), { recursive: true });
    this.data.profiles.push(profile);
    this._write();
    return id;
  }
  rename(id, name) {
    const label = String(name || '').trim();
    if (!label) throw new Error('A profile needs a name');
    if (this.data.profiles.some((p) => p.id !== id && p.name.toLowerCase() === label.toLowerCase())) throw new Error(`There is already a profile called “${label}”`);
    this.get(id).name = label;
    this._write();
  }
  setActive(id) { this.get(id); this.data.active = id; this._write(); }
  // Takes the profile off the list. Its files stay on disk (nothing is deleted).
  remove(id) {
    const p = this.get(id);
    if (id === 'default') throw new Error('The original profile cannot be removed.');
    if (id === this.data.active) throw new Error('Switch to another profile before removing this one.');
    const dir = this.dirOf(p.id);
    this.data.profiles = this.data.profiles.filter((x) => x.id !== id);
    this._write();
    return dir;
  }
}

module.exports = { ProfileManager };
