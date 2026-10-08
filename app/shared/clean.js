// Turns text as printed or scanned on a setup sheet into a value a field accepts:
// units are dropped ("500 PSI", 14 secs, 3.250"), mixed fractions become decimals (16-1/4"), and
// "X.XX" / "N/A" placeholders count as "not filled in". Used by the OCR import.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./compare'), require('./types'));
  else root.Clean = factory(root.Compare, root.Types);
})(typeof self !== 'undefined' ? self : this, function (C, T) {
  // What a blank form prints where a value goes: X.XX, XX, 0.XXX, 40-XXXX-01, N/A, a lone unit mark.
  const PLACEHOLDER = /^[xX.\s"'\/\-#_:]+$|^(n\/?a|none|tbd|\?)$|^[\dA-Za-z]*[-.]?[xX]{2,}[-.\dxX]*$/i;
  const UNIT_ONLY = /^(t|psi|secs?|lbs?|in|f|°f|(none|x+)\s*psi)\.?$/i;
  const isPlaceholder = (s) => {
    const t = C.norm(s);
    return !t || PLACEHOLDER.test(t) || UNIT_ONLY.test(t);
  };
  const UNIT_TAIL = /\s*(psi|secs?\.?|lbs?|[°o◦*]?\s?f|tons?|t|in|%|a|"|”|″|')$/i;

  // field: { kind, ... }. Returns { blank } | { ok: true, value, altered } | { ok: false, error, raw }.
  function cleanValue(field, raw) {
    const s = C.norm(raw);
    if (isPlaceholder(s) || isPlaceholder(s.replace(UNIT_TAIL, '').trim())) return { blank: true };
    if (!field || field.kind === 'text') return { ok: true, value: s, altered: false };
    let p = T.parse(field, s);
    if (p.ok) return { ok: true, value: p.value, altered: false };
    if (field.kind === 'number' || field.kind === 'duration') {
      let t = s.replace(/["”″]/g, '').trim();
      const cm = /^coil\s*#?\s*(\d)\s*:\s*(.+)$/i.exec(t);
      if (cm && field.key === `coil${cm[1]}_amps`) t = /^off$/i.test(cm[2].trim()) ? '0' : cm[2].replace(/%$/, '').trim();
      if (/^coil\d_amps$/.test(field.key || '') && /^off$/i.test(t)) t = '0';
      for (let i = 0; i < 2; i++) t = t.replace(UNIT_TAIL, '').trim();
      let m;
      if ((m = /^(\d+)-(\d+)\/(\d+)$/.exec(t))) t = String(+m[1] + m[2] / m[3]);
      else if ((m = /^(\d+)\/(\d+)$/.exec(t)) && field.kind === 'number') t = String(m[1] / m[2]);
      if (/\d/.test(t)) p = T.parse(field, t);
      if (p.ok) return { ok: true, value: p.value, altered: true };
    }
    return { ok: false, error: p.error, raw: s };
  }
  const isUnit = (s) => UNIT_ONLY.test(C.norm(s)) || /^(°|o|◦)\s?f$/i.test(C.norm(s));
  return { cleanValue, isPlaceholder, isUnit, PLACEHOLDER };
});
