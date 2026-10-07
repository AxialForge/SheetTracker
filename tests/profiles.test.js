'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProfileManager } = require('../app/main/profiles');
const { SetupService } = require('../app/main/service');
const { tmp } = require('./helpers');

const open = (pm, id) => new SetupService({ dataDir: pm.dirOf(id), blank: pm.get(id).blank, now: () => new Date('2026-03-18T12:00:00') });

test('first run: one default profile that points at the existing data folder', () => {
  const root = tmp();
  const pm = new ProfileManager(root);
  assert.equal(pm.list().length, 1);
  assert.equal(pm.activeId(), 'default');
  assert.equal(pm.dirOf('default'), root);
  assert.ok(fs.existsSync(path.join(root, 'profiles.json')));
});

test('profiles are separate databases: entries, forms and fields do not leak between them', () => {
  const root = tmp();
  const pm = new ProfileManager(root);
  const a = open(pm, 'default');
  a.saveEntry({ line: 5, part_no: 'P1', values: { billet_temp: { actual: '2250' } }, noBackup: true });
  const id = pm.create({ name: 'Other job', blank: true });
  const b = open(pm, id);
  assert.equal(b.getFields().length, 0);
  assert.equal(b.getForms().length, 0);
  assert.equal(b.getLineForms().length, 0);
  assert.equal(b.listEntries({}).total, 0);
  assert.deepEqual(b.getSections().map((s) => s.label), ['General']);
  b.addForm({ form_no: 1, name: 'Only here' });
  assert.equal(a.getForms().some((f) => f.form_no === 1), false);
  assert.equal(a.listEntries({}).total, 1);
  assert.ok(fs.existsSync(path.join(pm.dirOf(id), 'setups.db')));
  assert.notEqual(path.join(pm.dirOf(id), 'setups.db'), a.dbPath);
  a.close(); b.close();
});

test('a blank profile stays blank when reopened, and takes a template', () => {
  const root = tmp();
  const pm = new ProfileManager(root);
  const id = pm.create({ name: 'Job B', blank: true });
  open(pm, id).close();
  const again = open(pm, id);
  assert.equal(again.getFields().length, 0);
  assert.equal(again.getSettings().blank_profile, '1');
  const src = open(pm, 'default');
  const file = path.join(tmp(), 'pack.xlsx');
  fs.writeFileSync(file, src.exportTemplate({ forms: 'all' }));
  again.applyTemplate(file);
  assert.ok(again.getFields().length > 50);
  again.close();
  const third = open(pm, id); // reopened after it has content: nothing is re-seeded on top
  assert.equal(third.getForms().length, 4);
  third.close(); src.close();
});

test('names: unique, renamable; active profile and the default cannot be removed; files are kept', () => {
  const root = tmp();
  const pm = new ProfileManager(root);
  const id = pm.create({ name: 'Plant 2' });
  assert.throws(() => pm.create({ name: 'plant 2' }), /already a profile/);
  assert.throws(() => pm.create({ name: '  ' }), /needs a name/);
  pm.rename(id, 'Plant Two');
  assert.equal(pm.get(id).name, 'Plant Two');
  assert.throws(() => pm.rename(id, 'Viking Forge'), /already a profile/);
  pm.setActive(id);
  assert.throws(() => pm.remove(id), /Switch to another/);
  pm.setActive('default');
  assert.throws(() => pm.remove('default'), /cannot be removed/);
  const dir = pm.remove(id);
  assert.equal(pm.list().length, 1);
  assert.ok(fs.existsSync(dir)); // nothing deleted
});

test('the choice survives a restart; a damaged profiles.json falls back to the default', () => {
  const root = tmp();
  const pm = new ProfileManager(root);
  const id = pm.create({ name: 'Job C' });
  pm.setActive(id);
  assert.equal(new ProfileManager(root).activeId(), id);
  fs.writeFileSync(path.join(root, 'profiles.json'), '{ not json');
  const pm2 = new ProfileManager(root);
  assert.equal(pm2.activeId(), 'default');
  assert.equal(pm2.list().length, 1);
});

test('ids never collide with an existing folder', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'profiles', 'job'), { recursive: true });
  const pm = new ProfileManager(root);
  assert.notEqual(pm.create({ name: 'Job' }), 'job');
});
