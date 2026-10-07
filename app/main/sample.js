'use strict';
// Deterministic demo data: ~6 weeks of weekday entries across all lines, a few real changes,
// two drifting settings and a couple of lines skipped "today" so every dashboard card has content.
const { tsLocal } = require('./service');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// key -> [setpoint, step] (step = size of a typical operator adjustment)
const BASE = {
  tonnage_s1: [1200, 25], tonnage_s2: [1400, 25], tonnage_s3: [1000, 25], num_coils: [2, 1],
  billet_temp: [2250, 10], low_reject_temp: [2150, 10], hi_reject_temp: [2350, 10], scrap_temp: [2000, 10], cycle_time: [6.5, 0.1],
  coil1_amps: [82, 1], coil2_amps: [81, 1], coil3_amps: [80, 1], coil4_amps: [79, 1], coil5_amps: [78, 1],
  run_line_speed: [32, 1], run_power: [41, 1], lube_concentration: [6, 0.5], nitrogen: [1500, 25], shut_height: [14.25, 0.05],
  z_offset: [0, 1],
};
const PARTS = { 1: ['5521-A', '5530-B'], 2: ['2200-Y'], 3: ['3310-K'], 4: ['4410-D'], 5: ['6120-C', '6144-F'], 7: ['7007-J'], 9: ['9190-M'], 11: ['11200-X'] };
const REASONS = ['Die change', 'Material', 'Quality', 'Maintenance'];

function generate(svc, days = 42) {
  const r = rng(20260601);
  const fields = svc.getFields();
  const now = new Date(svc.now());
  const todayDay = tsLocal(now).slice(0, 10);
  let count = 0;
  const rnd = (lo, hi) => lo + (hi - lo) * r();
  const round = (v, step) => { const d = String(step).split('.')[1]?.length || 0; return Number(v.toFixed(d + 1)); };
  const forms = new Map(svc.getLineForms().map((l) => [l.line, l.form_no]));
  const drifters = new Set(['3|3310-K|nitrogen', '5|6120-C|coil2_amps']);
  for (const [lineStr, parts] of Object.entries(PARTS)) {
    const line = Number(lineStr);
    if (!forms.has(line)) continue;
    for (const part of parts) {
      const keys = svc.fieldsForForm(forms.get(line)).filter((f) => f.has_sp && BASE[f.key]).map((f) => f.key);
      const actual = {}; const sp = {};
      keys.forEach((k) => { sp[k] = BASE[k][0]; actual[k] = BASE[k][0]; });
      for (let d = days; d >= 0; d--) {
        const day = new Date(now); day.setDate(now.getDate() - d);
        if ([0, 6].includes(day.getDay())) continue;
        const dayStr = tsLocal(day).slice(0, 10);
        if (dayStr === todayDay && (line === 4 || line === 9)) continue; // not yet logged today
        if (r() < 0.12) continue;
        let reason = '';
        if (r() < 0.07) {
          const k = keys[Math.floor(r() * keys.length)];
          actual[k] = round(actual[k] + (r() < 0.5 ? -1 : 1) * BASE[k][1] * (1 + Math.floor(r() * 2)), BASE[k][1]);
          if (!drifters.has(`${line}|${part}|${k}`)) sp[k] = actual[k]; // sheet reissued with the new setpoint
          reason = REASONS[Math.floor(r() * REASONS.length)];
        }
        const values = {};
        for (const k of keys) {
          let a = actual[k];
          if (drifters.has(`${line}|${part}|${k}`) && d <= 6) a = round(sp[k] + BASE[k][1] * 3, BASE[k][1]);
          values[k] = { setpoint: sp[k], actual: a };
        }
        values.heat_no = { actual: `H${100000 + Math.floor(r() * 900000)}` };
        values.avg_heat_temp = { actual: Math.round(rnd(2225, 2275)) };
        values.ptp_time = { actual: round(rnd(5.5, 7.5), 0.1) };
        values.dousing_pump = { actual: `${3 + Math.floor(r() * 3)}/5` };
        values.water_inflow = { actual: Math.round(rnd(38, 44)) };
        values.wagner_pressure = { actual: Math.round(rnd(1150, 1250)) };
        const hits = line === 3 ? 2 : 3;
        for (let p = 1; p <= 3; p++) for (let s = 1; s <= hits; s++) values[`ton_p${p}_s${s}`] = { actual: Math.round(rnd(300, 420)) };
        const hh = 6 + Math.floor(r() * 3);
        day.setHours(hh, Math.floor(r() * 60), 0, 0);
        svc.saveEntry({
          line, part_no: part, entry_ts: tsLocal(day), entered_by: 'Joe', sheet_rev: 'B', sheet_revised: '2026-01-15',
          hmi_file: `HMI-${line}${part.slice(0, 2)}`, noBackup: true, notes: reason ? `${reason} - adjusted setting` : '', reason, values, source: 'sample',
        });
        count++;
      }
    }
  }
  return count;
}

module.exports = { generate };
