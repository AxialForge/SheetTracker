'use strict';
// Data Entry: a blank fill-in form. Placeholders + "Last" column show previous values (carry-forward).
ST.tabs.entry = {
  title: 'Data Entry',
  S: null, // form state

  // "Show setup fields" is a per-PC preference, kept between entries and restarts.
  SHOW_KEY: 'st.showInitial',
  readShowInitial() { try { return localStorage.getItem(this.SHOW_KEY) === '1'; } catch { return false; } },
  writeShowInitial(on) { try { localStorage.setItem(this.SHOW_KEY, on ? '1' : '0'); } catch { /* preference only */ } },

  fresh(keep = {}) {
    const last = this.S?.header || {};
    return {
      line: keep.line ?? '', part: keep.part ?? '', ts: ST.nowLocal(),
      header: { sheet_rev: keep.sheet_rev ?? last.sheet_rev ?? '', sheet_revised: keep.sheet_revised ?? last.sheet_revised ?? '', hmi_file: keep.hmi_file ?? last.hmi_file ?? '', entered_by: ST.state.settings.entered_by || '' },
      values: {}, notes: '', reason: '', photo: '', latest: {}, allFields: [], fields: [], form: null, source: 'manual',
      first: false, actualsNow: false, showInitial: this.readShowInitial(), initialCount: 0,
      partInfo: null, newPartOk: '', suggest: {}, corrects: null, correctReason: '',
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
    S.suggest = await ST.api('valueSuggestions');
    S.partInfo = S.line && S.part ? await ST.api('checkPart', Number(S.line), S.part) : null;
    if (S.partInfo?.exists && S.partInfo.canonical !== S.part) S.part = S.partInfo.canonical; // "ab-100" -> the stored "AB-100"
    S.latest = S.line && S.part ? await ST.api('latestValues', Number(S.line), S.part) : {};
    S.parts = S.line ? await ST.api('listParts', Number(S.line)) : [];
    S.first = !!(S.line && S.part) && (await ST.api('listEntries', { line: Number(S.line), part: S.part, limit: 1 })).total === 0;
    this.applyRole();
  },

  // How many coils this Line + Part runs: what is typed now, else the last known value.
  coilCount() {
    const typed = this.S.values.num_coils?.actual;
    const n = parseInt(Compare.blank(typed) ? this.lastOf('num_coils').actual : typed, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  },

  // "Set once" fields are asked on the first entry for a Line + Part, when the user turns them on,
  // and whenever they already hold a typed value (e.g. while revising an old entry).
  // Coil rows beyond "Number of coils" are hidden unless something is already typed in them.
  applyRole() {
    const S = this.S;
    const typed = (k) => { const v = S.values[k]; return !!v && !(Compare.blank(v.setpoint) && Compare.blank(v.actual)); };
    const coils = this.coilCount();
    const beyondCoils = (k) => { const m = /^coil(\d+)_amps$/.exec(k); return !!(coils && m && Number(m[1]) > coils); };
    S.initialCount = S.allFields.filter((f) => f.role === 'initial').length;
    S.fields = S.allFields.filter((f) => (f.role !== 'initial' || S.first || S.showInitial || typed(f.key)) && !(beyondCoils(f.key) && !typed(f.key)));
  },

  async setLinePart(line, part) {
    const S = this.S;
    const partChanged = part !== S.part || line !== S.line;
    S.line = line; S.part = part;
    if (partChanged) S.actualsNow = false;
    if (partChanged && !S.corrects) { // a correction keeps what was typed so the part number itself can be fixed
      S.values = {};
      if (line && part) {
        const hdr = await ST.api('lastHeader', Number(line), part);
        if (hdr) Object.assign(S.header, hdr);
      }
    }
    await this.loadContext();
    this.draw();
  },

  // The first entry for a new part is its sheet: only the printed setpoints are asked. Actual values (and readings) are
  // asked from the next entry on. "Also enter actuals now" is the way around it for the rare first entry that has both.
  setupOnly() { const S = this.S; return !!S.first && !S.actualsNow && !S.corrects; },

  // ---- helpers
  lastOf(key) { return this.S.latest[key] || {}; },
  val(key) { return this.S.values[key] || (this.S.values[key] = { setpoint: '', actual: '' }); },
  countChanges() {
    let n = 0;
    if (this.setupOnly()) return 0;
    for (const f of this.S.fields) {
      if (!f.has_sp) continue;
      const v = this.S.values[f.key];
      if (v && Types.changed(f, this.lastOf(f.key).actual, v.actual)) n++;
    }
    return n;
  },
  // strict: also flag a value that does not fit the field's type (checked when the box is left, not while typing).
  mark(input, key, which, strict) {
    const f = this.S.fields.find((x) => x.key === key);
    const v = this.val(key);
    input.classList.remove('changed', 'drift', 'oor');
    if (strict !== undefined) {
      const r = f && !Compare.blank(v[which]) ? Types.parse(f, v[which]) : { ok: true };
      input.classList.toggle('bad', !r.ok);
      input.title = r.ok ? '' : r.error;
    }
    if (!f || which !== 'actual' || input.classList.contains('bad')) return;
    const range = Types.outOfRange(f, v.actual);
    if (range) { input.classList.add('oor'); input.title = `${range === 'low' ? 'Below' : 'Above'} the limit of ${range === 'low' ? f.min : f.max}${f.unit ? ` ${f.unit}` : ''}`; }
    if (!f.has_sp) return;
    if (Types.changed(f, this.lastOf(key).actual, v.actual)) input.classList.add('changed');
    else if (Types.drifted(f, v.setpoint, v.actual)) input.classList.add('drift');
  },
  refresh() {
    this.root.querySelectorAll('input[data-key][data-which="actual"]').forEach((inp) => this.mark(inp, inp.dataset.key, 'actual'));
    const btn = this.root.querySelector('#save-btn');
    if (btn) { const n = this.countChanges(); btn.textContent = `Save Entry (${n} change${n === 1 ? '' : 's'})`; }
  },

  // One entry box, shaped by the field's type: pick-lists and ratings are dropdowns, times and dates use the native pickers.
  input(key, which, placeholder) {
    const f = this.S.fields.find((x) => x.key === key);
    const kind = Types.kindOf(f);
    const cur = this.val(key)[which] || '';
    const base = { class: 'cell', 'data-key': key, 'data-which': which, 'aria-label': `${f?.label || key} ${which}` };
    let inp;
    const set = (e) => { this.val(key)[which] = e.target.value; this.mark(inp, key, which); this.refresh(); };
    const done = () => this.mark(inp, key, which, true);
    const dropdown = (values) => {
      const list = values.includes(cur) || !cur ? values : [cur, ...values];
      const hint = placeholder ? `last: ${placeholder}` : '';
      inp = ST.h('select', { ...base, class: 'cell sel', oninput: set, onchange: done },
        ST.h('option', { value: '', text: hint ? `— (${hint})` : '—' }), list.map((v) => ST.h('option', { value: v, text: v })));
      inp.value = cur;
      return inp;
    };
    const choices = Types.choicesOf(f);
    if (kind === 'choice' && choices.length) return this.finish(dropdown(choices), key, which);
    if (kind === 'yesno') return this.finish(dropdown(['Yes', 'No']), key, which);
    if (kind === 'rating') {
      const lo = f.min !== '' && f.min != null && !Number.isNaN(parseInt(f.min, 10)) ? parseInt(f.min, 10) : 1;
      const hi = Types.scaleOf(f);
      return this.finish(dropdown(Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => String(lo + i))), key, which);
    }
    const known = (kind === 'text' || kind === 'choice') && this.S.suggest[key]?.length ? `sug-${key}` : null; // pick-list + values already on record
    const hints = { ratio: 'x/y', duration: 'mm:ss or s' };
    inp = ST.h('input', {
      ...base, type: kind === 'time' ? 'time' : kind === 'date' ? 'date' : 'text', placeholder: placeholder || hints[kind] || '',
      inputmode: kind === 'number' || kind === 'duration' ? 'decimal' : 'text', autocomplete: 'off', value: cur, list: known,
      oninput: set, onchange: (e) => { set(e); done(); if (key === 'num_coils' && which === 'actual') { this.applyRole(); this.draw(); } },
    });
    return this.finish(inp, key, which);
  },
  finish(inp, key, which) { this.mark(inp, key, which); return inp; },

  settingsSection(sec, fields, readings = []) {
    const { h } = ST;
    const setupOnly = this.setupOnly();
    const rows = fields.map((f) => {
      const last = this.lastOf(f.key);
      const label = h('td', { class: 'lbl', text: f.label }, f.unit ? h('small', { class: 'muted', text: ` ${f.unit}` }) : null, f.role === 'initial' ? h('small', { class: 'tag', text: 'setup' }) : null);
      if (setupOnly) return h('tr', {}, label, h('td', {}, this.input(f.key, 'setpoint', last.setpoint ?? '')));
      return h('tr', {}, label,
        h('td', {}, this.input(f.key, 'setpoint', last.setpoint ?? '')),
        // with no actual on record yet (a part that has only its sheet), the sheet value is shown as the gray hint
        h('td', {}, this.input(f.key, 'actual', last.actual ?? last.setpoint ?? '')),
        h('td', { class: 'last mono', title: last.ts ? `as of ${ST.fmtDate(last.ts)}` : '' }, last.actual ?? '—'));
    });
    const open = !(localStorage.getItem(`st.collapse.${sec.key}`) === '1');
    const det = h('details', { class: 'card sec', open, ontoggle: () => localStorage.setItem(`st.collapse.${sec.key}`, det.open ? '0' : '1') },
      h('summary', {}, h('h3', { text: sec.label }), h('span', { class: 'muted', text: `${fields.length} setting${fields.length === 1 ? '' : 's'}` })),
      h('table', { class: 'grid-t' }, h('thead', {}, h('tr', {}, h('th', { text: 'Setting' }), h('th', { text: 'Setpoint (sheet)' }), setupOnly ? null : h('th', { text: 'Actual' }), setupOnly ? null : h('th', { text: 'Last' }))), h('tbody', {}, rows)),
      readings.length && !setupOnly ? this.readingRows(readings) : null);
    return det;
  },

  // Reading rows (actual only) as a table; used on their own card and under the settings of a mixed section.
  readingRows(fields) {
    const { h } = ST;
    const rows = fields.map((f) => {
      const last = this.lastOf(f.key);
      return h('tr', {}, h('td', { class: 'lbl', text: f.label }, f.unit ? h('small', { class: 'muted', text: ` ${f.unit}` }) : null, f.role === 'initial' ? h('small', { class: 'tag', text: 'setup' }) : null),
        h('td', {}, this.input(f.key, 'actual', last.actual ?? '')), h('td', { class: 'last mono', text: last.actual ?? '—' }));
    });
    return h('table', { class: 'grid-t' }, h('thead', {}, h('tr', {}, h('th', { text: 'Reading' }), h('th', { text: 'Actual' }), h('th', { text: 'Last' }))), h('tbody', {}, rows));
  },
  readingsCard(fields, title = 'Readings') {
    return ST.card(title, this.readingRows(fields), { class: 'readings' });
  },

  tonnageCard(fields) {
    const { h } = ST;
    const by = new Map(fields.map((f) => [f.key, f]));
    const rows = [1, 2, 3].map((p) => h('tr', {}, h('th', { text: `Piece ${p}` }),
      [1, 2, 3].map((s) => { const k = `ton_p${p}_s${s}`; return h('td', {}, by.has(k) ? this.input(k, 'actual', this.lastOf(k).actual ?? '') : null); })));
    return ST.card('Measured tonnage (T)', h('table', { class: 'grid-t tonnage' }, h('thead', {}, h('tr', {}, h('th'), [1, 2, 3].map((s) => h('th', { text: `Station ${s}` })))), h('tbody', {}, rows)),
      { class: 'tonnage-card' });
  },

  // Shown when the Part No. has no history on this line: confirm it is really new, or jump to a near match.
  partBanner() {
    const { h } = ST; const S = this.S; const info = S.partInfo;
    if (!S.line || !S.part || !info || info.exists) return null;
    const key = `${S.line}|${S.part}`;
    const sure = S.newPartOk === key;
    const near = info.similar.map((s) => h('button', { class: 'btn sm', type: 'button', text: `Use ${s.part_no} (${s.entries} entr${s.entries === 1 ? 'y' : 'ies'}, last ${ST.fmtDate(s.last_ts, true)})`, onclick: () => this.setLinePart(S.line, s.part_no) }));
    const other = info.otherLines.length ? ` Also logged on ${info.otherLines.map((o) => ST.lineName(o.line)).join(', ')}.` : '';
    return h('div', { class: `card setup-note ${sure ? 'ok' : 'warn'}`, id: 'newpart-note' },
      h('span', {}, h('b', { text: sure ? `New ${ST.L.partShort.toLowerCase()} confirmed. ` : `New ${ST.L.partShort.toLowerCase()}? ` }),
        `No history for “${S.part}” on ${ST.lineName(S.line)}. ${sure ? 'Its first entry becomes the baseline.' : `A mistyped ${ST.L.partShort.toLowerCase()} number starts a separate history with nothing to compare against.`}${other}`),
      near.length ? h('div', { class: 'toolbar' }, h('span', { class: 'muted', text: 'Did you mean:' }), near) : null,
      sure ? null : h('div', { class: 'toolbar' }, h('button', { class: 'btn primary sm', type: 'button', text: `Yes, this is a new ${ST.L.partShort.toLowerCase()}`, onclick: () => { S.newPartOk = key; this.draw(); } })));
  },

  // Shown while a correction is being typed: the original is voided when this is saved.
  correctBanner() {
    const { h } = ST; const S = this.S; const c = S.corrects;
    if (!c) return null;
    return h('div', { class: 'card setup-note warn' },
      h('span', {}, h('b', { text: `Correcting entry #${c.id}` }), ` (${ST.lineName(c.line)} · ${c.part_no} · ${ST.fmtDate(c.entry_ts)}). Saving voids the original: it stays on record but no longer counts as a change, and this entry replaces it.`),
      h('div', { class: 'toolbar' },
        h('label', { class: 'fld grow' }, h('span', { text: 'Reason for the correction (required)' }),
          h('input', { type: 'text', id: 'f-correct-reason', value: S.correctReason, placeholder: 'e.g. Typo in billet temp', oninput: (e) => { S.correctReason = e.target.value; } })),
        h('button', { class: 'btn ghost sm', type: 'button', text: 'Cancel correction', onclick: async () => { this.S = this.fresh({ line: S.line, part: S.part, ...S.header }); await this.loadContext(); this.draw(); } })));
  },

  draw() {
    const { h } = ST; const S = this.S; const root = this.root;
    const lines = ST.state.lineForms.map((l) => String(l.line));
    const lineSel = ST.select(lines.map((l) => [l, ST.lineName(l)]), S.line, { id: 'f-line', 'aria-label': ST.L.line });
    lineSel.onchange = () => this.setLinePart(lineSel.value, '');
    const partIn = h('input', { type: 'text', id: 'f-part', list: 'parts-list', placeholder: ST.L.part, value: S.part, autocomplete: 'off', 'aria-label': ST.L.part });
    partIn.onchange = () => this.setLinePart(S.line, partIn.value.trim());
    const hd = (label, ctrl) => h('label', { class: 'fld' }, h('span', { text: label }), ctrl);
    const hdr = h('div', { class: 'entry-head card' },
      hd(`${ST.L.line} #`, lineSel),
      hd(ST.L.part, partIn), h('datalist', { id: 'parts-list' }, (S.parts || []).map((p) => h('option', { value: p }))),
      h('div', { class: 'fld' }, h('span', { text: 'Form' }), h('span', { class: 'badge', text: S.form ? `Form ${S.form}` : '—' })),
      hd('Date / time', h('input', { type: 'datetime-local', value: S.ts, onchange: (e) => { S.ts = e.target.value; } })),
      hd('Sheet rev', h('input', { type: 'text', value: S.header.sheet_rev, oninput: (e) => { S.header.sheet_rev = e.target.value; } })),
      hd('Revised', h('input', { type: 'text', placeholder: 'date', value: S.header.sheet_revised, oninput: (e) => { S.header.sheet_revised = e.target.value; } })),
      hd('HMI file #', h('input', { type: 'text', value: S.header.hmi_file, oninput: (e) => { S.header.hmi_file = e.target.value; } })),
      hd('Entered by', h('input', { type: 'text', value: S.header.entered_by, oninput: (e) => { S.header.entered_by = e.target.value; } })));

    const setupOnly = this.setupOnly();
    const secs = [];
    const side = h('div', { class: 'col' });
    // Sections come from the database. A section with any settings is a card on the left (its readings ride along under the
    // settings); a section that only holds readings is a card on the right. The tonnage grid is the one special layout.
    const isTon = (f) => !f.has_sp && /^ton_p\d_s\d$/.test(f.key);
    const ton = S.fields.filter(isTon);
    const rest = S.fields.filter((f) => !isTon(f));
    const known = new Set(ST.state.sections.map((x) => x.key));
    const order = [...ST.state.sections.map((x) => (x.key === 'custom' ? { key: 'custom', label: 'Custom settings' } : x)), ...(rest.some((f) => !known.has(f.section)) ? [{ key: '__other', label: 'Other' }] : [])];
    const inSec = (sec, f) => (sec.key === '__other' ? !known.has(f.section) : f.section === sec.key);
    for (const sec of order) {
      const mine = rest.filter((f) => inSec(sec, f));
      const sets = mine.filter((f) => f.has_sp); const reads = mine.filter((f) => !f.has_sp);
      if (sets.length) secs.push(this.settingsSection(sec, sets, reads));
      else if (reads.length && !setupOnly) side.append(this.readingsCard(reads, sec.key === 'readings' ? 'Readings' : sec.label));
    }
    if (ton.length && !setupOnly) side.prepend(this.tonnageCard(ton));

    // notes + reason + photo
    const chips = ST.opt('reasons') ? h('div', { class: 'chips' }, ['Die change', 'Material', 'Quality', 'Maintenance', 'Other'].map((r) => h('button', { type: 'button', class: `chip ${S.reason === r ? 'on' : ''}`, text: r, onclick: () => { S.reason = S.reason === r ? '' : r; this.draw(); } }))) : null;
    const photo = ST.opt('photos') ? h('div', { class: 'photo-row' },
      h('button', { class: 'btn ghost sm', type: 'button', text: S.photo ? 'Change sheet photo…' : 'Attach sheet photo…', onclick: async () => { try { const p = await ST.main('dlg:pickPhoto'); if (p) { S.photo = p; this.draw(); } } catch (e) { ST.fail(e); } } }),
      S.photo ? h('span', { class: 'muted', text: S.photo.split(/[\\/]/).pop() }) : null,
      S.photo ? h('button', { class: 'btn ghost sm', type: 'button', text: 'Remove', onclick: () => { S.photo = ''; this.draw(); } }) : null) : null;
    const notes = ST.card('Notes', h('div', {}, chips, h('textarea', { id: 'f-notes', rows: 3, placeholder: 'Notes for this entry…', oninput: (e) => { S.notes = e.target.value; } , value: S.notes }), photo));
    side.append(notes);

    const setupNote = S.line && S.part && S.first && !S.corrects
      ? h('div', { class: 'card setup-note ok' },
        h('span', {}, h('b', { text: `First entry for this ${ST.L.line} + ${ST.L.partShort.toLowerCase()}: enter the sheet setpoints only. ` }),
          `${S.initialCount ? `That includes the ${S.initialCount} setup field${S.initialCount === 1 ? '' : 's'}. ` : ''}Actual values and readings are asked from the next entry on.`),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.actualsNow, onchange: (e) => { S.actualsNow = e.target.checked; this.draw(); } }), ' Also enter actual values now'))
      : S.line && S.part && S.initialCount && !S.corrects
        ? h('div', { class: 'card setup-note' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.showInitial, onchange: (e) => { S.showInitial = e.target.checked; this.writeShowInitial(S.showInitial); this.applyRole(); this.draw(); } }), `Show setup fields (${S.initialCount})`)) : null;
    const lists = h('div', { hidden: true }, Object.entries(S.suggest || {}).map(([k, vals]) => h('datalist', { id: `sug-${k}` }, vals.map((v) => h('option', { value: v })))));

    const nChanges = this.countChanges();
    const bar = h('div', { class: 'actionbar' },
      h('button', { class: 'btn ghost', text: 'Fill blanks with last values', onclick: () => this.fillBlanks() }),
      h('button', { class: 'btn ghost', text: 'Clear form', onclick: () => this.clearForm() }),
      h('div', { class: 'grow' }),
      h('span', { class: 'muted', text: 'Ctrl+S' }),
      h('button', { class: 'btn primary', id: 'save-btn', text: `Save Entry (${nChanges} change${nChanges === 1 ? '' : 's'})`, onclick: () => this.save() }));

    const body = !S.line ? h('p', { class: 'muted pad', text: `Add a ${ST.L.line.toLowerCase()} in Settings, or set up forms in Forms → Import template.` })
      : !S.part ? h('p', { class: 'muted pad', text: `Pick or type a ${ST.L.part} to load the form and last values.` })
        : h('div', { class: 'entry-body' }, h('div', { class: 'col' }, secs), side);
    root.replaceChildren(...[hdr, this.correctBanner(), this.partBanner(), setupNote, body, bar, lists].filter(Boolean));
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

  // Load an existing entry as a new revision (entries are append-only). With `correcting`, saving also voids the original.
  prefill(e, correcting = false) {
    this.S = this.fresh({ line: String(e.line), part: e.part_no, sheet_rev: e.sheet_rev, sheet_revised: e.sheet_revised, hmi_file: e.hmi_file });
    this.S.header.entered_by = e.entered_by || this.S.header.entered_by;
    for (const [k, v] of Object.entries(e.values)) this.S.values[k] = { setpoint: v.setpoint ?? '', actual: v.actual ?? '' };
    this.S.notes = e.notes || ''; this.S.reason = e.reason || ''; this.S.source = 'revision';
    if (correcting) this.S.corrects = { id: e.id, line: e.line, part_no: e.part_no, entry_ts: e.entry_ts };
  },

  async save() {
    const S = this.S;
    try {
      if (S.corrects && !S.correctReason.trim()) { ST.toast('Enter a reason for the correction first.', 'err'); document.getElementById('f-correct-reason')?.focus(); return; }
      if (S.partInfo && !S.partInfo.exists && S.newPartOk !== `${S.line}|${S.part}`) {
        ST.toast(`New ${ST.L.partShort.toLowerCase()}? Confirm it (or pick the existing one) before saving.`, 'err');
        document.getElementById('newpart-note')?.scrollIntoView({ block: 'center' });
        return;
      }
      const values = {};
      const setupOnly = this.setupOnly();
      const settings = new Set(S.fields.filter((f) => f.has_sp).map((f) => f.key));
      for (const [k, v] of Object.entries(S.values)) {
        if (setupOnly && !settings.has(k)) continue;           // readings are not part of a sheet's setpoints
        values[k] = { setpoint: v.setpoint, actual: setupOnly ? '' : v.actual };
      }
      const res = await ST.api('saveEntry', {
        line: S.line, part_no: S.part, entry_ts: S.ts, entered_by: S.header.entered_by, sheet_rev: S.header.sheet_rev,
        sheet_revised: S.header.sheet_revised, hmi_file: S.header.hmi_file, notes: S.notes, reason: S.reason, photo_src: S.photo || undefined,
        values, source: S.source, corrects: S.corrects ? S.corrects.id : undefined, correct_reason: S.corrects ? S.correctReason.trim() : undefined,
      });
      ST.toast(`Saved entry #${res.id} · ${res.changes} change${res.changes === 1 ? '' : 's'}`);
      if (S.header.entered_by !== ST.state.settings.entered_by) { await ST.api('setSettings', { entered_by: S.header.entered_by }); ST.state.settings.entered_by = S.header.entered_by; }
      this.S = this.fresh({ line: S.line, part: S.part, ...S.header });
      await this.loadContext();
      this.draw();
    } catch (e) { ST.fail(e); }
  },
};
