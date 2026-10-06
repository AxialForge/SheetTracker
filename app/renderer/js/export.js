'use strict';
ST.tabs.export = {
  title: 'Export',
  f: { scope: 'all', line: '', part: '', from: '', to: '', reasons: true },

  async render(root) {
    const { h } = ST; const f = this.f;
    const [allParts, reportDir] = await Promise.all([ST.api('allParts'), ST.main('report:dir')]);
    const lines = [...new Set(allParts.map((p) => p.line))];
    if (!f.line && lines.length) f.line = String(lines[0]);
    const parts = allParts.filter((p) => String(p.line) === String(f.line)).map((p) => p.part_no);
    if (!parts.includes(f.part)) f.part = parts[0] || '';

    const scope = ST.select([['all', 'All lines & parts'], ['part', 'One part']], f.scope);
    scope.onchange = () => { f.scope = scope.value; this.render(root); };
    const lineSel = ST.select(lines.map((l) => [String(l), `Line ${l}`]), f.line, { disabled: f.scope !== 'part' });
    lineSel.onchange = () => { f.line = lineSel.value; f.part = ''; this.render(root); };
    const partSel = ST.select(parts, f.part, { disabled: f.scope !== 'part' });
    partSel.onchange = () => { f.part = partSel.value; };
    const filters = () => ({ line: f.scope === 'part' ? Number(f.line) : undefined, part: f.scope === 'part' ? f.part : undefined, from: f.from || undefined, to: f.to || undefined, includeReason: f.reasons });
    const doExport = async (format) => {
      try { const r = await ST.main('export:file', { format, filters: filters() }); if (r) ST.toast(`Exported ${r.rows} rows → ${r.file}`); } catch (e) { ST.fail(e); }
    };
    const dataCard = ST.card('Data export', h('div', { class: 'form-grid' },
      h('label', { class: 'fld' }, h('span', { text: 'Scope' }), scope),
      h('label', { class: 'fld' }, h('span', { text: 'Line' }), lineSel),
      h('label', { class: 'fld' }, h('span', { text: 'Part' }), partSel),
      h('label', { class: 'fld' }, h('span', { text: 'From' }), h('input', { type: 'date', value: f.from, onchange: (e) => { f.from = e.target.value; } })),
      h('label', { class: 'fld' }, h('span', { text: 'To' }), h('input', { type: 'date', value: f.to, onchange: (e) => { f.to = e.target.value; } })),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: f.reasons, onchange: (e) => { f.reasons = e.target.checked; } }), ' Include change reasons'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', text: 'Export CSV', onclick: () => doExport('csv') }), h('button', { class: 'btn', text: 'Export XLSX', onclick: () => doExport('xlsx') }))));

    const auto = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: ST.state.settings.weekly_auto === '1', onchange: async (e) => { await ST.api('setSettings', { weekly_auto: e.target.checked ? '1' : '0' }); ST.state.settings.weekly_auto = e.target.checked ? '1' : '0'; ST.toast(e.target.checked ? 'A report is created on app start when a week has passed' : 'Auto weekly report off'); } }), ' Auto-create weekly (on app start, when 7 days have passed)');
    const end = h('input', { type: 'date', value: new Date().toLocaleDateString('en-CA') });
    const rep = ST.card('Weekly change report (PDF)', h('div', {},
      h('p', { class: 'muted', text: 'Settings changed per line and part, change reasons, and open drift alerts for the 7 days ending on the chosen date.' }),
      h('div', { class: 'toolbar' }, h('label', { class: 'inl' }, 'Week ending ', end),
        h('button', { class: 'btn primary', text: 'Create report now', onclick: async (ev) => { ev.target.disabled = true; try { const r = await ST.main('report:create', end.value); ST.toast(`Report saved (${r.changes} changes)`); await ST.main('shell:showItem', r.file); } catch (e) { ST.fail(e); } ev.target.disabled = false; } })),
      auto,
      h('div', { class: 'toolbar' }, h('span', { class: 'muted', text: 'Output folder:' }), h('code', { class: 'path', text: reportDir }),
        h('button', { class: 'btn ghost sm', text: 'Change…', onclick: async () => { try { if (await ST.main('dir:chooseReport')) this.render(root); } catch (e) { ST.fail(e); } } }),
        h('button', { class: 'btn ghost sm', text: 'Open', onclick: () => ST.main('shell:openFolder', reportDir).catch(ST.fail) }))));

    const charts = ST.card('Charts', h('p', { class: 'muted', text: 'Every chart on the Dashboard has a “Save PNG” button.' }));
    root.replaceChildren(h('div', { class: 'grid' }, dataCard, rep, charts));
  },
};
