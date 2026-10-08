'use strict';
// Builds the template that mirrors the printed 2500 Ton press setup sheet, field for field and in the sheet's order.
// The file Joe supplied is named "Form 10900. 2500 Ton Press Setup Sheet Template.xlsx"; the sheet's own footer reads
// FORM#: 10899 (REVISION A, ECN 11583, 2023-04-25), and 10899 is the 2500T 3-coil + robot form, so 10899 is used.
const Tpl = require('../app/main/template');

const FORM = 10899;
const NOTES = 'Mirrors the printed sheet: Form 10899, revision A, ECN 11583, 25 Apr 2023 (the file it came in was named Form 10900).';

// [key, overrides]. Order = the sheet, left column (stations, instructions) then the right column top to bottom.
// Overrides are only where the printed sheet says more than the app currently knows (a unit, or a clear yes/no).
const SHEET = [
  ['station1_label'], ['tonnage_s1'], ['leave_tongs', { kind: 'yesno' }],
  ['station2_label'], ['tonnage_s2'], ['station3_label'], ['tonnage_s3'],
  ['special_forge'], ['special_trim'],
  // BILLET HEATING REQUIREMENTS
  ['num_coils'], ['billet_temp'], ['low_reject_temp'], ['hi_reject_temp'], ['scrap_temp'],
  ['billet_diameter'], ['billet_length'], ['billet_weight'], ['billet_grade'], ['coil_no'],
  ['coil1_amps'], ['coil2_amps'], ['coil3_amps'], ['cycle_time'],
  // FORGE PRESS REQUIREMENTS
  ['wedge'], ['die_stations'], ['kick_hit1'], ['kick_hit2'], ['kick_hit3'],
  // DIE LUBE REQUIREMENTS
  ['lube_type'], ['lube_concentration'], ['lube_program'], ['lube_head'],
  // BILLET SPACERS REQUIREMENTS
  ['spacer_diameter'], ['num_spacers'],
  // PICK AND PLACE ROBOT SETTINGS
  ['robot_head'], ['cool_down', { kind: 'duration', unit: 's' }], ['drop_position'], ['z_offset'],
  // TRIM PRESS REQUIREMENTS
  ['shut_height'], ['nitrogen', { unit: 'PSI' }], ['part_cooling'], ['scrap_disposal'],
];

// svc: a SetupService holding the factory press fields (a fresh install).
function sheet10899(svc) {
  const sections = new Map(svc.getSections().map((s) => [s.key, s.label]));
  const onForm = new Map(svc.getFormFields(FORM).map((f) => [f.key, f]));
  const rows = SHEET.map(([key, over]) => {
    const f = onForm.get(key);
    if (!f) throw new Error(`Field ${key} is not on form ${FORM}`);
    return Tpl.fieldRow(FORM, sections.get(f.section) || f.section, { ...f, ...(over || {}) });
  });
  const lines = svc.getLineForms().filter((l) => l.form_no === FORM).map((l) => l.line);
  const meta = svc.getForms().find((f) => f.form_no === FORM);
  return Tpl.assemble(svc, { rows, formRows: [[FORM, meta.name, NOTES, lines.join(', ')]] });
}

module.exports = { sheet10899, SHEET, FORM, NOTES };
