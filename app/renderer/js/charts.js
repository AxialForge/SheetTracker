'use strict';
// Dependency-free SVG charts. Colours are resolved from the active theme at draw time so PNG export is faithful.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const S = (tag, attrs = {}, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const SERIES = ['accent', '#60a5fa', '#34d399', '#fbbf24', '#c084fc', '#f472b6', '#94a3b8', '#fb923c'];

  function niceTicks(lo, hi, n = 5) {
    if (lo === hi) { const d = Math.abs(lo) * 0.05 || 1; lo -= d; hi += d; }
    const span = hi - lo; const raw = span / n;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const start = Math.floor(lo / step) * step;
    const ticks = [];
    for (let v = start; v <= hi + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
    return { ticks, lo: ticks[0], hi: ticks[ticks.length - 1] };
  }
  const tsToMs = (ts) => new Date(ts.length === 16 ? `${ts}:00` : ts).getTime();

  function frame(w, h) {
    const svg = S('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', class: 'chart', role: 'img', preserveAspectRatio: 'xMidYMid meet' });
    svg.dataset.w = w; svg.dataset.h = h;
    return svg;
  }
  function empty(svg, w, h, ink, msg) {
    svg.append(S('text', { x: w / 2, y: h / 2, 'text-anchor': 'middle', fill: ink, 'font-size': 13, 'font-family': 'inherit' }, msg));
    return svg;
  }

  // series: [{name, points:[{ts,y}], dashed?, color?}]
  ST.charts = {
    line(series, { unit = '', w = 640, h = 280 } = {}) {
      const ink = ST.cssVar('--muted'); const grid = ST.cssVar('--border'); const accent = ST.cssVar('--accent');
      const svg = frame(w, h);
      const all = series.flatMap((s) => s.points);
      if (!all.length) return empty(svg, w, h, ink, 'No numeric data for this selection');
      const m = { l: 54, r: 14, t: 14, b: 54 };
      const xs = all.map((p) => tsToMs(p.ts)); let x0 = Math.min(...xs); let x1 = Math.max(...xs);
      if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
      const ys = all.map((p) => p.y);
      const t = niceTicks(Math.min(...ys), Math.max(...ys));
      const X = (ms) => m.l + ((ms - x0) / (x1 - x0)) * (w - m.l - m.r);
      const Y = (v) => h - m.b - ((v - t.lo) / (t.hi - t.lo)) * (h - m.t - m.b);
      t.ticks.forEach((v) => {
        svg.append(S('line', { x1: m.l, x2: w - m.r, y1: Y(v), y2: Y(v), stroke: grid, 'stroke-width': 1 }));
        svg.append(S('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end', fill: ink, 'font-size': 11, 'font-family': 'inherit' }, String(v)));
      });
      const nx = 5;
      for (let i = 0; i <= nx; i++) {
        const ms = x0 + ((x1 - x0) * i) / nx; const d = new Date(ms);
        const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        svg.append(S('text', { x: X(ms), y: h - m.b + 18, 'text-anchor': 'middle', fill: ink, 'font-size': 11, 'font-family': 'inherit' }, ST.fmtDate(ts, true).replace(/^\d{4}-/, '')));
      }
      if (unit) svg.append(S('text', { x: 4, y: 12, fill: ink, 'font-size': 11, 'font-family': 'inherit' }, unit));
      series.forEach((s, i) => {
        if (!s.points.length) return;
        const color = s.color || (SERIES[i % SERIES.length] === 'accent' ? accent : SERIES[i % SERIES.length]);
        const pts = s.points.slice().sort((a, b) => tsToMs(a.ts) - tsToMs(b.ts));
        const d = pts.map((p, j) => `${j ? 'L' : 'M'}${X(tsToMs(p.ts)).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
        svg.append(S('path', { d: s.step ? stepPath(pts, X, Y) : d, fill: 'none', stroke: color, 'stroke-width': s.dashed ? 1.5 : 2, 'stroke-dasharray': s.dashed ? '5 4' : '', 'stroke-linejoin': 'round' }));
        if (!s.dashed) {
          pts.forEach((p) => {
            const c = S('circle', { cx: X(tsToMs(p.ts)), cy: Y(p.y), r: 3, fill: color });
            c.append(S('title', {}, `${s.name}: ${p.y}${unit ? ' ' + unit : ''}  ·  ${ST.fmtDate(p.ts)}`));
            svg.append(c);
          });
        }
      });
      // legend
      let lx = m.l;
      series.forEach((s, i) => {
        const color = s.color || (SERIES[i % SERIES.length] === 'accent' ? accent : SERIES[i % SERIES.length]);
        svg.append(S('line', { x1: lx, x2: lx + 16, y1: h - 12, y2: h - 12, stroke: color, 'stroke-width': 2, 'stroke-dasharray': s.dashed ? '4 3' : '' }));
        const label = S('text', { x: lx + 21, y: h - 8, fill: ink, 'font-size': 11, 'font-family': 'inherit' }, s.name);
        svg.append(label);
        lx += 30 + s.name.length * 6.2;
      });
      return svg;
    },

    bar(items, { w = 420, h = 280 } = {}) {
      const ink = ST.cssVar('--ink'); const muted = ST.cssVar('--muted'); const accent = ST.cssVar('--accent');
      const svg = frame(w, h);
      if (!items.length) return empty(svg, w, h, muted, 'No changes in the last 30 days');
      const max = Math.max(...items.map((i) => i.value));
      const rowH = Math.min(30, (h - 10) / items.length); const lw = 150;
      items.forEach((it, i) => {
        const y = 6 + i * rowH; const bw = Math.max(2, ((w - lw - 40) * it.value) / max);
        svg.append(S('text', { x: lw - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', fill: ink, 'font-size': 12, 'font-family': 'inherit' }, it.label.length > 22 ? it.label.slice(0, 21) + '…' : it.label));
        const r = S('rect', { x: lw, y: y + 3, width: bw, height: rowH - 8, rx: 3, fill: accent });
        r.append(S('title', {}, `${it.label}: ${it.value}`));
        svg.append(r);
        svg.append(S('text', { x: lw + bw + 6, y: y + rowH / 2 + 4, fill: muted, 'font-size': 12, 'font-family': 'inherit' }, String(it.value)));
      });
      return svg;
    },

    // Serialise an SVG node to a PNG data URL (2x), on the panel background.
    toPng(svg) {
      return new Promise((resolve, reject) => {
        const w = Number(svg.dataset.w); const h = Number(svg.dataset.h);
        const clone = svg.cloneNode(true);
        clone.setAttribute('xmlns', NS); clone.setAttribute('width', w); clone.setAttribute('height', h);
        const xml = new XMLSerializer().serializeToString(clone);
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2;
          const g = c.getContext('2d'); g.fillStyle = ST.cssVar('--panel'); g.fillRect(0, 0, c.width, c.height);
          g.scale(2, 2); g.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('Chart render failed'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      });
    },
  };

  function stepPath(pts, X, Y) {
    return pts.map((p, j) => (j ? `L${X(tsToMs(p.ts)).toFixed(1)},${Y(pts[j - 1].y).toFixed(1)} L${X(tsToMs(p.ts)).toFixed(1)},${Y(p.y).toFixed(1)}` : `M${X(tsToMs(p.ts)).toFixed(1)},${Y(p.y).toFixed(1)}`)).join(' ');
  }
})();
