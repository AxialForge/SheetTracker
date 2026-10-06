// Field catalogue. Settings (has_sp=1) carry a printed setpoint + handwritten actual and
// are change-tracked. Readings (has_sp=0) are actual-only and never count as changes.
// Everything here is only the factory default: each field can be hidden, renamed or added to in Settings.

const SECTIONS = [
  { key: 'press', label: 'Press setup' },
  { key: 'heat', label: 'Heating' },
  { key: 'lube', label: 'Lube & spray' },
  { key: 'coils', label: 'Coil amps' },
  { key: 'robot', label: 'Robot / handling' },
  { key: 'run', label: 'Run settings' },
  { key: 'readings', label: 'Readings' },
  { key: 'tonnage', label: 'Measured tonnage' },
  { key: 'custom', label: 'Custom' },
];

// [key, label, section, kind, unit, has_sp]
const BASE = [
  ['stroke_speed', 'Stroke speed', 'press', 'number', 'SPM', 1],
  ['shut_height', 'Shut height', 'press', 'number', 'in', 1],
  ['die_temp', 'Die temp', 'press', 'number', '°F', 1],
  ['ejector_stroke', 'Ejector stroke', 'press', 'number', 'in', 1],
  ['billet_temp', 'Billet temp', 'heat', 'number', '°F', 1],
  ['heater_power', 'Heater power', 'heat', 'number', 'kW', 1],
  ['billet_length', 'Billet length', 'heat', 'number', 'in', 1],
  ['lube_spray_time', 'Lube spray time', 'lube', 'number', 's', 1],
  ['lube_pressure', 'Lube pressure', 'lube', 'number', 'PSI', 1],
  ['blowoff_time', 'Blow-off time', 'lube', 'number', 's', 1],
];

const FORM_SPECIFIC = {
  10880: [
    ['coil1_amps', 'Coil 1 amps', 'coils', 'number', 'A', 1],
    ['coil2_amps', 'Coil 2 amps', 'coils', 'number', 'A', 1],
  ],
  10899: [
    ['coil1_amps', 'Coil 1 amps', 'coils', 'number', 'A', 1],
    ['coil2_amps', 'Coil 2 amps', 'coils', 'number', 'A', 1],
    ['coil3_amps', 'Coil 3 amps', 'coils', 'number', 'A', 1],
    ['robot_speed', 'Robot speed', 'robot', 'number', '%', 1],
    ['robot_pickup_delay', 'Robot pickup delay', 'robot', 'number', 's', 1],
  ],
  10900: [
    ['capacitance', 'Capacitance', 'run', 'number', 'µF', 1],
    ['run_line_speed', 'Run line speed', 'run', 'number', '', 1],
    ['run_power', 'Run power', 'run', 'number', 'kW', 1],
    ['roller_hi_delay', 'Roller hi delay', 'run', 'number', 's', 1],
    ['roller_low_delay', 'Roller low delay', 'run', 'number', 's', 1],
    ['coil_exit_timer', 'Coil exit timer', 'run', 'number', 's', 1],
  ],
  10903: [
    ['coil1_amps', 'Coil 1 amps', 'coils', 'number', 'A', 1],
    ['coil2_amps', 'Coil 2 amps', 'coils', 'number', 'A', 1],
    ['coil3_amps', 'Coil 3 amps', 'coils', 'number', 'A', 1],
    ['coil4_amps', 'Coil 4 amps', 'coils', 'number', 'A', 1],
    ['coil5_amps', 'Coil 5 amps', 'coils', 'number', 'A', 1],
    ['robot_speed', 'Robot speed', 'robot', 'number', '%', 1],
    ['robot_pickup_delay', 'Robot pickup delay', 'robot', 'number', 's', 1],
    ['gripper_size', 'Gripper size', 'robot', 'text', '', 1],
  ],
};

const READINGS = [
  ['heat_no', 'Heat #', 'readings', 'text', '', 0],
  ['avg_heat_temp', 'Avg heat temp (last 10 billets)', 'readings', 'number', '°F', 0],
  ['ptp_time', 'Part-to-part time', 'readings', 'number', 's', 0],
  ['dousing_pump', 'Dousing pump condition', 'readings', 'text', 'x/5', 0],
  ['condat_flow', 'Condat 529 lube flow', 'readings', 'text', 'xx of xx/xxx', 0],
  ['water_inflow', 'Water inflow', 'readings', 'number', '', 0],
  ['wagner_pressure', 'Wagner pump pressure', 'readings', 'number', 'PSI', 0],
];

// Measured tonnage grid: 3 pieces x stations 1-3 (parts have 2 or 3 hits).
const TONNAGE = [];
for (let p = 1; p <= 3; p++) {
  for (let s = 1; s <= 3; s++) TONNAGE.push([`ton_p${p}_s${s}`, `Piece ${p} / Station ${s}`, 'tonnage', 'number', 'T', 0]);
}

const DEFAULT_LINE_FORMS = { 1: 10900, 3: 10880, 4: 10880, 5: 10899, 7: 10899, 9: 10899, 11: 10903 };
const PRESS_TONNAGE = { 1: '2500T', 3: '1300T', 4: '', 5: '1600T', 7: '', 9: '', 11: '4000T' };
const FORMS = [10880, 10899, 10900, 10903];

// Which factory fields belong to which form (custom fields appear on every form).
function formKeys(form) {
  const keys = new Set(BASE.map((f) => f[0]));
  for (const f of FORM_SPECIFIC[form] || []) keys.add(f[0]);
  return keys;
}

function allDefaults() {
  const seen = new Map();
  const add = (arr) => arr.forEach((f) => { if (!seen.has(f[0])) seen.set(f[0], f); });
  add(BASE);
  FORMS.forEach((fm) => add(FORM_SPECIFIC[fm]));
  add(READINGS);
  add(TONNAGE);
  return [...seen.values()];
}

const DEFAULT_SETTINGS = {
  theme: 'crimson',
  date_format: 'iso',
  entered_by: '',
  drift_n: '3',
  opt_reasons: '1',
  opt_photos: '1',
  opt_missing: '0',
  opt_drift: '1',
  opt_compare: '0',
  weekly_auto: '0',
  report_dir: '',
  last_report_ts: '',
};

const REASONS = ['Die change', 'Material', 'Quality', 'Maintenance', 'Other'];

module.exports = {
  SECTIONS, BASE, FORM_SPECIFIC, READINGS, TONNAGE, FORMS, DEFAULT_LINE_FORMS, PRESS_TONNAGE,
  DEFAULT_SETTINGS, REASONS, formKeys, allDefaults,
};
