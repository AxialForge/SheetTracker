// Field types: how a value is validated, stored (canonical text), compared and charted.
// Shared by the main process (service.js) and the renderer (entry form), like compare.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./compare'));
  else root.Types = factory(root.Compare);
})(typeof self !== 'undefined' ? self : this, function (C) {
  const KINDS = [
    { key: 'number', label: 'Number', hint: 'e.g. 2250 or 14.25' },
    { key: 'text', label: 'Text', hint: 'free text' },
    { key: 'choice', label: 'Choice (pick-list)', hint: 'one of a fixed list' },
    { key: 'yesno', label: 'Yes / No', hint: 'Yes, No (OK, NG, Pass, Fail also work)' },
    { key: 'rating', label: 'Rating (1–N)', hint: 'whole number up to the scale, e.g. 4 or 4/5' },
    { key: 'ratio', label: 'Ratio (x of y)', hint: 'e.g. 3/5 or 3 of 5' },
    { key: 'time', label: 'Time of day', hint: 'hh:mm, 24 h (6:05 PM also works)' },
    { key: 'duration', label: 'Duration', hint: 'seconds, or mm:ss, h:mm:ss, 1m30s' },
    { key: 'date', label: 'Date', hint: 'YYYY-MM-DD' },
  ];
  const KEY_SET = new Set(KINDS.map((k) => k.key));
  const NUM = /^[-+]?(\d+\.?\d*|\.\d+)$/;
  const THOUSANDS = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/;
  // Kinds that reduce to a single number: they can be charted and range-checked.
  const NUMERIC = new Set(['number', 'rating', 'duration', 'time', 'ratio']);
  const RANGED = new Set(['number', 'duration', 'time']);
  const YES = new Set(['yes', 'y', 'ok', 'pass', 'true', '1', 'good']);
  const NO = new Set(['no', 'n', 'ng', 'fail', 'false', '0', 'bad']);

  const kindOf = (f) => (f && KEY_SET.has(f.kind) ? f.kind : 'number');
  const pad2 = (n) => String(n).padStart(2, '0');
  const trimNum = (n) => String(Math.round(n * 1e6) / 1e6);
  const ok = (value, num) => ({ ok: true, value, num: num === undefined ? null : num });
  const bad = (error) => ({ ok: false, error });
  const choicesOf = (f) => String(f?.choices || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const scaleOf = (f) => { const n = parseInt(f?.max, 10); return n > 0 ? n : 5; };

  function parseTime(s) {
    const t = C.norm(s).toLowerCase();
    let m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|a|p)?$/.exec(t) || /^(\d{1,2})(\d{2})\s*(am|pm|a|p)?$/.exec(t) || /^(\d{1,2})()\s*(am|pm|a|p)$/.exec(t);
    if (!m) return null;
    let h = parseInt(m[1], 10); const min = m[2] === '' ? 0 : parseInt(m[2], 10);
    const ap = m[3];
    if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap[0] === 'p' ? 12 : 0); }
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  function parseDuration(s) {
    const t = C.norm(s).toLowerCase();
    if (NUM.test(t)) return parseFloat(t) >= 0 ? parseFloat(t) : null;
    let m = /^(\d+):(\d{1,2})$/.exec(t);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
    if (m) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    m = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$/.exec(t);
    if (m && (m[1] || m[2] || m[3])) return (parseFloat(m[1] || 0) * 3600) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0);
    return null;
  }
  function parseDate(s) {
    const t = C.norm(s);
    let y; let mo; let d; let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) { mo = +m[1]; d = +m[2]; y = +m[3]; }
    else return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { iso: `${y}-${pad2(mo)}-${pad2(d)}`, days: Math.floor(dt.getTime() / 86400000) };
  }

  // Validate and canonicalise one value. Blank is always fine (blank = not entered).
  function parse(f, raw) {
    if (C.blank(raw)) return ok('', null);
    const s = C.norm(raw);
    switch (kindOf(f)) {
      case 'number': {
        const t = THOUSANDS.test(s) ? s.replace(/,/g, '') : s;
        return NUM.test(t) ? ok(t, parseFloat(t)) : bad(`“${s}” is not a number`);
      }
      case 'text': return ok(s, null);
      case 'choice': {
        const list = choicesOf(f);
        if (!list.length) return ok(s, null);
        const hit = list.find((c) => c.toLowerCase() === s.toLowerCase());
        return hit ? ok(hit, null) : bad(`“${s}” is not one of: ${list.join(', ')}`);
      }
      case 'yesno': {
        const t = s.toLowerCase();
        if (YES.has(t)) return ok('Yes', 1);
        if (NO.has(t)) return ok('No', 0);
        return bad(`“${s}” is not Yes or No`);
      }
      case 'rating': {
        const scale = scaleOf(f); const lo = f && f.min !== '' && f.min != null && !Number.isNaN(parseInt(f.min, 10)) ? parseInt(f.min, 10) : 1;
        const m = /^(\d+)(?:\s*(?:\/|of)\s*(\d+))?$/i.exec(s);
        if (!m) return bad(`“${s}” is not a rating (whole number ${lo}–${scale})`);
        if (m[2] && parseInt(m[2], 10) !== scale) return bad(`“${s}” is out of ${m[2]}, but this rating is out of ${scale}`);
        const n = parseInt(m[1], 10);
        return n >= lo && n <= scale ? ok(String(n), n) : bad(`“${s}” is outside the rating range ${lo}–${scale}`);
      }
      case 'ratio': {
        const m = /^(\d+(?:\.\d+)?)\s*(?:\/|of)\s*(\d+(?:\.\d+)?)$/i.exec(s);
        if (!m) return bad(`“${s}” is not a ratio like 3/5`);
        const a = parseFloat(m[1]); const b = parseFloat(m[2]);
        return ok(`${trimNum(a)}/${trimNum(b)}`, b === 0 ? null : a / b);
      }
      case 'time': {
        const mins = parseTime(s);
        return mins === null ? bad(`“${s}” is not a time (hh:mm)`) : ok(`${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`, mins);
      }
      case 'duration': {
        const secs = parseDuration(s);
        return secs === null ? bad(`“${s}” is not a duration (seconds, mm:ss or h:mm:ss)`) : ok(trimNum(secs), secs);
      }
      case 'date': {
        const d = parseDate(s);
        return d ? ok(d.iso, d.days) : bad(`“${s}” is not a date (YYYY-MM-DD)`);
      }
      default: return ok(s, null);
    }
  }

  // Tolerant: the canonical form when the value parses, otherwise the value as stored (older data).
  function canon(f, raw) {
    const r = parse(f, raw);
    return r.ok ? r.value : C.norm(raw);
  }
  // Number for charts / ranges; null when the type has no single number or the value does not parse.
  function toNumber(f, raw) {
    if (C.blank(raw)) return null;
    const r = parse(f, raw);
    if (r.ok) return NUMERIC.has(kindOf(f)) ? r.num : null;
    // legacy value in a field whose type changed (e.g. "5/5" stored before the field became a rating)
    const t = C.norm(raw);
    return NUM.test(t) ? parseFloat(t) : null;
  }
  function same(f, a, b) {
    if (C.blank(a) && C.blank(b)) return true;
    const x = canon(f, a); const y = canon(f, b);
    const kind = kindOf(f);
    if (NUMERIC.has(kind)) {
      const nx = toNumber(f, x); const ny = toNumber(f, y);
      if (nx !== null && ny !== null) return Math.abs(nx - ny) < 1e-9;
    }
    return C.same(x, y);
  }
  const changed = (f, prev, cur) => !(C.blank(prev) || C.blank(cur)) && !same(f, prev, cur);
  const drifted = (f, sp, ac) => !(C.blank(sp) || C.blank(ac)) && !same(f, sp, ac);

  // 'low' | 'high' when a number-like value is outside the field's min/max; null otherwise.
  function outOfRange(f, raw) {
    if (!f || !RANGED.has(kindOf(f)) || C.blank(raw)) return null;
    const v = toNumber(f, raw);
    if (v === null) return null;
    const lo = C.blank(f.min) ? null : toNumber(f, f.min);
    const hi = C.blank(f.max) ? null : toNumber(f, f.max);
    if (lo !== null && v < lo) return 'low';
    if (hi !== null && v > hi) return 'high';
    return null;
  }

  const chartable = (kind) => NUMERIC.has(kind);
  // Axis label for a charted value (time of day is charted as minutes since midnight).
  function fmtAxis(kind, n) {
    if (kind === 'time') { const m = Math.round(n); return `${pad2(Math.floor(m / 60) % 24)}:${pad2(((m % 60) + 60) % 60)}`; }
    return String(n);
  }
  const label = (kind) => KINDS.find((k) => k.key === kind)?.label || kind;
  const hint = (kind) => KINDS.find((k) => k.key === kind)?.hint || '';
  // Accept a type by key or by its label (case-insensitive); '' when unknown.
  function kindFrom(text) {
    const t = C.norm(text).toLowerCase();
    if (!t) return '';
    const hit = KINDS.find((k) => k.key === t || k.label.toLowerCase() === t || k.label.toLowerCase().split(' (')[0] === t);
    if (hit) return hit.key;
    const alias = { 'yes/no': 'yesno', 'yes / no': 'yesno', 'y/n': 'yesno', boolean: 'yesno', checkbox: 'yesno', 'pass/fail': 'yesno', 'ok/ng': 'yesno',
      'time of day': 'time', clock: 'time', list: 'choice', dropdown: 'choice', 'pick-list': 'choice', picklist: 'choice', 'select': 'choice',
      numeric: 'number', integer: 'number', decimal: 'number', 'x of y': 'ratio', fraction: 'ratio', scale: 'rating', score: 'rating', stars: 'rating', timer: 'duration', 'elapsed time': 'duration' };
    return alias[t] || '';
  }

  return { KINDS, kindOf, parse, canon, toNumber, same, changed, drifted, outOfRange, chartable, fmtAxis, label, hint, kindFrom, choicesOf, scaleOf, NUMERIC };
});
