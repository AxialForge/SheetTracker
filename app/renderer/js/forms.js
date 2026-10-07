'use strict';
// Forms: add / renumber / delete forms and choose which fields each one carries.
// Role "tracked" = changes day to day and is asked on every entry.
// Role "set once" = fixed setup values, asked on the first entry for a Line + Part (and on demand after that).
ST.tabs.forms = {
  title: 'Forms',
  sel: null,

  // Per-type extras: pick-list, rating scale, or min/max limits.
  optionsCell(f, patch) {
    const { h } = ST;
    const small = (value, label, title, key) => h('input', { type: 'text', class: 'cell left short', value: value || '', placeholder: label, title, 'aria-label': `${f.label} ${label}`, onchange: (e) => patch(f, { [key]: e.target.value })() });
    if (f.kind === 'choice' || (f.kind === 'text' && f.has_sp)) {
      return h('input', { type: 'text', class: 'cell left pick-list', value: String(f.choices || '').split('\n').filter(Boolean).join('; '), placeholder: f.kind === 'choice' ? 'Allowed values: Standard; Heavy' : 'e.g. Standard; Heavy', 'aria-label': `${f.label} pick-list`,
        title: f.kind === 'choice' ? 'The only values allowed, separated by semicolons. Leave empty to accept any text.' : 'Known values, separated by semicolons. They are offered on Data Entry, and typed values are matched to them ignoring case and spacing.',
        onchange: (e) => patch(f, { choices: e.target.value })() });
    }
    if (f.kind === 'rating') return h('div', { class: 'toolbar tight' }, small(f.min, 'lowest', 'Lowest rating (default 1)', 'min'), small(f.max, 'scale', 'Highest rating, e.g. 5 for x/5 (default 5)', 'max'));
    if (f.kind === 'number' || f.kind === 'duration' || f.kind === 'time') return h('div', { class: 'toolbar tight' }, small(f.min, 'min', 'Values below this are flagged (not blocked)', 'min'), small(f.max, 'max', 'Values above this are flagged (not blocked)', 'max'));
    return null;
  },

  // Excel round trip: download a template, edit it in Excel, import it back (with a preview of every change).
  excelCard(cur, again) {
    const { h } = ST;
    const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { ST.fail(e); } };
    const download = (opts, what) => guard(async () => {
      const r = await ST.main('template:export', opts);
      if (r) { ST.toast(`${what} saved`); await ST.main('shell:showItem', r.file); }
    });
    return ST.card('Excel template', h('div', { class: 'col tight' },
      h('p', { class: 'muted', text: 'Download a form as an Excel sheet, add or edit fields there, then import it back. You see a preview before anything changes; stored entries are never touched. The same file carries a form set to another job.' }),
      h('div', { class: 'toolbar' },
        cur ? h('button', { class: 'btn', text: `Download form ${cur.form_no}`, onclick: download({ forms: [cur.form_no] }, `Form ${cur.form_no} template`) }) : null,
        h('button', { class: 'btn', text: 'Download all forms', onclick: download({ forms: 'all' }, 'Template') }),
        h('button', { class: 'btn ghost', text: 'Blank template', onclick: download({ blank: true }, 'Blank template') })),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', text: 'Import template…', onclick: guard(async () => { await this.importTemplate(again); }) }))));
  },

  async importTemplate(again) {
    const { h } = ST;
    const file = await ST.main('template:pick');
    if (!file) return;
    const opts = { removeMissing: false };
    for (;;) {
      const plan = await ST.api('previewTemplate', file, opts);
      const sum = plan.summary;
      const chip = (n, text) => h('span', { class: n ? 'on' : '', text: `${text}: ${n}` });
      const listOf = (cls, items) => (items.length ? h('ul', { class: `plan-list ${cls}` }, items.map((t) => h('li', { text: t }))) : null);
      const changed = plan.fields.filter((f) => f.status === 'changed');
      const added = plan.fields.filter((f) => f.status === 'new');
      const members = plan.membership.filter((m) => m.action !== 'same' && !(m.action === 'add' && added.some((f) => f.key === m.key)));
      const body = (close) => h('div', { class: 'col tight' },
        h('p', { class: 'muted', text: file.split(/[\\/]/).pop() }),
        plan.errors.length ? h('div', {}, h('b', { text: `${plan.errors.length} problem${plan.errors.length === 1 ? '' : 's'} to fix in the file first` }), listOf('plan-err', plan.errors.slice(0, 40))) : null,
        !plan.errors.length ? h('div', { class: 'plan-sum' }, chip(sum.formsAdded, 'New forms'), chip(sum.sectionsAdded, 'New sections'), chip(sum.fieldsAdded, 'New fields'), chip(sum.fieldsChanged, 'Fields edited'),
          chip(sum.fieldsOnForms, 'Added to forms'), chip(sum.roleChanges, 'Role changes'), chip(sum.removed, 'Removed from forms'), chip(sum.linesSet, 'Lines re-pointed')) : null,
        !plan.errors.length && !plan.changed ? h('p', { text: 'Nothing to change: this template matches what is already set up.' }) : null,
        plan.warnings.length ? h('div', {}, h('b', { text: 'Notes' }), listOf('plan-warn', plan.warnings.slice(0, 30))) : null,
        added.length ? h('div', {}, h('b', { text: 'New fields' }), listOf('', added.slice(0, 60).map((f) => `${f.label} — ${Types.label(f.attrs.kind).split(' (')[0]}${f.attrs.unit ? `, ${f.attrs.unit}` : ''}`))) : null,
        changed.length ? h('div', {}, h('b', { text: 'Edited fields' }), h('table', { class: 'plan-tbl' }, h('tbody', {}, changed.slice(0, 80).flatMap((f) => f.changes.map((c, i) => h('tr', {}, h('td', { text: i ? '' : f.label }), h('td', { class: 'muted', text: c.what }), h('td', { text: c.from || '—' }), h('td', { text: '→' }), h('td', { text: c.to || '—' }))))))) : null,
        members.length ? h('div', {}, h('b', { text: 'Form membership' }), listOf('', members.slice(0, 80).map((m) => `Form ${m.form_no}: ${m.label} — ${m.action === 'add' ? `add (${m.role === 'initial' ? 'set once' : 'tracked'})` : m.action === 'role' ? `now ${m.role === 'initial' ? 'set once' : 'tracked'}` : 'remove'}`))) : null,
        plan.lines.length ? h('div', {}, h('b', { text: 'Lines' }), listOf('', plan.lines.map((l) => `Line ${l.line} → form ${l.form_no}${l.from ? ` (was ${l.from})` : ''}`))) : null,
        !plan.errors.length ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: opts.removeMissing, onchange: (e) => { opts.removeMissing = e.target.checked; close('again'); } }),
          ' Also take fields that are not in this template off the forms it lists (their stored values are kept)') : null);
      const go = await ST.modal({ title: 'Import template', wide: true, body,
        buttons: plan.errors.length || !plan.changed ? [{ text: 'Close', primary: true, value: null }] : [{ text: 'Cancel', value: null }, { text: 'Apply', primary: true, value: 'apply' }] });
      if (go === 'again') continue;
      if (go === 'apply') {
        const res = await ST.api('applyTemplate', file, { removeMissing: opts.removeMissing });
        ST.toast(res.applied ? `Template applied: ${res.summary.fieldsAdded} new fields, ${res.summary.fieldsChanged} edited` : 'Nothing to change');
        await again();
      }
      return;
    }
  },

  async render(root) {
    const { h } = ST;
    const forms = ST.state.forms;
    if (!forms.some((f) => f.form_no === this.sel)) this.sel = forms.length ? forms[0].form_no : null;
    const again = async () => { await ST.refreshCore(); await this.render(root); };
    const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { ST.fail(e); } };

    // ---- left: form list + add
    const items = forms.map((f) => h('button', { class: `form-item ${f.form_no === this.sel ? 'on' : ''}`, type: 'button', onclick: () => { this.sel = f.form_no; this.render(root); } },
      h('b', { class: 'mono', text: `Form ${f.form_no}` }),
      f.name ? h('span', { text: f.name }) : null,
      h('small', { class: 'muted', text: `${f.lines.length ? `Line ${f.lines.join(', ')}` : 'no lines'} · ${f.tracked} tracked · ${f.initial} set once` })));
    const nf = { form_no: '', name: '', copyFrom: '' };
    const addForm = h('div', { class: 'col tight' },
      h('div', { class: 'toolbar' },
        h('input', { type: 'number', min: 1, class: 'short', placeholder: 'Form #', 'aria-label': 'New form number', oninput: (e) => { nf.form_no = e.target.value; } }),
        h('input', { type: 'text', placeholder: 'Name (optional)', 'aria-label': 'New form name', oninput: (e) => { nf.name = e.target.value; } })),
      h('div', { class: 'toolbar' },
        h('label', { class: 'inl' }, 'Start from ', ST.select([['', 'empty'], ...forms.map((f) => [String(f.form_no), `a copy of ${f.form_no}`])], '', { onchange: (e) => { nf.copyFrom = e.target.value; } })),
        h('button', { class: 'btn', text: 'Add form', onclick: guard(async () => { await ST.api('addForm', { form_no: nf.form_no, name: nf.name, copyFrom: nf.copyFrom || undefined }); this.sel = Number(nf.form_no); await again(); ST.toast('Form added'); }) })));
    const mapped = (await ST.api('getSettings')).field_map === 'vf1';
    const apply = mapped ? null : h('div', { class: 'setup-note' }, h('span', { text: 'This database still has the generic starter fields.' }),
      h('button', { class: 'btn sm', text: 'Apply sheet fields', title: 'Re-lay forms 10880 / 10899 / 10900 / 10903 with the real setup-sheet fields', onclick: guard(async () => { if (!confirm('Replace the field layout of forms 10880, 10899, 10900 and 10903 with the real sheet fields?\n\nStored entries are kept.')) return; await ST.api('applyFieldMap'); await again(); ST.toast('Sheet fields applied'); }) }));
    const listCard = h('div', { class: 'col' }, ST.card('Forms', h('div', { class: 'col tight' }, apply, h('div', { class: 'form-list' }, items.length ? items : h('p', { class: 'muted', text: 'No forms yet.' })), addForm)), this.excelCard(forms.find((f) => f.form_no === this.sel), again));

    const cur = forms.find((f) => f.form_no === this.sel);
    if (!cur) { root.replaceChildren(h('div', { class: 'forms-layout' }, listCard, ST.card('', h('p', { class: 'muted pad', text: 'Add a form to start.' })))); return; }

    // ---- right: selected form
    const allFields = ST.state.fields;
    const formFields = await ST.api('getFormFields', cur.form_no);
    const onForm = new Set(formFields.map((f) => f.key));
    const sections = ST.state.sections;
    const secOrder = new Map(sections.map((s, i) => [s.key, i]));
    const secLabel = (k) => sections.find((s) => s.key === k)?.label || k;

    const renum = { v: String(cur.form_no) };
    const head = ST.card(`Form ${cur.form_no}`, h('div', { class: 'col tight' },
      h('div', { class: 'toolbar' },
        h('label', { class: 'fld' }, h('span', { text: 'Name' }), h('input', { type: 'text', value: cur.name, placeholder: 'e.g. 4000T five-coil form', onchange: guard(async (e) => { await ST.api('updateForm', cur.form_no, { name: e.target.value }); await again(); ST.toast('Saved'); }) })),
        h('label', { class: 'fld grow' }, h('span', { text: 'Notes' }), h('input', { type: 'text', value: cur.notes, onchange: guard(async (e) => { await ST.api('updateForm', cur.form_no, { notes: e.target.value }); ST.toast('Saved'); }) }))),
      h('div', { class: 'toolbar' },
        h('span', { class: 'muted', text: cur.lines.length ? `Used by line${cur.lines.length > 1 ? 's' : ''} ${cur.lines.join(', ')}` : 'Not used by any line' }),
        h('div', { class: 'grow' }),
        h('input', { type: 'number', min: 1, class: 'short', value: renum.v, 'aria-label': 'New form number', oninput: (e) => { renum.v = e.target.value; } }),
        h('button', { class: 'btn ghost sm', text: 'Change number', title: 'Renumber this form everywhere it is used', onclick: guard(async () => { await ST.api('renameForm', cur.form_no, renum.v); this.sel = Number(renum.v); await again(); ST.toast('Renumbered'); }) }),
        h('button', { class: 'btn ghost sm', text: 'Delete form', onclick: guard(async () => { if (!confirm(`Delete form ${cur.form_no}?\n\nStored entries are not affected.`)) return; await ST.api('deleteForm', cur.form_no); await again(); ST.toast('Form deleted'); }) })),
      h('p', { class: 'muted', text: 'Lines are pointed at a form in Settings → Line → Form. Name, unit, type and section are shared by every form that uses a field; the role is per form.' })));

    const roleSel = (f) => ST.select([['tracked', 'Tracked'], ['initial', 'Set once']], f.role, { 'aria-label': `${f.label} role`, onchange: guard(async (e) => { await ST.api('setFormField', cur.form_no, f.key, e.target.value); await again(); }) });
    const patch = (f, p, msg = 'Saved') => guard(async () => { await ST.api('updateField', f.key, p); await ST.refreshCore(); ST.toast(msg); });
    const rows = [];
    let lastSec = null;
    const sorted = formFields.slice().sort((a, b) => (secOrder.get(a.section) ?? 99) - (secOrder.get(b.section) ?? 99) || a.sort - b.sort);
    for (const f of sorted) {
      if (f.section !== lastSec) { lastSec = f.section; rows.push(h('tr', { class: 'sec-row' }, h('th', { colspan: 8, text: secLabel(f.section) }))); }
      rows.push(h('tr', { class: f.visible ? '' : 'dim' },
        h('td', {}, h('input', { type: 'text', class: 'cell left', value: f.label, 'aria-label': `Name of ${f.key}`, onchange: (e) => patch(f, { label: e.target.value })() })),
        h('td', {}, ST.select(sections.map((s) => [s.key, s.label]), f.section, { 'aria-label': `${f.label} section`, onchange: guard(async (e) => { await ST.api('updateField', f.key, { section: e.target.value }); await again(); }) })),
        h('td', {}, ST.select(Types.KINDS.map((k) => [k.key, k.label]), f.kind, { 'aria-label': `${f.label} type`, title: Types.hint(f.kind), onchange: guard(async (e) => { await ST.api('updateField', f.key, { kind: e.target.value }); await again(); ST.toast('Saved'); }) })),
        h('td', {}, ST.select([['1', 'Setting'], ['0', 'Reading']], String(f.has_sp), { 'aria-label': `${f.label} setting or reading`, title: 'Settings have a sheet setpoint and are change-tracked; readings are actual-only', onchange: (e) => patch(f, { has_sp: e.target.value === '1' })() })),
        h('td', {}, h('input', { type: 'text', class: 'cell left short', value: f.unit || '', 'aria-label': `${f.label} unit`, onchange: (e) => patch(f, { unit: e.target.value })() })),
        h('td', {}, roleSel(f)),
        h('td', {}, this.optionsCell(f, patch)),
        h('td', {}, h('button', { class: 'btn ghost sm', text: 'Remove', title: 'Take this field off the form. Stored values are kept.', onclick: guard(async () => { await ST.api('removeFormField', cur.form_no, f.key); await again(); }) }))));
    }
    const table = formFields.length
      ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'data-t' }, h('thead', {}, h('tr', {}, ['Name', 'Section', 'Type', 'Kind', 'Unit', 'Role', 'Options / limits', ''].map((t) => h('th', { text: t })))), h('tbody', {}, rows)))
      : h('p', { class: 'muted', text: 'This form has no fields yet. Add some below.' });
    const legend = h('p', { class: 'muted', text: 'Tracked: changes day to day, asked on every entry. Set once: fixed setup values, asked on the first entry for a Line + Part and available on later entries with “Show setup fields”.' });
    const fieldsCard = ST.card(`Fields on form ${cur.form_no} (${cur.tracked} tracked · ${cur.initial} set once)`, h('div', { class: 'col tight' }, legend, table));

    // add an existing field
    const avail = allFields.filter((f) => !onForm.has(f.key)).sort((a, b) => (secOrder.get(a.section) ?? 99) - (secOrder.get(b.section) ?? 99) || a.sort - b.sort);
    const ex = { key: avail[0]?.key || '', role: 'tracked' };
    const existing = h('div', { class: 'toolbar' },
      avail.length ? ST.select(avail.map((f) => [f.key, `${secLabel(f.section)} — ${f.label}`]), ex.key, { 'aria-label': 'Field to add', onchange: (e) => { ex.key = e.target.value; } }) : h('span', { class: 'muted', text: 'Every field is already on this form.' }),
      avail.length ? ST.select([['tracked', 'Tracked'], ['initial', 'Set once']], 'tracked', { 'aria-label': 'Role', onchange: (e) => { ex.role = e.target.value; } }) : null,
      avail.length ? h('button', { class: 'btn', text: 'Add to this form', onclick: guard(async () => { await ST.api('setFormField', cur.form_no, ex.key, ex.role); await again(); ST.toast('Field added'); }) }) : null);

    // create a brand-new field
    const nfld = { label: '', unit: '', kind: 'number', has_sp: '1', section: 'custom', role: 'tracked', everywhere: false };
    const create = h('div', { class: 'col tight' },
      h('div', { class: 'toolbar' },
        h('input', { type: 'text', placeholder: 'New field name', 'aria-label': 'New field name', oninput: (e) => { nfld.label = e.target.value; } }),
        h('input', { type: 'text', placeholder: 'unit', class: 'short', 'aria-label': 'Unit', oninput: (e) => { nfld.unit = e.target.value; } }),
        ST.select(Types.KINDS.map((k) => [k.key, k.label]), 'number', { 'aria-label': 'Type', onchange: (e) => { nfld.kind = e.target.value; } }),
        ST.select([['1', 'Setting (setpoint + actual, change-tracked)'], ['0', 'Reading (actual only)']], '1', { 'aria-label': 'Setting or reading', onchange: (e) => { nfld.has_sp = e.target.value; } })),
      h('div', { class: 'toolbar' },
        ST.select(sections.map((s) => [s.key, s.label]), 'custom', { 'aria-label': 'Section', onchange: (e) => { nfld.section = e.target.value; } }),
        ST.select([['tracked', 'Tracked'], ['initial', 'Set once']], 'tracked', { 'aria-label': 'Role', onchange: (e) => { nfld.role = e.target.value; } }),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', onchange: (e) => { nfld.everywhere = e.target.checked; } }), 'Add to every form'),
        h('button', { class: 'btn primary', text: 'Create field', onclick: guard(async () => {
          await ST.api('addField', { label: nfld.label, unit: nfld.unit, kind: nfld.kind, has_sp: nfld.has_sp === '1', section: nfld.section, role: nfld.role, forms: nfld.everywhere ? 'all' : [cur.form_no] });
          await again(); ST.toast('Field created');
        }) })));
    const addCard = ST.card('Add a field', h('div', { class: 'col tight' }, h('b', { text: 'Existing field' }), existing, h('b', { text: 'New field' }), create));

    root.replaceChildren(h('div', { class: 'forms-layout' }, listCard, h('div', { class: 'col' }, head, fieldsCard, addCard)));
  },
};
