'use strict';
ST.tabs.data = {
  title: 'Data',
  f: { line: '', part: '', from: '', to: '', changesOnly: false },
  focus: null,
  LIMIT: 500,

  async render(root) {
    const { h } = ST; const f = this.f;
    const allParts = await ST.api('allParts');
    const lines = [...new Set(allParts.map((p) => p.line))];
    const parts = allParts.filter((p) => !f.line || String(p.line) === String(f.line)).map((p) => p.part_no);
    const uniqParts = [...new Set(parts)];
    if (f.part && !uniqParts.includes(f.part)) f.part = '';

    const lineSel = ST.select([['', 'All lines'], ...lines.map((l) => [String(l), `Line ${l}`])], f.line, { 'aria-label': 'Line' });
    lineSel.onchange = () => { f.line = lineSel.value; f.part = ''; this.render(root); };
    const partSel = ST.select([['', 'All parts'], ...uniqParts], f.part, { 'aria-label': 'Part' });
    partSel.onchange = () => { f.part = partSel.value; this.render(root); };
    const from = h('input', { type: 'date', value: f.from, 'aria-label': 'From', onchange: (e) => { f.from = e.target.value; this.render(root); } });
    const to = h('input', { type: 'date', value: f.to, 'aria-label': 'To', onchange: (e) => { f.to = e.target.value; this.render(root); } });
    const chg = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: f.changesOnly, onchange: (e) => { f.changesOnly = e.target.checked; this.render(root); } }), ' Changes only');
    const reset = h('button', { class: 'btn ghost sm', text: 'Reset', onclick: () => { this.f = { line: '', part: '', from: '', to: '', changesOnly: false }; this.render(root); } });

    const { total, rows } = await ST.api('listEntries', { ...f, line: f.line || undefined, part: f.part || undefined, from: f.from || undefined, to: f.to || undefined, limit: this.LIMIT });
    const used = new Set(); rows.forEach((e) => Object.keys(e.values).forEach((k) => used.add(k)));
    const cols = ST.state.fields.filter((fl) => fl.visible && used.has(fl.key));
    const showReason = ST.opt('reasons'); const showPhoto = ST.opt('photos');

    const head = h('tr', {}, h('th', { class: 'sticky s0', text: 'Line' }), h('th', { class: 'sticky s1', text: 'Part No.' }), h('th', { text: 'Date/Time' }), h('th', { text: 'Rev' }), h('th', { class: 'notes-col', text: 'Notes' }),
      showReason ? h('th', { text: 'Reason' }) : null, showPhoto ? h('th', { text: 'Photo' }) : null, h('th', {}),
      cols.map((c) => h('th', { class: 'num', title: c.has_sp ? 'Actual (hover cell for sheet setpoint)' : 'Reading', text: c.label + (c.unit ? ` (${c.unit})` : '') })));

    const body = rows.map((e) => {
      const nChg = Object.keys(e.changed).length;
      const tr = h('tr', { 'data-id': e.id, class: this.focus === e.id ? 'flash' : '' },
        h('td', { class: 'sticky s0 mono', text: e.line }), h('td', { class: 'sticky s1', text: e.part_no }),
        h('td', { class: 'nowrap', text: ST.fmtDate(e.entry_ts) }, nChg ? h('span', { class: 'pill', text: `${nChg} Δ` }) : null),
        h('td', { text: e.sheet_rev }),
        h('td', { class: 'notes-col' }, h('input', { type: 'text', class: 'notes-in', value: e.notes || '', 'aria-label': 'Notes', onchange: async (ev) => { try { await ST.api('updateNotes', e.id, ev.target.value); ST.toast('Note updated'); } catch (err) { ST.fail(err); } } })),
        showReason ? h('td', { text: e.reason || '' }) : null,
        showPhoto ? h('td', {}, e.photo_path ? h('button', { class: 'btn ghost sm', text: 'Open', onclick: () => ST.main('photo:open', e.photo_path).catch(ST.fail) }) : null) : null,
        h('td', {}, h('button', { class: 'btn ghost sm', text: 'Revise', title: 'Load into Data Entry as a new revision', onclick: () => { ST.tabs.entry.prefill(e); ST.show('entry'); } })),
        cols.map((c) => {
          const v = e.values[c.key];
          if (!v) return h('td', { class: 'num dim', text: '' });
          const cls = ['num', 'mono'];
          if (e.changed[c.key]) cls.push('changed'); else if (e.drift[c.key]) cls.push('drift');
          const tip = [c.has_sp && v.setpoint ? `Sheet setpoint: ${v.setpoint}` : '', e.changed[c.key] ? `Changed from ${e.changed[c.key].from}` : ''].filter(Boolean).join(' · ');
          return h('td', { class: cls.join(' '), title: tip, text: v.actual ?? (v.setpoint ? `(${v.setpoint})` : '') });
        }));
      return tr;
    });

    const table = rows.length
      ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'data-t' }, h('thead', {}, head), h('tbody', {}, body)))
      : h('p', { class: 'muted pad', text: 'No entries match these filters.' });
    const legend = h('div', { class: 'legend' }, h('span', { class: 'sw changed' }), ' changed vs last', h('span', { class: 'sw drift' }), ' actual ≠ sheet setpoint');
    root.replaceChildren(
      h('div', { class: 'card toolbar' }, lineSel, partSel, h('label', { class: 'inl' }, 'From ', from), h('label', { class: 'inl' }, 'To ', to), chg, reset, h('div', { class: 'grow' }), legend,
        h('span', { class: 'muted', text: total > this.LIMIT ? `Showing ${this.LIMIT} of ${total}` : `${total} entr${total === 1 ? 'y' : 'ies'}` })),
      table);
    if (this.focus) {
      const row = root.querySelector(`tr[data-id="${this.focus}"]`);
      if (row) row.scrollIntoView({ block: 'center' });
      this.focus = null;
    }
  },
};

ST.goData = function goData({ line, part, entry }) {
  const d = ST.tabs.data;
  d.f = { line: String(line), part, from: '', to: '', changesOnly: false };
  d.focus = entry || null;
  ST.show('data');
};
