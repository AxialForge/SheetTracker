// Shared by the main process (service.js) and the renderer (entry form).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Compare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NUM = /^[-+]?(\d+\.?\d*|\.\d+)$/;

  function blank(v) {
    return v === null || v === undefined || String(v).trim() === '';
  }

  // Text as stored: trimmed, runs of whitespace collapsed to one space.
  function norm(v) {
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  }

  // Numeric-aware equality: 2300 == 2300.0; text compares normalized, case-insensitive.
  function same(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (NUM.test(x) && NUM.test(y)) return parseFloat(x) === parseFloat(y);
    return x.toLowerCase() === y.toLowerCase();
  }

  // Changed = both known and different. A first-ever value is a baseline, not a change.
  function changed(prev, cur) {
    if (blank(prev) || blank(cur)) return false;
    return !same(prev, cur);
  }

  // Drift = actual differs from the printed sheet setpoint.
  function drifted(setpoint, actual) {
    if (blank(setpoint) || blank(actual)) return false;
    return !same(setpoint, actual);
  }

  return { blank, norm, same, changed, drifted };
});
