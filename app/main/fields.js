// Field catalogue. Settings (has_sp=1) carry a printed setpoint + handwritten actual and
// are change-tracked. Readings (has_sp=0) are actual-only and never count as changes.
// Everything here is only the factory default: each field can be hidden, renamed or added to in Settings.

const SECTIONS = [
  { key: 'stations', label: 'Stations' },
  { key: 'instr', label: 'Instructions' },
  { key: 'heat', label: 'Billet heating' },
  { key: 'coils', label: '% of coil amps' },
  { key: 'press', label: 'Forge press' },
  { key: 'lube', label: 'Die lube' },
  { key: 'trim', label: 'Trim press' },
  { key: 'spacers', label: 'Billet spacers' },
  { key: 'robot', label: 'Pick and place robot' },
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

// Type details for factory fields that are not plain number/text. Dousing pump condition is "x/5": a rating out of 5.
const FIELD_EXTRAS = {
  dousing_pump: { kind: 'rating', min: '0', max: '5', unit: '' },
};

// Measured tonnage grid: 3 pieces x stations 1-3 (parts have 2 or 3 hits).
const TONNAGE = [];
for (let p = 1; p <= 3; p++) {
  for (let s = 1; s <= 3; s++) TONNAGE.push([`ton_p${p}_s${s}`, `Measured tonnage - piece ${p} / station ${s}`, 'tonnage', 'number', 'T', 0]);
}

// Labels changed in v0.2.0 so the tonnage setting and the measured grid read differently.
// Existing databases are only relabelled when the field still carries the old factory name.
const RELABEL_V5 = [
  ...[1, 2, 3].map((s) => [`tonnage_s${s}`, `Tonnage - station ${s}`, `Tonnage setting - station ${s}`]),
  ...TONNAGE.map((f) => [f[0], f[1].replace('Measured tonnage - piece ', 'Piece ').replace(' / station ', ' / Station '), f[1]]),
];

// ---- Real setup-sheet fields (from the four blank forms). Applied on fresh installs; existing installs use "Apply sheet fields".
const FIELD_MAP_ID = 'vf1';
const CATALOG = [
  // [key, label, section, kind, unit, has_sp]
  ['station1_label', 'Station 1 label', 'stations', 'text', '', 1],
  ['station2_label', 'Station 2 label', 'stations', 'text', '', 1],
  ['station3_label', 'Station 3 label', 'stations', 'text', '', 1],
  ['tonnage_s1', 'Tonnage setting - station 1', 'stations', 'number', 'T', 1],
  ['tonnage_s2', 'Tonnage setting - station 2', 'stations', 'number', 'T', 1],
  ['tonnage_s3', 'Tonnage setting - station 3', 'stations', 'number', 'T', 1],
  ['leave_tongs', 'Leave tongs in', 'stations', 'text', '', 1],
  ['special_forge', 'Special forge instruction', 'instr', 'text', '', 1],
  ['special_trim', 'Special trim instruction', 'instr', 'text', '', 1],
  ['num_coils', 'Number of coils', 'heat', 'number', '', 1],
  ['coil_no', 'Coil number', 'heat', 'text', '', 1],
  ['billet_temp', 'Billet temperature', 'heat', 'number', '°F', 1],
  ['low_reject_temp', 'Low reject temperature', 'heat', 'number', '°F', 1],
  ['hi_reject_temp', 'Hi reject temperature', 'heat', 'number', '°F', 1],
  ['scrap_temp', 'Scrap temperature', 'heat', 'number', '°F', 1],
  ['billet_grade', "Billet grade mat'l", 'heat', 'text', '', 1],
  ['cycle_time', 'Cycle time', 'heat', 'number', 's', 1],
  ['run_line_speed', 'Run line speed', 'heat', 'number', '', 1],
  ['run_power', 'Run power level', 'heat', 'number', '', 1],
  ['billet_diameter', 'Billet diameter', 'heat', 'number', 'in', 1],
  ['billet_length', 'Billet length', 'heat', 'number', 'in', 1],
  ['billet_weight', 'Billet weight', 'heat', 'number', 'lb', 1],
  ['capacitance', 'Capacitance', 'heat', 'number', 'µF', 1],
  ['roller_hi_delay', 'Roller track hi delay', 'heat', 'number', 's', 1],
  ['roller_low_delay', 'Roller track low delay', 'heat', 'number', 's', 1],
  ['coil_exit_timer', 'Coil exit photo timer', 'heat', 'number', 's', 1],
  ['coil1_amps', '% of coil amps - coil 1', 'coils', 'number', '%', 1],
  ['coil2_amps', '% of coil amps - coil 2', 'coils', 'number', '%', 1],
  ['coil3_amps', '% of coil amps - coil 3', 'coils', 'number', '%', 1],
  ['coil4_amps', '% of coil amps - coil 4', 'coils', 'number', '%', 1],
  ['coil5_amps', '% of coil amps - coil 5', 'coils', 'number', '%', 1],
  ['wedge', 'Wedge', 'press', 'text', '', 1],
  ['die_stations', 'Die stations', 'press', 'text', '', 1],
  ['kick_hit1', 'Kick setup - hit 1 (die position / KO# / dwell)', 'press', 'text', '', 1],
  ['kick_hit2', 'Kick setup - hit 2 (die position / KO# / dwell)', 'press', 'text', '', 1],
  ['kick_hit3', 'Kick setup - hit 3 (die position / KO# / dwell)', 'press', 'text', '', 1],
  ['lube_concentration', 'Lube concentration', 'lube', 'number', '', 1],
  ['lube_program', 'Lube program', 'lube', 'text', '', 1],
  ['lube_head', 'Lube head number / lube tip', 'lube', 'text', '', 1],
  ['lube_type', 'Lube type', 'lube', 'text', '', 1],
  ['shut_height', 'Shut height', 'trim', 'number', 'in', 1],
  ['nitrogen', 'Nitrogen', 'trim', 'number', '', 1],
  ['scrap_disposal', 'Scrap disposal', 'trim', 'text', '', 1],
  ['part_cooling', 'Part cooling requirement', 'trim', 'text', '', 1],
  ['spacer_diameter', 'Spacer diameter', 'spacers', 'number', 'in', 1],
  ['num_spacers', 'Number of spacers', 'spacers', 'number', '', 1],
  ['robot_head', 'Robot head number', 'robot', 'text', '', 1],
  ['drop_position', 'Drop position', 'robot', 'text', '', 1],
  ['z_offset', 'Z offset', 'robot', 'number', '', 1],
  ['cool_down', 'Cool down', 'robot', 'text', '', 1],
  ['gripper_size', 'Gripper size', 'robot', 'text', '', 1],
];

// Tracked (changes day to day) per form, by key. 'all' = every form.
const TRACKED_ALL = ['station1_label', 'station2_label', 'station3_label', 'tonnage_s1', 'tonnage_s2', 'tonnage_s3',
  'special_forge', 'special_trim', 'num_coils', 'coil_no', 'billet_temp', 'low_reject_temp', 'hi_reject_temp', 'scrap_temp',
  'billet_grade', 'cycle_time', 'wedge', 'die_stations', 'lube_concentration', 'lube_program', 'shut_height', 'nitrogen',
  'scrap_disposal', 'z_offset'];
const TRACKED_BY_FORM = {
  10900: ['run_line_speed', 'run_power', 'lube_head'],
  10880: ['coil1_amps', 'coil2_amps', 'lube_head'],
  10899: ['coil1_amps', 'coil2_amps', 'coil3_amps', 'lube_head', 'robot_head'],
  10903: ['coil1_amps', 'coil2_amps', 'coil3_amps', 'coil4_amps', 'coil5_amps', 'robot_head', 'drop_position'],
};
// Set once on the first entry for a Line + Part (anything already tracked on that form stays tracked).
const INITIAL_ALL = ['leave_tongs', 'billet_diameter', 'billet_length', 'billet_weight', 'kick_hit1', 'kick_hit2', 'kick_hit3',
  'lube_type', 'lube_head', 'spacer_diameter', 'num_spacers', 'cool_down', 'drop_position', 'gripper_size', 'part_cooling'];
const INITIAL_BY_FORM = { 10900: ['capacitance', 'roller_hi_delay', 'roller_low_delay', 'coil_exit_timer'] };
const FORM_META = {
  10900: { name: '1600T 2-coil (run line speed)', notes: "Run line speed + run power level; station 1 'DUMMY'" },
  10880: { name: '1600T 2-coil', notes: "'Lube Tip' instead of lube head number" },
  10899: { name: '2500T 3-coil + robot', notes: '' },
  10903: { name: '4000T 5-coil + robot', notes: 'Billet diameter on the form' },
};

// form -> [{key, role}] for the real forms (readings + measured tonnage ride along on every form).
function formLayout(form) {
  if (!(form in TRACKED_BY_FORM)) return null;
  const tracked = new Set([...TRACKED_ALL, ...TRACKED_BY_FORM[form]]);
  const out = [...tracked].map((key) => ({ key, role: 'tracked' }));
  for (const key of [...INITIAL_ALL, ...(INITIAL_BY_FORM[form] || [])]) if (!tracked.has(key)) out.push({ key, role: 'initial' });
  for (const f of [...READINGS, ...TONNAGE]) out.push({ key: f[0], role: 'tracked' });
  return out;
}
function catalogDefaults() {
  const seen = new Map();
  [...CATALOG, ...READINGS, ...TONNAGE].forEach((f) => { if (!seen.has(f[0])) seen.set(f[0], f); });
  return [...seen.values()];
}

const DEFAULT_LINE_FORMS = { 1: 10900, 2: 10903, 3: 10880, 4: 10880, 5: 10899, 7: 10899, 9: 10899, 11: 10903 };
const PRESS_TONNAGE = { 1: '1600T', 2: '4000T', 3: '1600T', 4: '1600T', 5: '2500T', 7: '2500T', 9: '2500T', 11: '4000T' };
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
  SECTIONS, FIELD_EXTRAS, BASE, FORM_SPECIFIC, READINGS, TONNAGE, RELABEL_V5, FORMS, DEFAULT_LINE_FORMS, PRESS_TONNAGE,
  DEFAULT_SETTINGS, REASONS, formKeys, allDefaults,
  FIELD_MAP_ID, CATALOG, TRACKED_ALL, TRACKED_BY_FORM, INITIAL_ALL, INITIAL_BY_FORM, FORM_META, formLayout, catalogDefaults,
};
