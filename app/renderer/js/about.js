'use strict';
ST.tabs.about = {
  title: 'About',
  async render(root) {
    const { h } = ST;
    const info = await ST.main('app:info');
    const road = [
      ['Done', 'Dashboard, data entry, history, export, backup / restore, drift alerts, change reasons, sheet photos, weekly PDF report, missing-entry tracking, compare lines, editable forms and fields (tracked vs set-once)'],
      ['Done', 'Part-number checks (new-part confirmation, near-miss suggestions, rename / merge), tidy text values with pick-lists, void / correct entries with a reason'],
      ['Not yet', 'Sheet revision tracking'],
      ['Deferred', 'OCR / photo extraction of sheets'],
      ['Deferred', 'Network-folder database and multi-user'],
      ['Declined', 'Compare two entries'],
      ['Declined', 'Printable pre-filled sheet'],
    ];
    root.replaceChildren(h('div', { class: 'grid' },
      ST.card('Setup Tracker', h('div', {}, h('p', { class: 'big', text: `Version ${info.version}` }), h('p', { class: 'muted', text: `Electron ${info.electron} · ${info.platform}` }),
        h('p', { text: 'Logs checked-off press setup sheets and shows what changed day to day per Line + Part.' }))),
      ST.card('Your data', h('div', {}, h('p', { text: 'Everything is stored locally on this PC in a SQLite database. Nothing is sent anywhere; there is no network access, account or telemetry.' }),
        h('p', { class: 'muted', text: 'Entries are never overwritten or deleted: a revision is a new entry, and a wrong entry is voided with a reason (it stays on record). Notes can be edited and every edit is audit-logged.' }))),
      ST.card('Roadmap', h('ul', { class: 'list' }, road.map(([s, t]) => h('li', {}, h('span', { class: `status-pill ${s.toLowerCase().replace(' ', '-')}`, text: s }), h('span', { class: 'grow', text: t })))), { class: 'span2' })));
  },
};
