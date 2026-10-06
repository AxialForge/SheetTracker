'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SetupService } = require('../app/main/service');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-')); }
// Fixed clock so day-based logic (this week, 30 days, today) is deterministic.
function make(opts = {}) {
  const dataDir = tmp();
  const svc = new SetupService({ dataDir, now: () => new Date('2026-03-18T12:00:00'), ...opts });
  return { svc, dataDir };
}
function entry(svc, ts, values, extra = {}) {
  return svc.saveEntry({ line: 5, part_no: 'P-1', entry_ts: ts, values, noBackup: true, ...extra });
}
module.exports = { tmp, make, entry };
