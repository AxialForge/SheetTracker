'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater, plainNotes, friendly } = require('../app/main/updater');
const { ProfileManager } = require('../app/main/profiles');
const { tmp } = require('./helpers');

function fake({ check = async () => {}, download = async () => {} } = {}) {
  const u = new EventEmitter();
  u.calls = [];
  u.checkForUpdates = async () => { u.calls.push('check'); return check(u); };
  u.downloadUpdate = async () => { u.calls.push('download'); return download(u); };
  u.quitAndInstall = (...a) => u.calls.push(['install', ...a]);
  return u;
}
const make = (au, extra = {}) => {
  const sent = [];
  const up = createUpdater({ autoUpdater: au, isPackaged: true, currentVersion: '0.3.0', send: (s) => sent.push(s.state), ...extra });
  return { up, sent };
};

test('a development run reports updates as unavailable and never calls the updater', async () => {
  const au = fake();
  const up = createUpdater({ autoUpdater: au, isPackaged: false, currentVersion: '0.3.0' });
  assert.equal(up.getState().state, 'unavailable');
  assert.match(up.getState().message, /development run/);
  await up.check();
  assert.deepEqual(au.calls, []);
});

test('nothing downloads or installs on its own', () => {
  const au = fake();
  make(au);
  assert.equal(au.autoDownload, false);
  assert.equal(au.autoInstallOnAppQuit, false);
});

test('check → available → download → ready → install (backup first, silent, relaunch)', async () => {
  const order = [];
  const au = fake({
    check: async (u) => { u.emit('checking-for-update'); u.emit('update-available', { version: '0.4.0', releaseNotes: '<p>Adds <b>rating</b> setup</p><ul><li>one</li><li>two</li></ul>' }); },
    download: async (u) => { u.emit('download-progress', { percent: 42.4 }); u.emit('update-downloaded', { version: '0.4.0' }); },
  });
  const { up, sent } = make(au, { beforeInstall: async () => { order.push('backup'); } });
  await up.check();
  assert.equal(up.getState().state, 'available');
  assert.equal(up.getState().latest, '0.4.0');
  assert.match(up.getState().notes, /Adds rating setup/);
  await up.download();
  assert.equal(up.getState().state, 'ready');
  await up.install();
  order.push(...au.calls.filter((c) => Array.isArray(c)).map((c) => c.join(':')));
  assert.deepEqual(order, ['backup', 'install:true:true']);
  assert.ok(sent.includes('checking') && sent.includes('available') && sent.includes('downloading') && sent.includes('ready'));
});

test('up to date', async () => {
  const au = fake({ check: async (u) => { u.emit('checking-for-update'); u.emit('update-not-available', {}); } });
  const { up } = make(au);
  await up.check();
  assert.equal(up.getState().state, 'none');
  assert.ok(up.getState().checkedAt > 0);
});

test('download and install refuse when the step before has not happened', async () => {
  const { up } = make(fake());
  await assert.rejects(() => up.download(), /no update to download/);
  await assert.rejects(() => up.install(), /not finished downloading/);
});

test('errors are turned into plain words; a failed backup does not block the update', async () => {
  const au = fake({ check: async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); } });
  const { up } = make(au);
  await up.check({ silent: true });
  assert.equal(up.getState().state, 'error');
  assert.equal(up.getState().silent, true);
  assert.match(up.getState().error, /Could not reach GitHub/);
  assert.match(friendly(new Error('HttpError: 404 Not Found latest.yml')), /No published release/);

  const au2 = fake({ check: async (u) => { u.emit('update-available', { version: '9.9.9' }); }, download: async (u) => { u.emit('update-downloaded', { version: '9.9.9' }); } });
  const m = make(au2, { beforeInstall: async () => { throw new Error('disk full'); } });
  await m.up.check(); await m.up.download(); await m.up.install();
  assert.ok(au2.calls.some((c) => Array.isArray(c)));
});

test('a second check while one is running or an update is ready does nothing', async () => {
  let release;
  const au = fake({ check: (u) => new Promise((r) => { u.emit('checking-for-update'); release = r; }) });
  const { up } = make(au);
  const first = up.check();
  await up.check();
  assert.equal(au.calls.filter((c) => c === 'check').length, 1);
  release(); await first;
});

test('background checks honour the on/off switch', async () => {
  const au = fake({ check: async (u) => u.emit('update-not-available', {}) });
  let on = false;
  const { up } = make(au);
  const stop = up.startAutoCheck({ delayMs: 5, everyMs: 1e9, enabled: () => on });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(au.calls.length, 0);
  on = true; stop();
  const stop2 = up.startAutoCheck({ delayMs: 5, everyMs: 1e9, enabled: () => on });
  await new Promise((r) => setTimeout(r, 60));
  stop2();
  assert.equal(au.calls.length, 1);
});

test('release notes become plain text and are capped', () => {
  assert.equal(plainNotes(null), '');
  assert.equal(plainNotes([{ note: 'a' }, { note: 'b' }]), 'a\n\nb');
  assert.ok(plainNotes('x'.repeat(5000)).length <= 1500);
  assert.equal(plainNotes('<h2>Fixes</h2><p>A &amp; B</p>'), 'Fixes\nA & B');
});

test('the automatic-update preference is app-wide and survives a restart', () => {
  const root = tmp();
  const pm = new ProfileManager(root);
  assert.equal(pm.getApp().autoUpdate, true);
  pm.setApp({ autoUpdate: false });
  assert.equal(new ProfileManager(root).getApp().autoUpdate, false);
  pm.create({ name: 'Other' });
  assert.equal(new ProfileManager(root).getApp().autoUpdate, false); // other writes keep it
});
