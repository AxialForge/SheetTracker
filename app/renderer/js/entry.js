'use strict';
// Data Entry: a blank fill-in form. Placeholders + "Last" column show previous values (carry-forward).
ST.tabs.entry = {
  title: 'Data Entry',
  S: null, // form state

  fresh(keep = {}) {
    const last = this.S?.header || {};
    return {
      line: keep.line ?? '', part: keep.part ?? '', ts: ST.nowLocal(),
      header: { sheet_rev: keep.sheet_rev ?? last.sheet_rev ?? '', sheet_revised: keep.sheet_revised ?? last.sheet_revised ?? '', hmi_file: keep.hmi_file ?? last.hmi_file ?? '', entered_by: ST.state.settings.entered_by || '' },
      values: {}, notes: '', reason: '', photo: '', latest: {}, allFields: [], fields: [], form: null, source: 'manual',
      first: false, showInitial: false, initialCount: 0,
    };
  },

  async render(root) {
    if (!this.S) this.S = this.fresh();
    this.root = root;
    const lines = ST.state.lineForms.map((l) => l.line);
    if (!this.S.line && lines.length) this.S.line = String(lines[0]);
    await this.loadContext();
    this.draw();
  },

  async loadContext() {
    const S = this.S;
    S.form = S.line ? await ST.api('formFor', Number(S.line)) : null;
    S.allFields = S.form ? (await ST.api('fieldsForForm', S.form)).filter((f) => f.visible) : [];
    S.latest = S.line && S.part ? await ST.api('latestValues', Number(S.line), S.part) : {};
    S.parts = S.line ? await ST.api('listParts', Number(S.line)) : [];
    S.first = !!(S.line && S.part) && (await ST.api('listEntries', { line: Number(S.line), part: S.part, limit: 1 })).total === 0;
    this.applyRole();
  },

  // "Set once" fields are asked on the first entry for a Line + Part, when the user turns them on,
  // and whenever they already hold a typed value (e.g. while revising an old entry).
  applyRole() {
    const S = this.S;
    const typed = (k) => { const v = S.values[k]; return !!v && !(Compare.blank(v.setpoint) && Compare.blank(v.actual)); };
    S.initialCount = S.allFields.filter((f) => f.role === 'initial').length;
    S.fields = S.allFields.filter((f) => f.role !== 'initial' || S.first || S.showInitial || typed(f.key));
  },

  async setLinePart(line, part) {
    const S = this.S;
    const partChanged = part !== S.part || line !== S.line;
    S.line = line; S.part = part;
    if (partChanged) {
      S.values = {}; S.showInitial = false;
      if (line && part) {
        const hdr = await ST.api('lastHeader', Number(line), part);
        if (hdr) Object.assign(S.header, hdr);
      }
    }
    await this.loadContext();
    this.draw();
  },

  // ---- helpers
  lastOf(key) { return this.S.latest[key] || {}; },
  val(key) { return this.S.values[key] || (this.S.values[key] = { setpoint: '', actual: '' }); },
  countChanges() {
    let n = 0;
    for (const f of this.S.fields) {
      if (!f.has_sp) continue;
      const v = this.S.values[f.key];
      if (v && Compare.changed(this.lastOf(f.key).actual, v.actual)) n++;
    }
    return n;
  },
  mark(input, key, which) {
    const f = this.S.fields.find((x) => x.key === key);
    const v = this.val(key);
    input.classList.remove('changed', 'drift');
    if (!f || !f.has_sp || which !== 'actual') return;
    if (Compare.changed(this.lastOf(key).actual, v.actual)) input.classList.add('changed');
    else if (Compare.drifted(v.setpoint, v.actual)) input.classList.add('drift');
  },
  refresh() {
    this.root.querySelectorAll('input[data-key][data-which="actual"]').forEach((inp) => this.mark(inp, inp.dataset.key, 'actual'));
    const btn = this.root.querySelector('#save-btn');
    if (btn) { const n = this.countChanges(); btn.textContent = `Save Entry (${n} change${n === 1 ? '' : 's'})`; }
  },

  input(key, which, placeholder) {
    const f = this.S.fields.find((x) => x.key === key);
    const inp = ST.h('input', {
      type: 'text', class: 'cell', 'data-key': key, 'data-which': which, placeholder: placeholder ?? '',
      inputmode: f && f.kind === 'number' ? 'decimal' : 'text', autocomplete: 'off', 'aria-label': `${f?.label || key} ${which}`,
      value: this.val(key)[which] || '',
      oninput: (e) => { this.val(key)[which] = e.target.value; this.mark(inp, key, which); this.refresh(); },
    });
    this.mark(inp, key, which);
    return inp;
  },

  settingsSection(sec, fields) {
    const { h } = ST;
    const rows = fields.map((f) => {
      const last = this.lastOf(f.key);
      return h('tr', {},
        h('td', { class: 'lbl', text: f.label }, f.unit ? h('small', { class: 'muted', text: ` ${f.unit}` }) : null, f.role === 'initial' ? h('small', { class: 'tag', text: 'setup' }) : null),
        h('td', {}, this.input(f.key, 'setpoint', last.setpoint ?? '')),
        h('td', {}, this.input(f.key, 'actual', last.actual ?? '')),
        h('td', { class: 'last mono', title: last.ts ? `as of ${ST.fmtDate(last.ts)}` : '' }, last.actual ?? '—'));
    });
    const open = !(localStorage.getItem(`st.collapse.${sec.key}`) === '1');
    const det = h('details', { class: 'card sec', open, ontoggle: () => localStorage.setItem(`st.collapse.${sec.key}`, det.open ? '0' : '1') },
      h('summary', {}, h('h3', { text: sec.label }), h('span', { class: 'muted', text: `${fields.length} settings` })),
      h('table', { class: 'grid-t' }, h('thead', {}, h('tr', {}, h('th', { text: 'Setting' }), h('th', { text: 'Setpoint (sheet)' }), h('th', { text: 'Actual' }), h('th', { text: 'Last' }))), h('tbody', {}, rows)));
    return det;
  },

  readingsCard(fields) {
    const { h } = ST;
    const rows = fields.map((f) => {
      const last = this.lastOf(f.key);
      return h('tr', {}, h('td', { class: 'lbl', text: f.label }, f.unit ? h('small', { class: 'muted', text: ` ${f.unit}` }) : null, f.role === 'initial' ? h('small', { class: 'tag', text: 'setup' }) : null),
        h('td', {}, this.input(f.key, 'actual', last.actual ?? '')), h('td', { class: 'last mono', text: last.actual ?? '—' }));
    });
    return ST.card('Readings', h('table', { class: 'grid-t' }, h('thead', {}, h('tr', {}, h('th', { text: 'Reading' }), h('th', { text: 'Actual' }), h('th', { text: 'Last' }))), h('tbody', {}, rows)), { class: 'readings' });
  },

  tonnageCard(fields) {
    const { h } = ST;
    const by = new Map(fields.map((f) => [f.key, f]));
    const rows = [1, 2, 3].map((p) => h('tr', {}, h('th', { text: `Piece ${p}` }),
      [1, 2, 3].map((s) => { const k = `ton_p${p}_s${s}`; return h('td', {}, by.has(k) ? this.input(k, 'actual', this.lastOf(k).actual ?? '') : null); })));
    return ST.card('Measured tonnage (T)', h('table', { class: 'grid-t tonnage' }, h('thead', {}, h('tr', {}, h('th'), [1, 2, 3].map((s) => h('th', { text: `Station ${s}` })))), h('tbody', {}, rows)),
      { class: 'tonnage-card' });
  },

  draw() {
    const { h } = ST; const S = this.S; const root = this.root;
    const lines = ST.state.lineForms.map((l) => String(l.line));
    const lineSel = ST.select(lines.map((l) => [l, `Line ${l}`]), S.line, { id: 'f-line', 'aria-label': 'Line' });
    lineSel.onchange = () => this.setLinePart(lineSel.value, '');
    const partIn = h('input', { type: 'text', id: 'f-part', list: 'parts-list', placeholder: 'Part No.', value: S.part, autocomplete: 'off', 'aria-label': 'Part No.' });
    partIn.onchange = () => this.setLinePart(S.line, partIn.value.trim());
    const hd = (label, ctrl) => h('label', { class: 'fld' }, h('span', { text: label }), ctrl);
    const hdr = h('div', { class: 'entry-head card' },
      hd('Line #', lineSel),
      hd('Part No.', partIn), h('datalist', { id: 'parts-list' }, (S.parts || []).map((p) => h('option', { value: p }))),
      h('div', { class: 'fld' }, h('span', { text: 'Form' }), h('span', { class: 'badge', text: S.form ? `Form ${S.form}` : '—' })),
      hd('Date / time', h('input', { type: 'datetime-local', value: S.ts, onchange: (e) => { S.ts = e.target.value; } })),
      hd('Sheet rev', h('input', { type: 'text', value: S.header.sheet_rev, oninput: (e) => { S.header.sheet_rev = e.target.value; } })),
      hd('Revised', h('input', { type: 'text', placeholder: 'date', value: S.header.sheet_revised, oninput: (e) => { S.header.sheet_revised = e.target.value; } })),
      hd('HMI file #', h('input', { type: 'text', value: S.header.hmi_file, oninput: (e) => { S.header.hmi_file = e.target.value; } })),
      hd('Entered by', h('input', { type: 'text', value: S.header.entered_by, oninput: (e) => { S.header.entered_by = e.target.value; } })));

    const secs = [];
    const sections = ST.state.sections.filter((s) => !['readings', 'tonnage'].includes(s.key)).map((s) => (s.key === 'custom' ? { key: 'custom', label: 'Custom settings' } : s));
    const known = new Set(sections.map((s) => s.key).concat(['readings', 'tonnage']));
    for (const sec of sections) {
      const fl = S.fields.filter((f) => f.has_sp && (f.section === sec.key || (sec.key === 'custom' && !known.has(f.section))));
      if (fl.length) secs.push(this.settingsSection(sec, fl));
    }
    const ton = S.fields.filter((f) => f.section === 'tonnage');
    const rd = S.fields.filter((f) => !f.has_sp && f.section !== 'tonnage');
    const side = h('div', { class: 'col' });
    if (ton.length) side.append(this.tonnageCard(ton));
    if (rd.length) side.append(this.readingsCard(rd));

    // notes + reason + photo
    const chips = ST.opt('reasons') ? h('div', { class: 'chips' }, ['Die change', 'Material', 'Quality', 'Maintenance', 'Other'].map((r) => h('button', { type: 'button', class: `chip ${S.reason === r ? 'on' : ''}`, text: r, onclick: () => { S.reason = S.reason === r ? '' : r; this.draw(); } }))) : null;
    const photo = ST.opt('photos') ? h('div', { class: 'photo-row' },
      h('button', { class: 'btn ghost sm', type: 'button', text: S.photo ? 'Change sheet photo…' : 'Attach sheet photo…', onclick: async () => { try { const p = await ST.main('dlg:pickPhoto'); if (p) { S.photo = p; this.draw(); } } catch (e) { ST.fail(e); } } }),
      S.photo ? h('span', { class: 'muted', text: S.photo.split(/[\\/]/).pop() }) : null,
      S.photo ? h('button', { class: 'btn ghost sm', type: 'button', text: 'Remove', onclick: () => { S.photo = ''; this.draw(); } }) : null) : null;
    const notes = ST.card('Notes', h('div', {}, chips, h('textarea', { id: 'f-notes', rows: 3, placeholder: 'Notes for this entry…', oninput: (e) => { S.notes = e.target.value; } , value: S.notes }), photo));
    side.append(notes);

    const setupNote = S.line && S.part && S.initialCount
      ? h('div', { class: 'card setup-note' }, S.first
        ? h('span', {}, h('b', { text: 'First entry for this Line + Part. ' }), `Fill the ${S.initialCount} setup field${S.initialCount === 1 ? '' : 's'} too; later entries only ask for the tracked fields.`)
        : h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.showInitial, onchange: (e) => { S.showInitial = e.target.checked; this.applyRole(); this.draw(); } }), `Show setup fields (${S.initialCount})`))
      : null;

    const nChanges = this.countChanges();
    const bar = h('div', { class: 'actionbar' },
      h('button', { class: 'btn ghost', text: 'Fill blanks with last values', onclick: () => this.fillBlanks() }),
      h('button', { class: 'btn ghost', text: 'Clear form', onclick: () => this.clearForm() }),
      h('div', { class: 'grow' }),
      h('span', { class: 'muted', text: 'Ctrl+S' }),
      h('button', { class: 'btn primary', id: 'save-btn', text: `Save Entry (${nChanges} change${nChanges === 1 ? '' : 's'})`, onclick: () => this.save() }));

    const body = !S.line ? h('p', { class: 'muted pad', text: 'Add a line in Settings → Line → Form.' })
      : !S.part ? h('p', { class: 'muted pad', text: 'Pick or type a Part No. to load the form and last values.' })
        : h('div', { class: 'entry-body' }, h('div', { class: 'col' }, secs), side);
    root.replaceChildren(...[hdr, setupNote, body, bar].filter(Boolean));
  },

  fillBlanks() {
    for (const f of this.S.fields) {
      if (!f.has_sp) continue;
      const last = this.lastOf(f.key); const v = this.val(f.key);
      if (Compare.blank(v.setpoint) && !Compare.blank(last.setpoint)) v.setpoint = last.setpoint;
      if (Compare.blank(v.actual) && !Compare.blank(last.actual)) v.actual = last.actual;
    }
    this.draw();
  },
  clearForm() {
    const S = this.S;
    S.values = {}; S.notes = ''; S.reason = ''; S.photo = ''; S.ts = ST.nowLocal(); S.source = 'manual';
    this.draw();
  },

  // Load an existing entry as a new revision (entries are append-only).
  prefill(e) {
    this.S = this.fresh({ line: String(e.line), part: e.part_no, sheet_rev: e.sheet_rev, sheet_revised: e.sheet_revised, hmi_file: e.hmi_file });
    this.S.header.entered_by = e.entered_by || this.S.header.entered_by;
    for (const [k, v] of Object.entries(e.values)) this.S.values[k] = { setpoint: v.setpoint ?? '', actual: v.actual ?? '' };
    this.S.notes = e.notes || ''; this.S.reason = e.reason || ''; this.S.source = 'revision';
  },

  async save() {
    const S = this.S;
    try {
      const values = {};
      for (const [k, v] of Object.entries(S.values)) values[k] = { setpoint: v.setpoint, actual: v.actual };
      const res = await ST.api('saveEntry', {
        line: S.line, part_no: S.part, entry_ts: S.ts, entered_by: S.header.entered_by, sheet_rev: S.header.sheet_rev,
        sheet_revised: S.header.sheet_revised, hmi_file: S.header.hmi_file, notes: S.notes, reason: S.reason, photo_src: S.photo || undefined,
        values, source: S.source,
      });
      ST.toast(`Saved entry #${res.id} · ${res.changes} change${res.changes === 1 ? '' : 's'}`);
      if (S.header.entered_by !== ST.state.settings.entered_by) { await ST.api('setSettings', { entered_by: S.header.entered_by }); ST.state.settings.entered_by = S.header.entered_by; }
      this.S = this.fresh({ line: S.line, part: S.part, ...S.header });
      await this.loadContext();
      this.draw();
    } catch (e) { ST.fail(e); }
  },
};
