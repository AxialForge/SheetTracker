'use strict';
// Forms: add / renumber / delete forms and choose which fields each one carries.
// Role "tracked" = changes day to day and is asked on every entry.
// Role "set once" = fixed setup values, asked on the first entry for a Line + Part (and on demand after that).
ST.tabs.forms = {
  title: 'Forms',
  sel: null,

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
    const listCard = ST.card('Forms', h('div', { class: 'col tight' }, apply, h('div', { class: 'form-list' }, items.length ? items : h('p', { class: 'muted', text: 'No forms yet.' })), addForm));

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
      if (f.section !== lastSec) { lastSec = f.section; rows.push(h('tr', { class: 'sec-row' }, h('th', { colspan: 7, text: secLabel(f.section) }))); }
      rows.push(h('tr', { class: f.visible ? '' : 'dim' },
        h('td', {}, h('input', { type: 'text', class: 'cell left', value: f.label, 'aria-label': `Name of ${f.key}`, onchange: (e) => patch(f, { label: e.target.value })() })),
        h('td', {}, ST.select(sections.map((s) => [s.key, s.label]), f.section, { 'aria-label': `${f.label} section`, onchange: guard(async (e) => { await ST.api('updateField', f.key, { section: e.target.value }); await again(); }) })),
        h('td', {}, ST.select([['number', 'Number'], ['text', 'Text']], f.kind, { 'aria-label': `${f.label} type`, onchange: (e) => patch(f, { kind: e.target.value })() })),
        h('td', {}, ST.select([['1', 'Setting'], ['0', 'Reading']], String(f.has_sp), { 'aria-label': `${f.label} setting or reading`, title: 'Settings have a sheet setpoint and are change-tracked; readings are actual-only', onchange: (e) => patch(f, { has_sp: e.target.value === '1' })() })),
        h('td', {}, h('input', { type: 'text', class: 'cell left short', value: f.unit || '', 'aria-label': `${f.label} unit`, onchange: (e) => patch(f, { unit: e.target.value })() })),
        h('td', {}, roleSel(f)),
        h('td', {}, h('button', { class: 'btn ghost sm', text: 'Remove', title: 'Take this field off the form. Stored values are kept.', onclick: guard(async () => { await ST.api('removeFormField', cur.form_no, f.key); await again(); }) }))));
    }
    const table = formFields.length
      ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'data-t' }, h('thead', {}, h('tr', {}, ['Name', 'Section', 'Type', 'Kind', 'Unit', 'Role', ''].map((t) => h('th', { text: t })))), h('tbody', {}, rows)))
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
        ST.select([['number', 'Number'], ['text', 'Text']], 'number', { 'aria-label': 'Type', onchange: (e) => { nfld.kind = e.target.value; } }),
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
