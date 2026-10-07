'use strict';
// In-app updates from GitHub Releases. The Electron updater is injected so the flow can be tested without Electron.
// Nothing is downloaded or installed without a click; before installing, the caller backs up the data.

const NOTES_MAX = 1500;
function plainNotes(n) {
  if (!n) return '';
  const raw = Array.isArray(n) ? n.map((x) => (typeof x === 'string' ? x : x?.note || '')).join('\n\n') : String(n);
  return raw.replace(/<\/(p|li|h\d|div|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, NOTES_MAX);
}
const friendly = (e) => {
  const m = String(e?.message || e || 'Update failed').split('\n')[0];
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|net::ERR|getaddrinfo/i.test(m)) return 'Could not reach GitHub. Check the internet connection and try again.';
  if (/404|latest\.yml|Cannot find/i.test(m)) return 'No published release was found to update from yet.';
  return m.slice(0, 300);
};

function createUpdater({ autoUpdater, isPackaged, currentVersion, send = () => {}, beforeInstall = async () => {}, now = () => Date.now() }) {
  let state = {
    state: isPackaged && autoUpdater ? 'idle' : 'unavailable', current: currentVersion, latest: '', notes: '', percent: 0, error: '', checkedAt: 0, silent: false,
    message: isPackaged && autoUpdater ? '' : 'Updates are checked from the installed app. This is a development run.',
  };
  const set = (patch) => { state = { ...state, ...patch }; try { send(state); } catch { /* window may be gone */ } return state; };

  if (autoUpdater) {
    autoUpdater.autoDownload = false;         // a person decides
    autoUpdater.autoInstallOnAppQuit = false; // and when
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: '' }));
    autoUpdater.on('update-available', (info) => set({ state: 'available', latest: info.version, notes: plainNotes(info.releaseNotes), checkedAt: now(), percent: 0, error: '' }));
    autoUpdater.on('update-not-available', () => set({ state: 'none', latest: '', notes: '', checkedAt: now(), error: '' }));
    autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p?.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', latest: info?.version || state.latest, percent: 100 }));
    autoUpdater.on('error', (e) => set({ state: 'error', error: friendly(e), checkedAt: now() }));
  }

  return {
    getState: () => state,
    // silent: a background check; the person is not told about failures.
    async check({ silent = false } = {}) {
      if (!autoUpdater || !isPackaged) return set({ state: 'unavailable' });
      if (['checking', 'downloading', 'ready'].includes(state.state)) return state;
      set({ silent });
      try { await autoUpdater.checkForUpdates(); } catch (e) { set({ state: 'error', error: friendly(e), checkedAt: now() }); }
      return state;
    },
    async download() {
      if (state.state !== 'available') throw new Error('There is no update to download. Check for updates first.');
      set({ state: 'downloading', percent: 0 });
      try { await autoUpdater.downloadUpdate(); } catch (e) { set({ state: 'error', error: friendly(e) }); }
      return state;
    },
    // Back up first (a failed backup must not stop the update), then close, install silently and relaunch.
    async install() {
      if (state.state !== 'ready') throw new Error('The update has not finished downloading.');
      try { await beforeInstall(); } catch { /* the data is untouched by an update either way */ }
      autoUpdater.quitAndInstall(true, true);
      return state;
    },
    // Check shortly after start, then every few hours while the app stays open. Returns a stop function.
    startAutoCheck({ delayMs = 8000, everyMs = 6 * 3600 * 1000, enabled = () => true } = {}) {
      const run = () => { if (enabled()) this.check({ silent: true }); };
      const first = setTimeout(run, delayMs);
      const loop = setInterval(run, everyMs);
      first.unref?.(); loop.unref?.();
      return () => { clearTimeout(first); clearInterval(loop); };
    },
  };
}

module.exports = { createUpdater, plainNotes, friendly };
