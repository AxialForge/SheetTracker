'use strict';
// Reading a sheet file into words. A PDF with a real text layer is read directly (exact, instant); a scanned PDF or a
// photo is cleaned up here (grey, stretched contrast, sensible size) and sent to the OCR engine in the main process.
ST.scan = {
  _lib: null,
  MAX_PAGES: 6,

  async pdfjs() {
    if (!this._lib) {
      const lib = await import('../../../node_modules/pdfjs-dist/build/pdf.min.mjs');
      lib.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', document.baseURI).href;
      this._lib = lib;
    }
    return this._lib;
  },

  // pdf.js text items -> words with positions (PDF points, y down)
  textWords(content, viewport) {
    const words = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = it.transform;
      if (Math.abs(t[1]) > 0.2 * Math.abs(t[0])) continue;            // rotated text is not a form's printing
      const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
      const fh = Math.hypot(t[2], t[3]) * viewport.scale;
      const w = it.width * viewport.scale;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(it.str))) {
        words.push({ text: m[0], conf: 100, x0: x + (w * m.index) / it.str.length, x1: x + (w * (m.index + m[0].length)) / it.str.length, y0: y - fh * 0.8, y1: y + fh * 0.2 });
      }
    }
    return words;
  },
  // A text layer that is really the printed sheet (not a stray page number, not garbage from a scanner's own OCR).
  looksLikeSheet(words) {
    return words.length >= 25 && /(PART|LINE|FORM|TEMPERATURE|BILLET)/i.test(words.map((w) => w.text).join(' '));
  },

  // grey + stretch the 1%..99% tones to full range: a dim phone photo reads as well as a scan
  prepare(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8; d[i] = g; hist[g]++; }
    const total = d.length / 4;
    let lo = 0; let hi = 255; let acc = 0;
    while (lo < 254 && acc + hist[lo] < total * 0.01) acc += hist[lo++];
    acc = 0;
    while (hi > lo + 1 && acc + hist[hi] < total * 0.01) acc += hist[hi--];
    const span = Math.max(1, hi - lo);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / span)));
    for (let i = 0; i < d.length; i += 4) { const g = lut[d[i]]; d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    return canvas;
  },
  canvasOf(w, h) { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; },
  async pngBytes(canvas) {
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the page image'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  },
  rotated(canvas, quarter) {
    const swap = quarter % 2 === 1;
    const c = this.canvasOf(swap ? canvas.height : canvas.width, swap ? canvas.width : canvas.height);
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((quarter * Math.PI) / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  },
  async ocr(canvas) {
    const bytes = await this.pngBytes(this.prepare(canvas));
    return ST.main('ocr:recognize', { bytes });
  },

  // A photo or scan image: scaled to a size OCR likes, read; turned a quarter at a time when nothing sensible is found.
  async imagePages(bytes, name) {
    const ext = (/\.(\w+)$/.exec(name) || [, ''])[1].toLowerCase();
    const type = ext === 'png' ? 'image/png' : ext === 'bmp' ? 'image/bmp' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const bmp = await createImageBitmap(new Blob([bytes], { type }));
    try {
      const longest = Math.max(bmp.width, bmp.height);
      const scale = longest > 3400 ? 3400 / longest : longest < 2000 ? 2400 / longest : 1;
      const base = this.canvasOf(bmp.width * scale, bmp.height * scale);
      base.getContext('2d').drawImage(bmp, 0, 0, base.width, base.height);
      let best = null;
      let bestN = -1;
      for (const q of [0, 1, 3, 2]) {
        const page = await this.ocr(q ? this.rotated(base, q) : base);
        const n = (await ST.api('reviewScan', { file: name, pages: [page] })).fields.length;
        if (n > bestN) { best = page; bestN = n; }
        if (bestN >= 8) break;                                        // upright: no need to try the other turns
      }
      return [{ ...best, via: 'ocr' }];
    } finally { bmp.close(); }
  },

  async pdfPages(bytes, name, onStatus = () => {}) {
    const lib = await this.pdfjs();
    const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
    const doc = await task.promise;
    const pages = [];
    try {
      const n = Math.min(doc.numPages, this.MAX_PAGES);
      for (let p = 1; p <= n; p++) {
        const page = await doc.getPage(p);
        const vp1 = page.getViewport({ scale: 1 });
        const words = this.textWords(await page.getTextContent(), vp1);
        if (this.looksLikeSheet(words)) { pages.push({ words, skew: 0, conf: 100, via: 'text' }); page.cleanup(); continue; }
        onStatus(`Reading page ${p} of ${n}…`);
        const vp = page.getViewport({ scale: Math.max(1.5, Math.min(4, 2600 / vp1.width)) });
        const canvas = this.canvasOf(vp.width, vp.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        page.cleanup();
        const r = await this.ocr(canvas);
        if (r.words.length) pages.push({ ...r, via: 'ocr' });
      }
    } finally { task.destroy(); }
    return pages;
  },

  // fileInfo: { path, name }. Returns { file, pages }.
  async read(fileInfo, onStatus) {
    const bytes = await ST.main('ocr:read', fileInfo.path);
    const pages = /\.pdf$/i.test(fileInfo.name) ? await this.pdfPages(bytes, fileInfo.name, onStatus) : await this.imagePages(bytes, fileInfo.name);
    return { file: fileInfo.name, pages };
  },
};
