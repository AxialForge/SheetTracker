'use strict';
// Scan screens: one sheet into the entry form, or a folder of sheets into the database. Everything read is shown for
// review (low-confidence and unreadable values are marked) before anything is saved.
(function () {
  const { h } = ST;
  const S = ST.scan;
  const FIELD = (key) => ST.state.fields.find((f) => f.key === key);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

  // a modal whose content can be rebuilt and whose buttons can change
  S.dialog = function dialog(title, { wide } = {}) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const body = h('div', { class: 'modal-body' });
    const foot = h('div', { class: 'toolbar end' });
    const done = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'modal-back', onkeydown: (e) => { if (e.key === 'Escape') done(null); } },
      h('div', { class: `modal card${wide ? ' wide scan-modal' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h3', { text: title }), body, foot));
    document.body.append(overlay);
    return {
      promise, close: done,
      set(content, buttons = []) {
        body.replaceChildren(...[].concat(content).filter(Boolean));
        foot.replaceChildren(...buttons.map((b) => h('button', { class: `btn${b.primary ? ' primary' : ' ghost'}`, type: 'button', text: b.text, disabled: b.disabled, onclick: () => (b.onclick ? b.onclick() : done(b.value)) })));
        foot.querySelector('.btn.primary')?.focus();
      },
    };
  };

  S.busy = function busy(title, onCancel) {
    const text = h('p', { text: 'Starting…' });
    const bar = h('progress', { max: 100, value: 0, class: 'scan-bar' });
    const d = S.dialog(title);
    let cancelled = false;
    const show = () => d.set([text, bar], onCancel ? [{ text: 'Stop', onclick: () => { cancelled = true; text.textContent = 'Stopping…'; onCancel(); } }] : []);
    show();
    return { text: (t) => { text.textContent = t; }, bar: (f) => { bar.value = Math.round(f * 100); }, close: () => d.close(null), get cancelled() { return cancelled; } };
  };

  // Recompute a row after its value was edited.
  function recheck(f) {
    const def = FIELD(f.key);
    const r = Clean.cleanValue(def, f.value);
    if (r.blank) { f.status = 'blank'; f.include = false; return; }
    if (!r.ok) { f.status = 'bad'; f.error = r.error; f.include = false; return; }
    f.value = r.value; f.status = 'ok'; f.note = ''; f.error = ''; f.edited = true;
  }
  const counts = (item) => ({
    ok: item.fields.filter((f) => f.status === 'ok').length,
    check: item.fields.filter((f) => f.status === 'check').length,
    bad: item.fields.filter((f) => f.status === 'bad').length,
  });
  const chip = (n, text, cls) => h('span', { class: n ? cls || 'on' : '', text: `${text}: ${n}` });

  // The review of one sheet. mode 'entry': ends in "Fill the entry form". mode 'bulk': edits the item in place.
  S.review = async function review(item, { mode, scan }) {
    const d = S.dialog(`Review: ${item.file || 'sheet'}`, { wide: true });
    const lines = ST.state.lineForms.map((l) => String(l.line));
    const state = { as: 'setpoint', busy: false };
    const isNum = (v) => v !== '' && v != null;
    const order = (arr) => arr.slice().sort((a, b) => ((a.status === 'bad' ? 0 : a.status === 'check' ? 1 : 2) - (b.status === 'bad' ? 0 : b.status === 'check' ? 1 : 2)));
    item.fields.forEach((f) => { if (f.include === undefined) f.include = f.status !== 'bad'; });
    item.fields = order(item.fields);

    async function refreshPart() {
      if (item.line && item.part) {
        const [info, latest] = await Promise.all([ST.api('checkPart', Number(item.line), item.part), ST.api('latestValues', Number(item.line), item.part)]);
        item.partInfo = { exists: info.exists, canonical: info.canonical, similar: info.similar.map((s) => s.part_no), otherLines: info.otherLines };
        item.previous = {};
        for (const [k, v] of Object.entries(latest)) if (isNum(v.setpoint)) item.previous[k] = v.setpoint;
      } else { item.partInfo = null; item.previous = {}; }
    }
    async function rescan(extra) {
      if (!scan) return;
      state.busy = true; draw();
      try {
        const fresh = await ST.api('reviewScan', { file: item.file, pages: scan.pages }, { line: item.line || undefined, ...extra });
        fresh.fields.forEach((f) => { f.include = f.status !== 'bad'; });
        Object.assign(item, fresh, { id: item.id, include: item.include, folderLine: item.folderLine, rel: item.rel, line: extra.line || fresh.line || item.line });
        item.fields = order(item.fields);
      } catch (e) { ST.fail(e); }
      state.busy = false; draw();
    }

    function banner() {
      const p = item.partInfo;
      if (!item.line || !item.part) return null;
      if (!p) return null;
      if (p.exists) return h('div', { class: 'setup-note ok card' }, h('span', { text: `${ST.L.partShort} “${p.canonical}” is already on ${ST.lineName(item.line)}. ` + (Object.keys(item.previous || {}).length ? 'The “Was” column shows its stored setpoints.' : '') }));
      return h('div', { class: 'setup-note warn card' }, h('span', {}, h('b', { text: `New ${ST.L.partShort.toLowerCase()}. ` }), `No history for “${item.part}” on ${ST.lineName(item.line)}.`,
        p.similar.length ? ` Looks like ${p.similar.map((s) => `“${s}”`).join(', ')}: check the part number was read correctly.` : ''),
      p.similar.length ? h('div', { class: 'toolbar' }, p.similar.map((s) => h('button', { class: 'btn sm', type: 'button', text: `Use ${s}`, onclick: async () => { item.part = s; await refreshPart(); draw(); } }))) : null);
    }

    function draw() {
      const c = counts(item);
      const lineSel = ST.select([['', '—'], ...lines.map((l) => [l, ST.lineName(l)])], item.line ? String(item.line) : '');
      lineSel.onchange = async () => { item.line = lineSel.value ? Number(lineSel.value) : null; await refreshPart(); if (!item.form && item.line) await rescan({ line: item.line }); else draw(); };
      const partIn = h('input', { type: 'text', value: item.part || '', autocomplete: 'off', 'aria-label': ST.L.part });
      partIn.onchange = async () => { item.part = partIn.value.trim(); await refreshPart(); draw(); };
      const formSel = ST.select([['', 'Choose…'], ...ST.state.forms.map((f) => [String(f.form_no), `Form ${f.form_no}${f.name ? ` · ${f.name}` : ''}`])], item.form ? String(item.form) : '');
      formSel.onchange = () => { if (formSel.value) rescan({ form: Number(formSel.value), line: item.line || undefined }); };
      const meta = (label, ctrl) => h('label', { class: 'fld' }, h('span', { text: label }), ctrl);
      const text = (key) => h('input', { type: 'text', value: item[key] || '', oninput: (e) => { item[key] = e.target.value; } });
      const head = h('div', { class: 'entry-head scan-head' }, meta(ST.L.line, lineSel), meta(ST.L.part, partIn), meta('Form', formSel), meta('Sheet rev', text('rev')), meta('Revised', text('revised')), meta('HMI file #', text('hmi')));

      const rows = item.fields.map((f) => {
        const def = FIELD(f.key) || {};
        const was = (item.previous || {})[f.key];
        const input = h('input', { type: 'text', class: `cell ${f.status === 'bad' ? 'bad' : f.status === 'check' ? 'changed' : ''}`, value: f.status === 'bad' ? f.raw : f.value, 'aria-label': f.label, autocomplete: 'off' });
        const status = h('span', { class: `st-${f.status}`, text: f.status === 'bad' ? 'Unreadable' : f.status === 'check' ? 'Check' : f.status === 'blank' ? 'Empty' : f.edited ? 'Edited' : 'OK' });
        const note = h('span', { class: 'muted', text: f.status === 'bad' ? f.error : f.note || (f.raw && f.raw !== f.value && f.status !== 'blank' ? `read as “${f.raw}”` : '') });
        const box = h('input', { type: 'checkbox', checked: !!f.include, disabled: f.status === 'bad' || f.status === 'blank', 'aria-label': `Use ${f.label}`, onchange: (e) => { f.include = e.target.checked; } });
        input.oninput = () => { f.value = input.value; f.raw = input.value; recheck(f); box.checked = !!f.include; box.disabled = f.status === 'bad' || f.status === 'blank'; input.className = `cell ${f.status === 'bad' ? 'bad' : ''}`; status.className = `st-${f.status}`; status.textContent = f.status === 'bad' ? 'Unreadable' : f.status === 'blank' ? 'Empty' : 'Edited'; note.textContent = f.status === 'bad' ? f.error : ''; };
        const diff = was !== undefined && f.status !== 'bad' && !Types.same(def, was, f.value);
        return h('tr', { class: `scan-row ${f.status}` }, h('td', {}, box), h('td', { class: 'lbl' }, f.label, f.unit ? h('small', { class: 'muted', text: ` ${f.unit}` }) : null), h('td', {}, input),
          h('td', { class: `mono ${diff ? 'diff' : 'muted'}`, text: was !== undefined ? was : '' }), h('td', {}, status), h('td', {}, note));
      });
      const table = item.fields.length ? h('div', { class: 'scan-scroll' }, h('table', { class: 'grid-t scan-tbl' },
        h('thead', {}, h('tr', {}, h('th'), h('th', { text: 'Setting' }), h('th', { text: 'Read from the sheet' }), h('th', { text: item.partInfo?.exists ? 'Was' : '' }), h('th', { text: 'Status' }), h('th'))),
        h('tbody', {}, rows))) : null;

      const missing = item.missing && item.missing.length ? h('details', { class: 'muted' }, h('summary', { text: `${plural(item.missing.length, 'setting')} not found on the sheet` }), h('p', { text: item.missing.map((m) => m.label).join(' · ') })) : null;
      const probs = item.problems && item.problems.length ? h('ul', { class: 'plan-list plan-err' }, item.problems.map((t) => h('li', { text: t }))) : null;
      const warns = item.warnings && item.warnings.length ? h('ul', { class: 'plan-list plan-warn' }, [...new Set(item.warnings)].map((t) => h('li', { text: t }))) : null;
      const as = mode === 'entry' ? h('div', { class: 'toolbar' }, h('span', { text: 'The values on this sheet are:' }),
        ['setpoint', 'actual'].map((v) => h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'scan-as', checked: state.as === v, onchange: () => { state.as = v; } }), v === 'setpoint' ? ' Setpoints (printed)' : ' Actuals (written in)'))) : null;
      const summary = h('div', { class: 'plan-sum' }, chip(c.ok, 'Read'), chip(c.check, 'To check', 'warn'), chip(c.bad, 'Unreadable', 'warn'), chip(item.missing ? item.missing.length : 0, 'Not on sheet', ''),
        item.conf ? h('span', { class: 'on', text: `OCR confidence ${item.conf}%` }) : null, item.formSource ? h('span', { text: item.formSource === 'sheet' ? 'Form read from the sheet' : item.formSource === 'line' ? `Form from the ${ST.L.line.toLowerCase()}` : 'Form chosen' }) : null);
      const canUse = item.line && item.part && item.form && item.fields.some((f) => f.include && f.status !== 'bad');
      d.set(h('div', { class: 'col tight' }, head, banner(), probs, warns, summary, as, state.busy ? h('p', { class: 'muted', text: 'Reading again…' }) : table, missing),
        [{ text: 'Cancel', value: null },
          mode === 'entry' ? { text: 'Fill the entry form', primary: true, disabled: !canUse || state.busy, onclick: () => d.close({ item, as: state.as }) }
            : { text: 'Done', primary: true, onclick: () => d.close({ item }) }]);
    }
    await refreshPart();
    draw();
    return d.promise;
  };

  // Read the chosen files one after another (or a few at once when the PC has cores to spare).
  async function readAll(files, { onItem } = {}) {
    const info = await ST.main('ocr:info');
    const lanes = Math.max(1, Math.min(info.workers, files.length));
    const scans = new Map();
    const items = new Array(files.length);
    let next = 0; let doneN = 0;
    const started = Date.now();
    let stop = false;
    const dlg = S.busy(`Reading ${plural(files.length, 'sheet')}`, () => { stop = true; });
    const lane = async () => {
      for (;;) {
        const i = next++;
        if (i >= files.length || stop) return;
        const f = files[i];
        dlg.text(`${doneN} of ${files.length} read · ${f.name}`);
        let item;
        try {
          const scan = await S.read(f, (t) => dlg.text(`${doneN} of ${files.length} · ${f.name} · ${t}`));
          item = await ST.api('reviewScan', scan, { line: f.folderLine || undefined });
          scans.set(i, scan);
        } catch (e) {
          item = { file: f.name, header: {}, fields: [], missing: [], warnings: [], problems: [String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')], line: f.folderLine || null, part: '', form: null };
        }
        Object.assign(item, { id: i, rel: f.rel || f.name, folderLine: f.folderLine || null, file: f.name });
        if (f.folderLine && item.header.line && Number(item.header.line) !== f.folderLine) item.warnings.push(`The sheet prints ${ST.lineName(item.header.line)}, but it is in the folder “${f.folder}”: ${ST.lineName(f.folderLine)} was used.`);
        item.fields.forEach((x) => { x.include = x.status !== 'bad'; });
        items[i] = item;
        doneN++;
        dlg.bar(doneN / files.length);
        const per = (Date.now() - started) / doneN;
        dlg.text(`${doneN} of ${files.length} read · about ${Math.max(1, Math.round((per * (files.length - doneN)) / 60000))} min left`);
        if (onItem) onItem(item);
      }
    };
    try { await Promise.all(Array.from({ length: lanes }, lane)); } finally { dlg.close(); await ST.main('ocr:release').catch(() => {}); }
    return { items: items.filter(Boolean), scans, stopped: stop };
  }

  // ---- one sheet -> the entry form
  S.single = async function single() {
    const pick = await ST.main('ocr:pickFiles');
    if (!pick || !pick.files.length) return null;
    const { items, scans } = await readAll(pick.files.slice(0, 1));
    const item = items[0];
    if (!item) return null;
    return S.review(item, { mode: 'entry', scan: scans.get(0) });
  };

  // ---- many sheets -> entries
  const ready = (it) => !!(it.line && it.part && it.form && it.fields.some((f) => f.status !== 'bad'));
  const clean = (it) => ready(it) && !(it.problems && it.problems.length) && counts(it).check === 0 && counts(it).bad === 0;

  S.bulk = async function bulk(kind) {
    const pick = await ST.main(kind === 'files' ? 'ocr:pickFiles' : 'ocr:pickFolder');
    if (!pick) return;
    if (!pick.files.length) { ST.toast('No PDF or image files found there.', 'err'); return; }
    if (pick.truncated) ST.toast('Only the first 5000 files were used.', 'err');
    const { items, scans, stopped } = await readAll(pick.files);
    if (!items.length) return;
    items.forEach((it) => { it.include = clean(it); });
    await S.bulkResults(items, scans, stopped);
  };

  S.bulkResults = async function bulkResults(items, scans, stopped) {
    const d = S.dialog(`Scanned sheets${stopped ? ' (stopped early)' : ''}`, { wide: true });
    const lines = ST.state.lineForms.map((l) => String(l.line));
    const f = { onlyLook: false, dateBy: 'now' };
    function draw() {
      const nReady = items.filter(ready).length;
      const nClean = items.filter(clean).length;
      const nSel = items.filter((i) => i.include).length;
      const shown = items.filter((i) => !f.onlyLook || !clean(i));
      const rows = shown.map((it) => {
        const c = counts(it);
        const box = h('input', { type: 'checkbox', checked: !!it.include, disabled: !ready(it), 'aria-label': `Import ${it.file}`, onchange: (e) => { it.include = e.target.checked; draw(); } });
        const lineSel = ST.select([['', '—'], ...lines.map((l) => [l, ST.lineName(l)])], it.line ? String(it.line) : '');
        lineSel.onchange = async () => { const sc = scans.get(it.id); it.line = lineSel.value ? Number(lineSel.value) : null; if (sc) { const fresh = await ST.api('reviewScan', sc, { line: it.line || undefined }); fresh.fields.forEach((x) => { x.include = x.status !== 'bad'; }); Object.assign(it, fresh, { id: it.id, include: it.include, folderLine: it.folderLine, rel: it.rel, file: it.file }); it.include = clean(it); } draw(); };
        const partIn = h('input', { type: 'text', class: 'cell', value: it.part || '', 'aria-label': `${ST.L.part} of ${it.file}`, autocomplete: 'off', onchange: (e) => { it.part = e.target.value.trim(); it.include = clean(it); draw(); } });
        const status = it.problems && it.problems.length ? it.problems[0] : c.bad || c.check ? `${c.check ? `${c.check} to check` : ''}${c.check && c.bad ? ', ' : ''}${c.bad ? `${c.bad} unreadable` : ''}` : (it.warnings || []).length ? it.warnings[0] : 'OK';
        return h('tr', { class: `scan-row ${clean(it) ? '' : ready(it) ? 'check' : 'bad'}` }, h('td', {}, box), h('td', { title: it.rel, text: it.file }), h('td', {}, lineSel), h('td', {}, partIn), h('td', { text: it.rev || '' }),
          h('td', { class: 'mono', text: String(c.ok + c.check) }), h('td', { class: it.problems && it.problems.length ? 'st-bad' : c.bad || c.check ? 'st-check' : 'st-ok', text: status }),
          h('td', {}, h('button', { class: 'btn sm', type: 'button', text: 'Review', onclick: async () => { const r = await S.review(it, { mode: 'bulk', scan: scans.get(it.id) }); if (r) { it.include = ready(it) && it.include !== false ? true : false; } draw(); } })));
      });
      const bar = h('div', { class: 'toolbar' },
        h('button', { class: 'btn sm', type: 'button', text: 'Select clean sheets', onclick: () => { items.forEach((i) => { i.include = clean(i); }); draw(); } }),
        h('button', { class: 'btn sm', type: 'button', text: 'Select all that can be imported', onclick: () => { items.forEach((i) => { i.include = ready(i); }); draw(); } }),
        h('button', { class: 'btn sm', type: 'button', text: 'Select none', onclick: () => { items.forEach((i) => { i.include = false; }); draw(); } }),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: f.onlyLook, onchange: (e) => { f.onlyLook = e.target.checked; draw(); } }), ' Only sheets that need a look'),
        h('span', { class: 'grow' }),
        h('label', { class: 'inl' }, 'Date entries by ', ST.select([['now', 'import time'], ['revised', 'sheet\'s revised date']], f.dateBy, { onchange: (e) => { f.dateBy = e.target.value; } })));
      d.set(h('div', { class: 'col tight' },
        h('div', { class: 'plan-sum' }, chip(items.length, 'Sheets read'), chip(nClean, 'Clean'), chip(nReady - nClean, 'To check', 'warn'), chip(items.length - nReady, 'Cannot import', 'warn'), chip(nSel, 'Selected')),
        h('p', { class: 'muted', text: 'Nothing is saved yet. Clean sheets have every value read with confidence. Open “Review” on any sheet to correct a value or the part number. Entries are setpoints only, and each keeps its file name and anything doubtful in its notes.' }),
        bar,
        h('div', { class: 'scan-scroll tall' }, h('table', { class: 'grid-t scan-tbl' },
          h('thead', {}, h('tr', {}, h('th'), h('th', { text: 'File' }), h('th', { text: ST.L.line }), h('th', { text: ST.L.part }), h('th', { text: 'Rev' }), h('th', { text: 'Values' }), h('th', { text: 'Status' }), h('th'))),
          h('tbody', {}, rows)))),
      [{ text: 'Close', value: null }, { text: `Preview import of ${plural(nSel, 'sheet')}…`, primary: true, disabled: !nSel, onclick: () => { d.close({ go: true }); } }]);
    }
    draw();
    const r = await d.promise;
    if (r && r.go) await S.importItems(items.filter((i) => i.include), { dateBy: f.dateBy });
  };

  const payload = (items) => items.map((it) => ({ file: it.file, line: it.line, part: it.part, rev: it.rev, revised: it.revised, revisedBy: it.revisedBy, hmi: it.hmi,
    notes: it.rel && it.rel !== it.file ? [`Folder: ${it.rel}`] : [], fields: it.fields.map((x) => ({ key: x.key, label: x.label, value: x.value, raw: x.raw, status: x.status, note: x.note, include: x.include })) }));

  // preview (same checks as the Excel import), then save
  S.importItems = async function importItems(items, base = {}) {
    const opts = { ...base, skipBad: false };
    for (;;) {
      const plan = await ST.api('previewScans', payload(items), opts);
      const sum = plan.summary;
      const list = (cls, arr) => (arr.length ? h('ul', { class: `plan-list ${cls}` }, arr.map((t) => h('li', { text: t }))) : null);
      const body = (close) => h('div', { class: 'col tight' },
        h('div', { class: 'plan-sum' }, chip(sum.toAdd, 'Entries to add'), chip(sum.newParts.length, `New ${ST.L.parts.toLowerCase()}`), chip(sum.duplicates, 'Already up to date'), chip(sum.skipped, 'With problems', 'warn'), chip(sum.values, 'Values')),
        plan.errors.length ? h('div', {}, h('b', { text: 'Problems' }), list('plan-err', plan.errors.slice(0, 60))) : null,
        plan.warnings.length ? h('div', {}, h('b', { text: 'Notes' }), list('plan-warn', plan.warnings.slice(0, 30))) : null,
        sum.newParts.length ? h('div', {}, h('b', { text: `New ${ST.L.parts.toLowerCase()}` }), h('p', { class: 'muted', text: sum.newParts.slice(0, 40).map((p) => `${ST.lineName(p.line)} · ${p.part}`).join('   ') + (sum.newParts.length > 40 ? ` …and ${sum.newParts.length - 40} more` : '') })) : null,
        plan.skipped.length ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: opts.skipBad, onchange: (e) => { opts.skipBad = e.target.checked; close('again'); } }), ' Import the good sheets and skip the ones with problems') : null);
      const go = await ST.modal({ title: 'Import scanned sheets', wide: true, body,
        buttons: plan.canApply ? [{ text: 'Back', value: null }, { text: `Import ${plural(sum.toAdd, 'entry', 'entries')}`, primary: true, value: 'apply' }] : [{ text: 'Close', primary: true, value: null }] });
      if (go === 'again') continue;
      if (go === 'apply') {
        const res = await ST.api('applyScans', payload(items), opts);
        ST.toast(`Imported ${plural(res.added, 'entry', 'entries')}${res.skipped ? `, skipped ${res.skipped}` : ''}`);
        await ST.refreshCore();
      }
      return;
    }
  };
})();
