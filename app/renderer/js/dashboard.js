'use strict';
ST.tabs.dashboard = {
  title: 'Dashboard',
  sel: { line: '', part: '', key: '', compare: false },

  async render(root) {
    const { h } = ST;
    const sel = this.sel;
    const [d, allParts] = await Promise.all([ST.api('dashboard'), ST.api('allParts')]);
    ST.state.dash = d;
    if (!sel.line || !allParts.some((p) => String(p.line) === String(sel.line) && p.part_no === sel.part)) {
      const first = allParts.find((p) => String(p.line) === String(sel.line)) || allParts[0];
      if (first) { sel.line = String(first.line); sel.part = first.part_no; }
    }
    const trendFields = ST.state.fields.filter((f) => f.visible && Types.chartable(f.kind));
    if (!sel.key || !trendFields.some((f) => f.key === sel.key)) sel.key = (trendFields.find((f) => f.key === 'billet_temp') || trendFields[0] || {}).key || '';

    const kpi = (label, value, sub, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'kpi-v', text: value }), h('div', { class: 'kpi-l', text: label }), sub ? h('div', { class: 'kpi-s', text: sub }) : null);
    const kpis = h('div', { class: 'kpis' },
      kpi('Entries this week', d.entriesThisWeek, `${d.totalEntries} total`),
      kpi('Setting changes (30 d)', d.changes30, 'actual vs last known'),
      d.notLoggedToday === null ? kpi(`${ST.L.lines} not logged today`, '—', 'turn on in Settings → Optional features', 'dim') : kpi(`${ST.L.lines} not logged today`, d.notLoggedToday, `of ${d.lineStatus.length} ${ST.L.lines.toLowerCase()}`, d.notLoggedToday ? 'warn' : ''),
      ST.opt('drift') ? kpi('Drift alerts', d.driftAlerts.length, `actual ≠ setpoint ${ST.state.settings.drift_n}+ in a row`, d.driftAlerts.length ? 'warn' : '') : kpi('Drift alerts', '—', 'off', 'dim'));

    // ----- trend
    const lineSel = ST.select([...new Set(allParts.map((p) => p.line))].map((l) => [String(l), ST.lineName(l)]), sel.line, { 'aria-label': ST.L.line });
    const partSel = ST.select(allParts.filter((p) => String(p.line) === String(sel.line)).map((p) => p.part_no), sel.part, { 'aria-label': 'Part' });
    const keySel = ST.select(trendFields.map((f) => [f.key, f.label]), sel.key, { 'aria-label': 'Field' });
    const compare = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: sel.compare, onchange: (e) => { sel.compare = e.target.checked; this.drawTrend(); } }), ' Compare lines');
    lineSel.onchange = () => { sel.line = lineSel.value; sel.part = ''; this.render(root); };
    partSel.onchange = () => { sel.part = partSel.value; this.drawTrend(); };
    keySel.onchange = () => { sel.key = keySel.value; this.drawTrend(); };
    this.trendBox = h('div', { class: 'chart-box', id: 'trend-box' });
    const png = h('button', { class: 'btn ghost sm', text: 'Save PNG', onclick: () => this.savePng(this.trendBox, `trend-${sel.key}`) });
    const trendCard = ST.card('Trend', h('div', {}, h('div', { class: 'toolbar' }, lineSel, partSel, keySel, ST.opt('compare') ? compare : null), this.trendBox), { class: 'span2', actions: png });

    // ----- most changed
    this.barBox = h('div', { class: 'chart-box', id: 'bar-box' });
    const barPng = h('button', { class: 'btn ghost sm', text: 'Save PNG', onclick: () => this.savePng(this.barBox, 'most-changed-settings') });
    const barCard = ST.card('Most-changed settings (30 d)', this.barBox, { actions: barPng });

    // ----- drift alerts
    const drift = ST.opt('drift')
      ? (d.driftAlerts.length ? h('ul', { class: 'list' }, d.driftAlerts.map((a) => h('li', {},
        h('div', { class: 'grow' }, h('b', { text: `${ST.L.line[0]}${a.line} · ${a.part_no}` }), ` ${a.label}`, h('div', { class: 'muted', text: `sheet ${a.setpoint} → actual ${a.actual} · ${a.streak} entries in a row` })),
        h('button', { class: 'btn sm', text: 'Review', onclick: () => ST.goData({ line: a.line, part: a.part_no, entry: a.entry_id }) }),
        h('button', { class: 'btn ghost sm', text: 'Dismiss', onclick: async () => { await ST.api('ackDrift', a.line, a.part_no, a.key); this.render(root); } }))))
        : h('p', { class: 'muted', text: 'No open drift alerts.' }))
      : h('p', { class: 'muted', text: 'Drift alerts are off (Settings → Optional features).' });

    const recent = d.recentChanges.length
      ? h('ul', { class: 'list' }, d.recentChanges.map((c) => h('li', { class: 'link', onclick: () => ST.goData({ line: c.line, part: c.part_no, entry: c.entry_id }) },
        h('div', { class: 'grow' }, h('b', { text: `${ST.L.line[0]}${c.line} · ${c.part_no}` }), ` ${c.label}`, h('div', { class: 'muted', text: ST.fmtDate(c.ts) + (c.reason ? ` · ${c.reason}` : '') })),
        h('span', { class: 'mono chg' }, `${c.from} → ${c.to}`))))
      : h('p', { class: 'muted', text: 'No changes yet. Log entries or load sample data in Settings → Data.' });

    const status = d.lineStatus ? ST.card(`${ST.L.line} status today`, h('div', { class: 'linegrid' }, d.lineStatus.map((l) => h('div', { class: `ls ${l.today ? 'ok' : 'miss'}` }, h('b', { text: `${ST.L.line[0]}${l.line}` }), h('span', { text: l.today ? 'Logged' : 'Not logged' }), h('small', { class: 'muted', text: l.last_ts ? `last ${ST.fmtDate(l.last_ts, true)}` : 'never' }))))) : null;

    const empty = ST.state.forms.length === 0
      ? ST.card('Set up this profile', h('div', { class: 'col tight' },
        h('p', { text: 'There are no forms yet. Import an Excel template to define the forms and fields for this job, or add a form by hand.' }),
        h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', text: 'Open Forms', onclick: () => ST.show('forms') }),
          h('span', { class: 'muted', text: 'Forms → Download template gives you a sheet to fill in; Import template… loads it back.' }))), { class: 'span2' }) : null;
    root.replaceChildren(empty, kpis, h('div', { class: 'grid' }, trendCard, barCard, ST.card('Drift alerts', drift), ST.card('Recent changes', recent), status));
    this.drawTrend();
    this.drawBar(d.mostChanged);
  },

  async drawTrend() {
    const sel = this.sel;
    let series; let unit = ''; let kind = 'number';
    if (sel.compare && ST.opt('compare')) {
      const c = await ST.api('compareTrend', { key: sel.key, part: sel.part });
      unit = c.unit; kind = c.kind;
      series = c.series.map((s) => ({ name: `${ST.L.line[0]}${s.line} · ${s.part_no}`, points: s.points.map((p) => ({ ts: p.ts, y: p.actual })) }));
    } else {
      const t = await ST.api('trend', { line: sel.line, part: sel.part, key: sel.key });
      unit = t.unit; kind = t.kind;
      series = [{ name: `${t.label} actual`, points: t.points.map((p) => ({ ts: p.ts, y: p.actual })) },
        { name: 'Sheet setpoint', dashed: true, step: true, points: t.points.filter((p) => p.setpoint !== null).map((p) => ({ ts: p.ts, y: p.setpoint })) }];
    }
    this.trendBox.replaceChildren(ST.charts.line(series, { unit, fmtY: (v) => Types.fmtAxis(kind, v) }));
  },
  drawBar(items) {
    this.barBox.replaceChildren(ST.charts.bar(items.map((i) => ({ label: i.label, value: i.count }))));
  },
  async savePng(box, name) {
    try {
      const svg = box.querySelector('svg');
      const url = await ST.charts.toPng(svg);
      const f = await ST.main('chart:png', url, name);
      if (f) ST.toast(`Saved ${f}`);
    } catch (e) { ST.fail(e); }
  },
};
