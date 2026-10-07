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

ST.refreshCore = async function refreshCore() {
  const [settings, fields, lineForms, forms, sections] = await Promise.all([ST.api('getSettings'), ST.api('getFields'), ST.api('getLineForms'), ST.api('getForms'), ST.api('getSections')]);
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

ST.card = (title, body, opts = {}) => ST.h('section', { class: `card ${opts.class || ''}` },
  title ? ST.h('header', { class: 'card-h' }, ST.h('h3', { text: title }), opts.actions || null) : null, body);
