'use strict';
// Local OCR (tesseract.js, English). Runs in a worker thread so the window stays responsive; nothing leaves the PC.
// The traineddata ships inside the app (@tesseract.js-data/eng) so it works offline.
const path = require('path');

// Inside a packaged app the worker script, the wasm and the language data are unpacked next to app.asar.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function resolvePaths() {
  const dataDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  return {
    langPath: unpacked(path.join(dataDir, '4.0.0_best_int')),
    workerPath: unpacked(path.join(path.dirname(require.resolve('tesseract.js/package.json')), 'src', 'worker-script', 'node', 'index.js')),
    corePath: unpacked(path.dirname(require.resolve('tesseract.js-core/package.json'))),
  };
}

// tesseract result -> flat words + the page's tilt (median baseline slope, dy/dx)
function toWords(data) {
  const words = [];
  const slopes = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const bl = l.baseline;
        if (bl && bl.x1 - bl.x0 > 250 && l.words && l.words.length >= 3) slopes.push((bl.y1 - bl.y0) / (bl.x1 - bl.x0));
        for (const w of l.words || []) {
          if (!w.text || !w.text.trim()) continue;
          words.push({ text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
        }
      }
    }
  }
  slopes.sort((a, b) => a - b);
  const skew = slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0;
  return { words, skew: Math.abs(skew) < 0.003 ? 0 : skew, conf: Math.round(data.confidence || 0), text: data.text || '' };
}

// A small pool: workers are started on demand up to `max` (bulk imports read several sheets at once) and reused.
class OcrEngine {
  constructor(opts = {}) {
    this.opts = opts;
    this.max = Math.max(1, opts.max || 1);
    this.workers = [];
    this.idle = [];
    this.waiting = [];
    this.starting = 0;
  }

  async _make() {
    const { createWorker } = require('tesseract.js');
    const paths = resolvePaths();
    let w;
    w = await createWorker('eng', 1, {
      langPath: this.opts.langPath || paths.langPath, gzip: true, cacheMethod: 'none',
      workerPath: this.opts.workerPath || paths.workerPath, corePath: this.opts.corePath || paths.corePath,
      // the failing call rejects on its own; without this tesseract.js also throws in the main process, which would close the app
      errorHandler: () => {},
      logger: (m) => { if (w && w.__progress && m.status === 'recognizing text') w.__progress(m.progress); },
    });
    // sparse text: the sheet is a form, not prose. Finds every label and value (the default page layout analysis
    // drops boxed footers) and the extractor rebuilds rows from word positions anyway.
    await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
    return w;
  }

  async _acquire() {
    if (this.idle.length) return this.idle.pop();
    if (this.workers.length + this.starting < this.max) {
      this.starting++;
      try { const w = await this._make(); this.workers.push(w); return w; } finally { this.starting--; }
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  _release(w) {
    const next = this.waiting.shift();
    if (next) next(w); else this.idle.push(w);
  }

  // image: a Buffer (PNG/JPEG/BMP) or a file path. Up to `max` run at once; the rest wait.
  async recognize(image, { onProgress } = {}) {
    const w = await this._acquire();
    w.__progress = onProgress || null;
    try {
      const r = await w.recognize(image, {}, { blocks: true, text: true });
      return toWords(r.data);
    } catch (e) {
      // a worker that failed is not trusted again
      this.workers = this.workers.filter((x) => x !== w);
      w.terminate().catch(() => {});
      const next = this.waiting.shift();
      if (next) this._acquire().then(next);
      throw e instanceof Error && e.message ? e : new Error(String((e && e.message) || e || 'The image could not be read'));
    } finally {
      w.__progress = null;
      if (this.workers.includes(w)) this._release(w);
    }
  }

  async terminate() {
    const all = this.workers;
    this.workers = []; this.idle = []; this.waiting = [];
    await Promise.all(all.map((w) => w.terminate().catch(() => {})));
  }
}

module.exports = { OcrEngine, toWords, resolvePaths };
