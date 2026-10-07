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

    const scope = ST.select([['all', `All ${ST.L.lines.toLowerCase()} & ${ST.L.parts.toLowerCase()}`], ['part', `One ${ST.L.partShort.toLowerCase()}`]], f.scope);
    scope.onchange = () => { f.scope = scope.value; this.render(root); };
    const lineSel = ST.select(lines.map((l) => [String(l), ST.lineName(l)]), f.line, { disabled: f.scope !== 'part' });
    lineSel.onchange = () => { f.line = lineSel.value; f.part = ''; this.render(root); };
    const partSel = ST.select(parts, f.part, { disabled: f.scope !== 'part' });
    partSel.onchange = () => { f.part = partSel.value; };
    const filters = () => ({ line: f.scope === 'part' ? Number(f.line) : undefined, part: f.scope === 'part' ? f.part : undefined, from: f.from || undefined, to: f.to || undefined, includeReason: f.reasons });
    const doExport = async (format) => {
      try { const r = await ST.main('export:file', { format, filters: filters() }); if (r) ST.toast(`Exported ${r.rows} rows → ${r.file}`); } catch (e) { ST.fail(e); }
    };
    const dataCard = ST.card('Data export', h('div', { class: 'form-grid' },
      h('label', { class: 'fld' }, h('span', { text: 'Scope' }), scope),
      h('label', { class: 'fld' }, h('span', { text: ST.L.line }), lineSel),
      h('label', { class: 'fld' }, h('span', { text: 'Part' }), partSel),
      h('label', { class: 'fld' }, h('span', { text: 'From' }), h('input', { type: 'date', value: f.from, onchange: (e) => { f.from = e.target.value; } })),
      h('label', { class: 'fld' }, h('span', { text: 'To' }), h('input', { type: 'date', value: f.to, onchange: (e) => { f.to = e.target.value; } })),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: f.reasons, onchange: (e) => { f.reasons = e.target.checked; } }), ' Include change reasons'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', text: 'Export CSV', onclick: () => doExport('csv') }), h('button', { class: 'btn', text: 'Export XLSX', onclick: () => doExport('xlsx') }))));

    const auto = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: ST.state.settings.weekly_auto === '1', onchange: async (e) => { await ST.api('setSettings', { weekly_auto: e.target.checked ? '1' : '0' }); ST.state.settings.weekly_auto = e.target.checked ? '1' : '0'; ST.toast(e.target.checked ? 'A report is created on app start when a week has passed' : 'Auto weekly report off'); } }), ' Auto-create weekly (on app start, when 7 days have passed)');
    const end = h('input', { type: 'date', value: new Date().toLocaleDateString('en-CA') });
    const rep = ST.card('Weekly change report (PDF)', h('div', {},
      h('p', { class: 'muted', text: `Settings changed per ${ST.L.line.toLowerCase()} and ${ST.L.partShort.toLowerCase()}, change reasons, and open drift alerts for the 7 days ending on the chosen date.` }),
      h('div', { class: 'toolbar' }, h('label', { class: 'inl' }, 'Week ending ', end),
        h('button', { class: 'btn primary', text: 'Create report now', onclick: async (ev) => { ev.target.disabled = true; try { const r = await ST.main('report:create', end.value); ST.toast(`Report saved (${r.changes} changes)`); await ST.main('shell:showItem', r.file); } catch (e) { ST.fail(e); } ev.target.disabled = false; } })),
      auto,
      h('div', { class: 'toolbar' }, h('span', { class: 'muted', text: 'Output folder:' }), h('code', { class: 'path', text: reportDir }),
        h('button', { class: 'btn ghost sm', text: 'Change…', onclick: async () => { try { if (await ST.main('dir:chooseReport')) this.render(root); } catch (e) { ST.fail(e); } } }),
        h('button', { class: 'btn ghost sm', text: 'Open', onclick: () => ST.main('shell:openFolder', reportDir).catch(ST.fail) }))));

    // ---- old setup sheets in: a template per form to fill in, and the import
    const formsList = ST.state.forms;
    const hist = { form: String(formsList[0]?.form_no ?? '') };
    const formSel = ST.select(formsList.map((x) => [String(x.form_no), `Form ${x.form_no}${x.name ? ` — ${x.name}` : ''}`]), hist.form, { 'aria-label': 'Form', onchange: (e) => { hist.form = e.target.value; } });
    const histCard = ST.card('Load old setup sheets from Excel', h('div', { class: 'col tight' },
      h('p', { class: 'muted', text: `One row per setup sheet: the ${ST.L.line.toLowerCase()}, ${ST.L.part.toLowerCase()}, date/time and each field's setpoint and actual. Download the template for a form, fill it from the sheets, then import it. You get a preview, with every problem listed by row, before anything is saved. Stored entries are never changed.` }),
      h('div', { class: 'toolbar' }, formSel,
        h('button', { class: 'btn', text: 'Download history template', onclick: async () => { try { if (!hist.form) throw new Error('Add a form first (Forms tab).'); const r = await ST.main('history:export', { form: Number(hist.form) }); if (r) { ST.toast('Template saved'); await ST.main('shell:showItem', r.file); } } catch (e) { ST.fail(e); } } })),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', text: 'Import entries from Excel…', onclick: () => ST.importHistory().catch(ST.fail) }),
        h('span', { class: 'muted', text: 'Also accepts this app\'s own Excel data export.' }))));
    const charts = ST.card('Charts', h('p', { class: 'muted', text: 'Every chart on the Dashboard has a “Save PNG” button.' }));
    root.replaceChildren(h('div', { class: 'grid' }, dataCard, rep, histCard, charts));
  },
};

// Import entries from an Excel file: preview (with every problem by row), then apply.
ST.importHistory = async function importHistory(afterApply) {
  const { h } = ST;
  const file = await ST.main('history:pick');
  if (!file) return;
  const opts = { skipBad: false };
  for (;;) {
    const plan = await ST.api('previewHistory', file, opts);
    const sum = plan.summary;
    const chip = (n, text, warn) => h('span', { class: n ? (warn ? 'warn' : 'on') : '', text: `${text}: ${n}` });
    const list = (cls, items) => (items.length ? h('ul', { class: `plan-list ${cls}` }, items.map((t) => h('li', { text: t }))) : null);
    const body = (close) => h('div', { class: 'col tight' },
      h('p', { class: 'muted', text: file.split(/[\\/]/).pop() }),
      h('div', { class: 'plan-sum' }, chip(sum.toAdd, 'Entries to add'), chip(sum.newParts.length, `New ${ST.L.parts.toLowerCase()}`), chip(sum.duplicates, 'Already there'), chip(sum.skipped, 'Rows with problems', true), chip(sum.values, 'Values')),
      sum.toAdd ? h('p', { class: 'muted', text: `${ST.fmtDate(sum.first)} to ${ST.fmtDate(sum.last)}` }) : null,
      plan.errors.length ? h('div', {}, h('b', { text: plan.skipped.length ? `${plan.skipped.length} row${plan.skipped.length === 1 ? '' : 's'} with problems` : 'Fix these in the file' }), list('plan-err', plan.errors.slice(0, 60))) : null,
      plan.warnings.length ? h('div', {}, h('b', { text: 'Notes' }), list('plan-warn', plan.warnings.slice(0, 30))) : null,
      sum.newParts.length ? h('div', {}, h('b', { text: `New ${ST.L.parts.toLowerCase()}` }), h('p', { class: 'muted', text: sum.newParts.slice(0, 40).map((p) => `${ST.lineName(p.line)} · ${p.part}`).join('   ') + (sum.newParts.length > 40 ? ` …and ${sum.newParts.length - 40} more` : '') })) : null,
      plan.skipped.length ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: opts.skipBad, onchange: (e) => { opts.skipBad = e.target.checked; close('again'); } }), ' Import the good rows and skip the ones with problems') : null);
    const go = await ST.modal({ title: 'Import entries from Excel', wide: true, body,
      buttons: plan.canApply ? [{ text: 'Cancel', value: null }, { text: `Import ${sum.toAdd} entr${sum.toAdd === 1 ? 'y' : 'ies'}`, primary: true, value: 'apply' }] : [{ text: 'Close', primary: true, value: null }] });
    if (go === 'again') continue;
    if (go === 'apply') {
      const res = await ST.api('applyHistory', file, opts);
      ST.toast(`Imported ${res.added} entr${res.added === 1 ? 'y' : 'ies'}${res.skipped ? `, skipped ${res.skipped}` : ''}`);
      await ST.refreshCore();
      if (afterApply) await afterApply();
    }
    return;
  }
};
