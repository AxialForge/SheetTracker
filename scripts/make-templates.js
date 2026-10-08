'use strict';
// Writes the ready-made Excel templates in templates/:
//   blank-form-template.xlsx   headers + instructions only, for starting a new job from scratch
//   press-setup-forms.xlsx     the Viking Forge press forms (10880 / 10899 / 10900 / 10903) as they ship
//   form-10899-2500T-setup-sheet.xlsx   the printed 2500 Ton press setup sheet, field for field, in the sheet's order
// Usage: npm run templates
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SetupService } = require('../app/main/service');
const { sheet10899 } = require('./templates-lib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tpl-'));
const svc = new SetupService({ dataDir: dir });
const out = path.join(__dirname, '..', 'templates');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'blank-form-template.xlsx'), svc.exportTemplate({ blank: true }));
fs.writeFileSync(path.join(out, 'press-setup-forms.xlsx'), svc.exportTemplate({ forms: 'all' }));
fs.writeFileSync(path.join(out, 'form-10899-2500T-setup-sheet.xlsx'), sheet10899(svc));
// one blank history template per form: the sheet to fill in from old PDFs, then Export → Import entries from Excel
const hdir = path.join(out, 'history');
fs.mkdirSync(hdir, { recursive: true });
for (const f of svc.getForms()) fs.writeFileSync(path.join(hdir, `history-template-form-${f.form_no}.xlsx`), svc.exportHistoryTemplate({ form: f.form_no }));
svc.close();
console.log('wrote', fs.readdirSync(out).join(', '), '+ history/', fs.readdirSync(hdir).join(', '));
