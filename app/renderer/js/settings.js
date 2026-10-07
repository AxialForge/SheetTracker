'use strict';
ST.tabs.settings = {
  title: 'Settings',

  async render(root) {
    const { h } = ST;
    const [paths, backups, audit, parts] = await Promise.all([ST.api('getPaths'), ST.api('listBackups'), ST.api('getAudit', 100), ST.api('listPartsDetailed')]);
    const s = ST.state.settings;
    const again = () => this.render(root);
    const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { ST.fail(e); } };
    const saveSetting = (k) => guard(async (e) => {
      const v = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value;
      await ST.api('setSettings', { [k]: v }); ST.state.settings[k] = v;
      if (k === 'theme') ST.applyTheme(v);
      ST.toast('Saved');
    });

    // ---- fields
    const fieldRows = ST.state.fields.map((f) => h('tr', { class: f.visible ? '' : 'dim' },
      h('td', {}, h('input', { type: 'checkbox', checked: !!f.visible, title: 'Show on forms and in Data', 'aria-label': `Show ${f.label}`, onchange: guard(async (e) => { await ST.api('updateField', f.key, { visible: e.target.checked }); await ST.refreshCore(); again(); }) })),
      h('td', {}, h('input', { type: 'text', class: 'cell', value: f.label, 'aria-label': `Rename ${f.key}`, onchange: guard(async (e) => { await ST.api('updateField', f.key, { label: e.target.value }); await ST.refreshCore(); ST.toast('Renamed'); }) })),
      h('td', { class: 'muted', text: ST.state.sections.find((s) => s.key === f.section)?.label || f.section }),
      h('td', { class: 'muted', text: `${Types.label(f.kind).split(' (')[0]} · ${f.has_sp ? 'Setting' : 'Reading'}` }),
      h('td', { class: 'muted', text: f.unit }),
      h('td', {}, f.custom ? h('button', { class: 'btn ghost sm', text: 'Delete', onclick: guard(async () => { if (!confirm(`Delete custom field "${f.label}" and all of its stored values?`)) return; await ST.api('deleteField', f.key); await ST.refreshCore(); again(); }) }) : null)));
    const nf = { label: '', unit: '', kind: 'number', has_sp: '1' };
    const addForm = h('div', { class: 'toolbar' },
      h('input', { type: 'text', placeholder: 'New field name', oninput: (e) => { nf.label = e.target.value; } }),
      h('input', { type: 'text', placeholder: 'unit', class: 'short', oninput: (e) => { nf.unit = e.target.value; } }),
      ST.select(Types.KINDS.map((k) => [k.key, k.label]), 'number', { onchange: (e) => { nf.kind = e.target.value; } }),
      ST.select([['1', 'Setting (setpoint + actual, change-tracked)'], ['0', 'Reading (actual only)']], '1', { onchange: (e) => { nf.has_sp = e.target.value; } }),
      h('button', { class: 'btn', text: 'Add field', onclick: guard(async () => { await ST.api('addField', { label: nf.label, unit: nf.unit, kind: nf.kind, has_sp: nf.has_sp === '1', section: 'custom' }); await ST.refreshCore(); again(); }) }));
    const fieldsCard = ST.card('Fields', h('div', {}, h('p', { class: 'muted', text: 'Hide, rename or add fields for all forms at once. Hidden fields keep their stored data. Settings are change-tracked; readings are not. To change what a single form carries, use the Forms tab.' }),
      h('div', { class: 'tbl-wrap short' }, h('table', { class: 'data-t' }, h('thead', {}, h('tr', {}, ['Show', 'Name', 'Section', 'Type', 'Unit', ''].map((t) => h('th', { text: t })))), h('tbody', {}, fieldRows))), addForm), { class: 'span2' });

    // ---- lines
    const forms = ST.state.forms.map((f) => f.form_no);
    const lineRows = ST.state.lineForms.map((l) => h('tr', {}, h('td', { class: 'mono', text: `Line ${l.line}` }), h('td', { class: 'muted', text: l.tonnage }),
      h('td', {}, ST.select(forms.includes(l.form_no) ? forms : [...forms, l.form_no], l.form_no, { onchange: guard(async (e) => { await ST.api('setLineForm', l.line, e.target.value); await ST.refreshCore(); ST.toast('Saved'); }) })),
      h('td', {}, h('button', { class: 'btn ghost sm', text: 'Remove', onclick: guard(async () => { await ST.api('removeLine', l.line); await ST.refreshCore(); again(); }) }))));
    const nl = { line: '', form: String(forms[0] ?? '') };
    const lineCard = ST.card('Line → Form', h('div', {}, h('table', { class: 'data-t slim' }, h('tbody', {}, lineRows)),
      h('div', { class: 'toolbar' }, h('input', { type: 'number', min: 1, class: 'short', placeholder: 'Line #', oninput: (e) => { nl.line = e.target.value; } }),
        ST.select(forms.map(String), nl.form, { onchange: (e) => { nl.form = e.target.value; } }),
        h('button', { class: 'btn', text: 'Add line', onclick: guard(async () => { await ST.api('setLineForm', nl.line, nl.form); await ST.refreshCore(); again(); }) })),
      h('p', { class: 'muted', text: 'Create forms and choose which fields each one carries in the Forms tab.' })));

    // ---- parts: fix a mistyped part number, or merge two spellings into one history
    const renamePart = (p) => guard(async () => {
      const to = await ST.ask({ title: `Rename ${p.part_no} (Line ${p.line})`, label: 'New part number', value: p.part_no, ok: 'Rename',
        message: 'If the new number already exists on this line, the two histories are merged. Entry values are not changed.' });
      if (!to || to === p.part_no) return;
      const hit = await ST.api('checkPart', p.line, to);
      if (hit.exists && hit.canonical !== p.part_no) {
        const into = parts.find((x) => x.line === p.line && x.part_no === hit.canonical);
        if (!confirm(`${hit.canonical} already exists on Line ${p.line} (${into?.entries ?? 0} entries).\n\nMerge the ${p.entries} entr${p.entries === 1 ? 'y' : 'ies'} of ${p.part_no} into it? Changes will be recalculated across the combined history.`)) return;
      }
      const r = await ST.api('renamePart', p.line, p.part_no, to);
      ST.toast(r.merged ? `Merged into ${r.part_no}` : `Renamed to ${r.part_no}`);
      await ST.refreshCore(); again();
    });
    const partRows = parts.map((p) => h('tr', {}, h('td', { class: 'mono', text: `Line ${p.line}` }), h('td', { text: p.part_no }),
      h('td', { class: 'muted', text: `${p.entries} entr${p.entries === 1 ? 'y' : 'ies'}` }), h('td', { class: 'muted', text: `last ${ST.fmtDate(p.last_ts, true)}` }),
      h('td', {}, h('button', { class: 'btn ghost sm', text: 'Rename / merge…', onclick: renamePart(p) }))));
    const partsCard = ST.card(`Parts (${parts.length})`, h('div', {},
      h('p', { class: 'muted', text: 'Part numbers are matched ignoring case and extra spaces. If a part was typed wrongly, rename it here; renaming onto an existing part merges the two histories.' }),
      parts.length ? h('div', { class: 'tbl-wrap short' }, h('table', { class: 'data-t slim' }, h('tbody', {}, partRows))) : h('p', { class: 'muted', text: 'No parts yet.' })), { class: 'span2' });

    // ---- optional features
    const feat = (key, label, hint) => h('label', { class: 'feat' }, h('input', { type: 'checkbox', checked: s[`opt_${key}`] === '1', onchange: guard(async (e) => { await saveSetting(`opt_${key}`)(e); await again(); }) }), h('span', {}, h('b', { text: label }), h('small', { class: 'muted', text: hint })));
    const featCard = ST.card('Optional features', h('div', { class: 'feats' },
      feat('reasons', 'Change reasons', 'Reason chips on each entry'),
      feat('photos', 'Sheet photo attachments', 'Copied into the photos folder and included in backups'),
      feat('missing', 'Missing-entry tracking', 'Dashboard shows lines not logged today'),
      feat('drift', 'Setpoint drift alerts', 'Actual ≠ sheet setpoint for N entries in a row'),
      feat('compare', 'Compare lines chart', 'Overlay lines on the Dashboard trend'),
      h('label', { class: 'inl' }, 'Drift after N entries ', h('input', { type: 'number', min: 2, max: 20, class: 'short', value: s.drift_n, onchange: saveSetting('drift_n') }))));

    // ---- appearance
    const appear = ST.card('Appearance', h('div', { class: 'form-grid' },
      h('label', { class: 'fld' }, h('span', { text: 'Theme' }), ST.select([['crimson', 'Crimson (dark)'], ['amber', 'Amber (dark)'], ['steel', 'Steel (dark)']], s.theme, { onchange: saveSetting('theme') })),
      h('label', { class: 'fld' }, h('span', { text: 'Date format' }), ST.select([['iso', '2026-10-06 14:30'], ['us', '10/06/2026 2:30 PM'], ['eu', '06/10/2026 14:30']], s.date_format, { onchange: guard(async (e) => { await saveSetting('date_format')(e); }) })),
      h('label', { class: 'fld' }, h('span', { text: 'Default “entered by”' }), h('input', { type: 'text', value: s.entered_by, onchange: saveSetting('entered_by') }))));

    // ---- backup
    const bRows = backups.slice(0, 30).map((b) => h('tr', {}, h('td', { class: 'mono', text: b.name }), h('td', { class: 'muted', text: b.reason }), h('td', { class: 'muted', text: `${(b.size / 1024).toFixed(0)} KB` }), h('td', { class: 'muted', text: ST.fmtDate(new Date(b.mtime).toISOString().slice(0, 16)) }),
      h('td', {}, h('button', { class: 'btn ghost sm', text: 'Restore', onclick: guard(async () => { if (!confirm(`Restore ${b.name}?\n\nThe current database is backed up first. Entries made since this backup will be replaced.`)) return; const r = await ST.main('backup:restore', b.path); ST.toast(`Restored ${r.restored}`); await ST.refreshCore(); again(); }) }))));
    const backupCard = ST.card(`Backup & restore (${backups.length})`, h('div', {},
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', text: 'Back up now', onclick: guard(async () => { await ST.api('backupNow', 'manual', true); ST.toast('Backup created'); again(); }) }),
        h('button', { class: 'btn', text: 'Restore from file…', onclick: guard(async () => { const p = await ST.main('backup:pickRestore'); if (!p) return; if (!confirm(`Restore from ${p}?\n\nThe current database is backed up first.`)) return; const r = await ST.main('backup:restore', p); ST.toast(`Restored ${r.restored}`); await ST.refreshCore(); again(); }) }),
        h('button', { class: 'btn ghost', text: 'Integrity check', onclick: guard(async () => { const r = await ST.api('integrityCheck'); ST.toast(r.ok ? 'Database integrity: OK' : `Integrity problems: ${r.messages.join('; ')}`, r.ok ? 'ok' : 'err'); }) })),
      h('div', { class: 'toolbar' }, h('span', { class: 'muted', text: 'Backup folder:' }), h('code', { class: 'path', text: paths.backupDir }),
        h('button', { class: 'btn ghost sm', text: 'Change…', onclick: guard(async () => { if (await ST.main('dir:chooseBackup')) again(); }) }),
        h('button', { class: 'btn ghost sm', text: 'Open', onclick: guard(() => ST.main('shell:openFolder', paths.backupDir)) })),
      h('p', { class: 'muted', text: 'Backups are taken on save (at most one per 5 minutes), before restore/import, and kept to the newest 100. Put the backup folder on a different drive from the data.' }),
      h('div', { class: 'tbl-wrap short' }, h('table', { class: 'data-t slim' }, h('tbody', {}, bRows)))), { class: 'span2' });

    // ---- data
    const dataCard = ST.card('Data', h('div', {},
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: 'Database' }), h('code', { class: 'path', text: paths.dbPath })),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: 'Photos' }), h('code', { class: 'path', text: paths.photosDir })),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', text: 'Open data folder', onclick: guard(() => ST.main('shell:openFolder', paths.dataDir)) }),
        h('button', { class: 'btn', text: 'Import a v3 database…', onclick: guard(async () => { const r = await ST.main('db:import'); if (r) { ST.toast(`Imported ${r.added} entries (${r.skipped} duplicates skipped)`); await ST.refreshCore(); again(); } }) })),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn ghost', text: 'Load sample data', onclick: guard(async (ev) => { ev.target.disabled = true; const r = await ST.api('loadSampleData'); ST.toast(`Loaded ${r.added} sample entries`); await ST.refreshCore(); again(); }) }),
        h('button', { class: 'btn ghost', text: 'Remove sample data', onclick: guard(async () => { if (!confirm('Remove all sample entries? Your own entries are kept.')) return; const r = await ST.api('removeSampleData'); ST.toast(`Removed ${r.removed} sample entries`); again(); }) })),
      h('p', { class: 'muted', text: 'Database location can be changed with "dbPath" in config.json inside the data folder (restart required).' })));

    // ---- audit
    const aRows = audit.map((a) => h('tr', {}, h('td', { class: 'nowrap muted', text: ST.fmtDate(a.ts.slice(0, 16).replace(' ', 'T')) }), h('td', { text: a.user }), h('td', { text: a.action }), h('td', { class: 'muted', text: a.detail })));
    const auditCard = ST.card('Audit log', h('div', { class: 'tbl-wrap short' }, h('table', { class: 'data-t slim' }, h('thead', {}, h('tr', {}, ['When (UTC)', 'User', 'Action', 'Detail'].map((t) => h('th', { text: t })))), h('tbody', {}, aRows))), { class: 'span2' });

    root.replaceChildren(h('div', { class: 'grid' }, featCard, appear, lineCard, dataCard, partsCard, backupCard, fieldsCard, auditCard));
  },
};
