'use strict';
ST.tabs.about = {
  title: 'About',
  async render(root) {
    const { h } = ST;
    const info = await ST.main('app:info');
    const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { ST.fail(e); } };
    // The Updates card redraws itself as the updater reports progress (see app.js).
    this.drawUpdate = () => {
      const box = document.getElementById('update-card');
      if (!box) return;
      const u = ST.state.update || {};
      const when = u.checkedAt ? ` Last checked ${new Date(u.checkedAt).toLocaleString()}.` : '';
      const line = (text, cls = 'muted') => h('p', { class: cls, text });
      const body = [];
      if (u.state === 'unavailable') body.push(line(u.message || 'Updates are not available in this run.'));
      else if (u.state === 'checking') body.push(line('Checking for updates…'));
      else if (u.state === 'available') {
        body.push(h('p', {}, h('b', { text: `Version ${u.latest} is available` }), ` (you have ${u.current}).`));
        if (u.notes) body.push(h('pre', { class: 'notes', text: u.notes }));
        body.push(h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', text: `Download ${u.latest}`, onclick: guard(() => ST.main('update:download')) })));
      } else if (u.state === 'downloading') {
        body.push(h('p', { text: `Downloading ${u.latest}… ${u.percent || 0}%` }), h('div', { class: 'bar' }, h('i', { style: `width:${u.percent || 0}%` })));
      } else if (u.state === 'ready') {
        body.push(h('p', {}, h('b', { text: `Version ${u.latest} is ready to install.` })),
          line('Your data is backed up first. Setup Tracker closes, updates and reopens by itself; your entries, forms and profiles are not touched.'),
          h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', text: 'Restart and update', onclick: guard(async () => { await ST.main('update:install'); }) })));
      } else if (u.state === 'error') {
        body.push(h('p', { class: 'err-text', text: u.error || 'The update check failed.' }), h('div', { class: 'toolbar' }, h('button', { class: 'btn', text: 'Try again', onclick: guard(() => ST.main('update:check')) })));
      } else {
        body.push(line(`${u.state === 'none' ? 'You are up to date.' : 'Not checked yet.'}${when}`), h('div', { class: 'toolbar' }, h('button', { class: 'btn', text: 'Check for updates', onclick: guard(() => ST.main('update:check')) })));
      }
      body.push(h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: u.auto !== false, onchange: guard(async (e) => { await ST.main('update:setAuto', e.target.checked); ST.state.update.auto = e.target.checked; ST.toast(e.target.checked ? 'Will check for updates in the background' : 'Automatic checks are off'); }) }), ' Check for updates automatically (nothing is downloaded or installed without your click)'));
      box.replaceChildren(...body);
    };
    const road = [
      ['Done', 'Dashboard, data entry, history, export, backup / restore, drift alerts, change reasons, sheet photos, weekly PDF report, missing-entry tracking, compare lines, editable forms and fields (tracked vs set-once)'],
      ['Done', 'Part-number checks (new-part confirmation, near-miss suggestions, rename / merge), tidy text values with pick-lists, void / correct entries with a reason'],
      ['Done', 'Field types (number, text, choice, yes/no, rating, ratio, time of day, duration, date) with limits; Excel form templates (download, edit, import with preview)'],
      ['Done', 'Profiles: a separate database per job, with its own names for the two identifiers'],
      ['Done', 'In-app updates from GitHub Releases (download and restart, with a backup first)'],
      ['Done', 'First entry for a new part asks for setpoints only; load old setup sheets from Excel (history template, preview, skip bad rows)'],
      ['Not yet', 'Sheet revision tracking'],
      ['Deferred', 'OCR / photo extraction of sheets'],
      ['Deferred', 'Network-folder database and multi-user'],
      ['Declined', 'Compare two entries'],
      ['Declined', 'Printable pre-filled sheet'],
    ];
    root.replaceChildren(h('div', { class: 'grid' },
      ST.card('Setup Tracker', h('div', {}, h('p', { class: 'big', text: `Version ${info.version}` }), h('p', { class: 'muted', text: `Electron ${info.electron} · ${info.platform}` }),
        h('p', { text: `Logs checked-off setup sheets and shows what changed day to day per ${ST.L.line.toLowerCase()} + ${ST.L.partShort.toLowerCase()}.` }))),
      ST.card('Updates', h('div', { id: 'update-card', class: 'col tight' })),
      ST.card('Your data', h('div', {}, h('p', { text: 'Everything is stored locally on this PC in a SQLite database. Nothing is sent anywhere; there is no network access, account or telemetry.' }),
        h('p', { class: 'muted', text: 'Entries are never overwritten or deleted: a revision is a new entry, and a wrong entry is voided with a reason (it stays on record). Notes can be edited and every edit is audit-logged.' }))),
      ST.card('Roadmap', h('ul', { class: 'list' }, road.map(([s, t]) => h('li', {}, h('span', { class: `status-pill ${s.toLowerCase().replace(' ', '-')}`, text: s }), h('span', { class: 'grow', text: t })))), { class: 'span2' })));
    this.drawUpdate();
  },
};
