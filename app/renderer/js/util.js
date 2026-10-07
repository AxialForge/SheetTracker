'use strict';
// Shared renderer helpers. Everything hangs off the ST namespace.
window.ST = window.ST || { tabs: {}, state: {} };

ST.h = function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') { if (v) el.setAttribute(k, ''); el[k] = !!v; }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

ST.api = (method, ...args) => window.api.call(method, ...args);
ST.main = (name, ...args) => window.api.main(name, ...args);

ST.toast = function toast(msg, kind = 'ok') {
  const t = ST.h('div', { class: `toast ${kind}`, text: msg });
  document.getElementById('toasts').append(t);
  setTimeout(() => t.classList.add('out'), kind === 'err' ? 6000 : 2800);
  setTimeout(() => t.remove(), kind === 'err' ? 6600 : 3300);
};
ST.fail = (e) => { console.error(e); ST.toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); };

const pad = (n) => String(n).padStart(2, '0');
ST.nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
ST.fmtDate = function fmtDate(ts, dateOnly) {
  if (!ts) return '';
  const [d, t = ''] = ts.split('T');
  const [Y, M, D] = d.split('-');
  const [hh, mm] = t.split(':').map(Number);
  const fmt = ST.state.settings?.date_format || 'iso';
  const time = (twelve) => (t ? (twelve ? ` ${((hh + 11) % 12) + 1}:${pad(mm)} ${hh >= 12 ? 'PM' : 'AM'}` : ` ${pad(hh)}:${pad(mm)}`) : '');
  if (fmt === 'us') return `${M}/${D}/${Y}${dateOnly ? '' : time(true)}`;
  if (fmt === 'eu') return `${D}/${M}/${Y}${dateOnly ? '' : time(false)}`;
  return `${Y}-${M}-${D}${dateOnly ? '' : time(false)}`;
};

ST.fieldLabel = (key) => ST.state.fields.find((f) => f.key === key)?.label || key;
ST.opt = (name) => ST.state.settings[`opt_${name}`] === '1';

ST.applyTheme = (name) => { document.documentElement.dataset.theme = name || 'crimson'; };
ST.cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// What this job calls its two identifiers (Line + Part No. by default; a profile can rename them).
ST.pl = (w) => (/(s|x|z|ch|sh)$/i.test(w) ? `${w}es` : `${w}s`);
ST.setLabels = (settings) => {
  const line = (settings.label_line || 'Line').trim() || 'Line';
  const part = (settings.label_part || 'Part No.').trim() || 'Part No.';
  const partShort = part.replace(/\s*(no\.?|number|#)$/i, '').trim() || part;
  ST.L = { line, lines: ST.pl(line), part, partShort, parts: ST.pl(partShort) };
};
ST.setLabels({});
ST.lineName = (n) => `${ST.L.line} ${n}`;

ST.refreshCore = async function refreshCore() {
  const [settings, fields, lineForms, forms, sections, prof, update] = await Promise.all([ST.api('getSettings'), ST.api('getFields'), ST.api('getLineForms'), ST.api('getForms'), ST.api('getSections'), ST.main('profile:list'), ST.main('update:state')]);
  ST.setLabels(settings);
  ST.state.profiles = prof.profiles;
  ST.state.profileId = prof.active;
  ST.state.update = update;
  ST.state.settings = settings;
  ST.state.fields = fields;
  ST.state.lineForms = lineForms;
  ST.state.forms = forms;
  ST.state.sections = sections;
  ST.applyTheme(settings.theme);
};

ST.select = function select(options, value, attrs = {}) {
  const s = ST.h('select', attrs, options.map((o) => {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    return ST.h('option', { value: v, text: label, selected: String(v) === String(value) });
  }));
  s.value = value ?? '';
  return s;
};

// A small text prompt (window.prompt is not available in Electron). Resolves to the trimmed text, or null if cancelled.
ST.ask = function ask({ title, message = '', label, value = '', ok = 'OK', required = true }) {
  return new Promise((resolve) => {
    const input = ST.h('input', { type: 'text', value, 'aria-label': label, autocomplete: 'off' });
    const done = (v) => { overlay.remove(); resolve(v); };
    const submit = () => {
      const v = input.value.trim();
      if (required && !v) { input.classList.add('bad'); input.focus(); return; }
      done(v);
    };
    const overlay = ST.h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === overlay) done(null); },
      onkeydown: (e) => { if (e.key === 'Escape') done(null); else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); submit(); } } },
    ST.h('div', { class: 'modal card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      ST.h('h3', { text: title }),
      message ? ST.h('p', { class: 'muted', text: message }) : null,
      ST.h('label', { class: 'fld' }, ST.h('span', { text: label }), input),
      ST.h('div', { class: 'toolbar end' },
        ST.h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => done(null) }),
        ST.h('button', { class: 'btn primary', type: 'button', text: ok, onclick: submit }))));
    document.body.append(overlay);
    input.focus(); input.select();
  });
};

// A dialog with arbitrary content. buttons: [{ text, primary, value, disabled }]. Resolves to the clicked button's value (null on Esc / backdrop).
ST.modal = function modal({ title, body, buttons, wide }) {
  return new Promise((resolve) => {
    const done = (v) => { overlay.remove(); resolve(v); };
    const overlay = ST.h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === overlay) done(null); }, onkeydown: (e) => { if (e.key === 'Escape') done(null); } },
      ST.h('div', { class: `modal card${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        ST.h('h3', { text: title }), ST.h('div', { class: 'modal-body' }, typeof body === 'function' ? body(done) : body),
        ST.h('div', { class: 'toolbar end' }, buttons.map((b) => ST.h('button', { class: `btn${b.primary ? ' primary' : ' ghost'}`, type: 'button', text: b.text, disabled: b.disabled, onclick: () => done(b.value) })))));
    document.body.append(overlay);
    overlay.querySelector('.btn.primary')?.focus();
  });
};

// The extra inputs a new field needs once its type is chosen: a rating's scale, a choice's list, a number's limits.
// el: the container to place in the form;  set(kind): redraw for a type;  values(): { choices, min, max } to pass to addField.
ST.kindExtras = function kindExtras(initialKind = 'number') {
  const v = { choices: '', min: '', max: '' };
  const el = ST.h('div', { class: 'toolbar tight kind-extras' });
  const box = (label, key, placeholder, title, cls = 'short') => ST.h('label', { class: 'inl' }, `${label} `,
    ST.h('input', { type: 'text', class: cls, value: v[key], placeholder, title, 'aria-label': label, oninput: (e) => { v[key] = e.target.value; } }));
  const set = (kind) => {
    v.choices = ''; v.min = ''; v.max = '';
    if (kind === 'rating') { v.min = '1'; v.max = '5'; }
    el.replaceChildren();
    if (kind === 'rating') el.append(box('Rating from', 'min', '1', 'The lowest rating, usually 1 (or 0)'), box('to', 'max', '5', 'The highest rating: 5 means 1–5, 10 means 1–10'), ST.h('span', { class: 'muted', text: 'e.g. 1 to 5 shows a 1–5 dropdown; “4/5” is read as 4' }));
    else if (kind === 'choice') el.append(box('Allowed values', 'choices', 'Standard; Heavy; Light', 'Separate with semicolons', 'wide'));
    else if (kind === 'text') el.append(box('Known values', 'choices', 'optional: A; B; C', 'Offered as suggestions, separate with semicolons', 'wide'));
    else if (kind === 'number' || kind === 'duration' || kind === 'time') el.append(box('Min', 'min', 'optional', 'Values below this are flagged, not blocked'), box('Max', 'max', 'optional', 'Values above this are flagged, not blocked'));
  };
  set(initialKind);
  return { el, set, values: () => ({ ...v }) };
};

ST.card = (title, body, opts = {}) => ST.h('section', { class: `card ${opts.class || ''}` },
  title ? ST.h('header', { class: 'card-h' }, ST.h('h3', { text: title }), opts.actions || null) : null, body);
