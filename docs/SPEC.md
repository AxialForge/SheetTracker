# Setup Tracker — Spec

> Status: v0.2.0 adds the data-integrity rules in §4 and §11 (part checks, text normalization and pick-lists, void / correct). v0.1.0 implements everything below on the Bracket stack (Electron + node:sqlite), replacing the v3 Python/PySide6 prototype. The one deviation: the kit ships dark themes only, so the "Light" theme in the mockup is not built; the default is the kit's `crimson` theme (dark, red accent). Sections 5 and 9 describe the old Python plan; the schema now lives in `app/main/service.js` and the build plan is done.

## 1. Who / why
Joe, process engineer at Viking Forge (forging job shop). Manages press lines 1, 3, 4, 5, 7, 9, 11. Every day he gets checked-off press setup sheets (paper/scan). He wants to log them and see what changed day to day per Line + Part. Single user, all local Windows PC for now. Prefers direct, concise UI and docs.

## 2. Core requirements (from Joe)
- Key identifiers: **Line #** + **Part No.** Everything sorts by line.
- Track variables that may or may not change; notes section per entry.
- Exportable data (CSV/XLSX) and built-in charts.
- Data protected: backups, and **backup/restore inside the app**.
- All local, single user. Network-folder DB, multi-user, and OCR/photo extraction of sheets are **deferred** (don't build; keep DB path configurable).
- All fields usable; any can be hidden, renamed, or added (custom).

## 3. Sheet / field knowledge
- Lines → form: L1=10900 (1600T), L2=10903 (4000T), L3=10880 (1600T), L4=10880 (1600T), L5/L7/L9=10899 (2500T), L11=10903 (4000T). Editable per line (`line_forms` table).
- Fields are the real setup-sheet fields (`CATALOG` in `fields.js`). *Tracked* (change day to day, asked every entry): station labels, tonnage s1–3, special forge/trim, number of coils, coil number, billet/reject/scrap temps, billet grade, cycle time, wedge, die stations, lube concentration/program, shut height, nitrogen, scrap disposal, Z offset; plus per form: 10900 run line speed + run power + lube head; 10880 coil 1–2 % amps + lube tip; 10899 coil 1–3 % amps + lube head + robot head; 10903 coil 1–5 % amps + robot head + drop position. *Set once* (asked on the first entry for a Line + Part): leave tongs, billet diameter/length/weight, kick-setup hits 1–3, lube type, spacer diameter/count, cool down, gripper size, part cooling, drop position (non-10903), lube head (10903), and on 10900 capacitance, roller track hi/low delay, coil exit photo timer. Readings and the measured-tonnage grid ride along on every form.
- Existing databases keep their layout until you press **Apply sheet fields** on the Forms tab (`applyFieldMap`, `field_map` setting = `vf1`); stored values are never touched.
- **Settings** have a printed sheet setpoint + handwritten actual. **Readings** are actual-only and excluded from change tracking: Heat #, Avg Heat Temp (average of last 10 billet temps, °F), Part-to-Part Time (PTP, s), Dousing pump condition (x/5), Condat lube flow (xx of xx/xxx), Water inflow, Wagner pump pressure (PSI), and the 3×3 measured tonnage grid (3 pieces × stations 1–3; parts have 2 or 3 hits).
- All lube is **Condat 529** (template placeholders were just placeholders; no Condamix field).
- Sheet header: Line, Part No, Rev, revised date, HMI file #.
- Template filenames vs internal form numbers mismatched; internal Form # is authoritative.

## 4. Change-detection rules (keep as implemented)
- Compare each setting's actual to the last known non-blank value for that Line+Part (carry-forward). Blanks ignored. Numeric-aware equality (2300 == 2300.0). Readings never count as changes.
- Entry form is a **blank fill-in form**: gray placeholders + "Last" column show previous values; "Fill blanks with last values" fills settings only; "Clear form"; Ctrl+S.
- Changed cells yellow; actual ≠ sheet setpoint orange (drift).
- Entries append-only (edit = new revision, never overwrite). Notes editable in Data tab (audit-logged).
- A wrong entry is **voided** with a required reason (or replaced by a **correction**, which voids the original in the same save). Voided entries stay on record but are excluded from change detection, drift, trends, exports, reports and the Last column, so the history is recalculated without them. Restoring a void is allowed unless a correction already replaced it. Every void and restore is audit-logged.
- Text is compared and stored normalized: trimmed, inner whitespace collapsed, case-insensitive. A typed value that matches a known spelling (the field's pick-list first, then the most-used stored value) is saved in that spelling.
- Part numbers match ignoring case and extra spaces and are saved in the spelling already on that line. A part with no history on its line asks for confirmation on Data Entry and offers near matches (one character off, or equal ignoring punctuation). Settings → Parts renames a part, or merges two spellings into one history; entry values are never edited.

## 5. Data model (existing v3, SQLite, `PRAGMA user_version=2`)
Tables: fields(key,label,section,kind,unit,visible,sort,custom,has_sp), parts(line,part_no), entries(id,line,part_no,entry_ts,entered_by,sheet_rev,sheet_revised,hmi_file,notes,source), entry_values(entry_id,key,setpoint,actual), audit(id,ts,user,action,detail), line_forms(line,form_no).
Paths: `~/.setup_tracker/{setups.db,config.json,backups/}`. journal_mode=DELETE; backups via sqlite backup API, 5-min throttle, keep newest 100; restore runs integrity_check and backs up current DB first.
v4 additions (bump user_version to 3): `entries.reason TEXT`, `entries.photo_path TEXT` (or `entry_photos` table), `settings` key/value table (optional-feature flags, drift thresholds, theme), `drift_ack` table (line, part, key, acked_ts).

## 6. Target UI — 6 tabs (see mockup/png)
1. **Dashboard** — KPI cards: entries this week, setting changes (30d), lines not logged today (only if missing-entry option on), drift alerts. Trend chart (Line/Part/Field, actual vs setpoint; optional "Compare lines" toggle). Most-changed settings bar chart (30d). Drift alerts card (Review button → opens entry). Recent changes list. "Line status today" card (optional feature).
2. **Data Entry** — header: Line, Part (editable combos), Form badge, date/time, Sheet rev, HMI file #. Sections as cards with Setpoint / Actual / Last columns; collapsible secondary sections; Measured tonnage 3×3 grid; Readings card (lube run + run data); Notes card with optional Reason chips (Die change, Material, Quality, Maintenance, Other) and optional "Attach sheet photo". Buttons: Fill blanks with last values, Clear, Save Entry (N changes).
3. **Data** — filterable table sorted by line; Date/Time, Rev, Notes (editable), Reason, Photo, then fields. Yellow=changed, orange=drift. Filters by line/part/date/changes-only.
4. **Export** — CSV/XLSX of one part or all; date range; include change reasons; **Weekly change report (PDF)** with "auto-create weekly" toggle and output folder (default `Documents\SetupTracker\Reports`). Charts export as PNG.
5. **Settings** — Fields (show/hide, rename, add custom), Line→Form mapping, **Optional features** toggles, Backup & restore (back up now, change backup folder, restore selected/from file, backup list, integrity check, open data folder), audit log, Theme (Light / Dark), date format.
6. **About** — version, local-data statement, roadmap with statuses.

## 7. Approved features (decisions)
| Feature | Decision |
|---|---|
| Missing-entry tracking (lines not logged today) | YES, as an option (default off) |
| Setpoint drift alerts (actual ≠ setpoint for N entries in a row; N configurable, default 3; ack/dismiss) | YES |
| Weekly change report PDF (+ optional auto-create) | YES |
| Change reasons on entries | YES, optional |
| Sheet photo attachments (copy into `~/.setup_tracker/photos/`, include in backups) | YES, optional |
| Cross-line charts ("Compare lines") | MAYBE → build last, behind toggle |
| Compare two entries | NO |
| Printable pre-filled sheet | NO |
| Sheet revision tracking | NOT YET (roadmap only) |
| OCR / photo extraction | DEFERRED |
| Network folder / multi-user | DEFERRED |

## 8. Theme
Light: warm off-white ground #f4f1ea, panel #fffdf8, ink #1c1b19, accent burnt orange #c2410c, header #211f1c. Dark: ground #141312, panel #1d1b19, ink #f1ede4, muted #a39d90, border #38342d, **accent red #dc2626**, header #0a0a09, changed-cell #4d4211, drift-cell #5a2a1a. Font: IBM Plex Sans (+ Mono for values; fall back to system fonts if not bundled). Implement as a QSS/palette switch + matplotlib style follow. Full map in `mockup/_generator_gen_mock2.py` (DARK_MAP).

## 9. Build plan
1. Migration to schema v3 (+ backup first, test on v2 DB).
2. Theme system (light/dark), restructure `Main` into 6 tabs, reuse Entry/History/Charts/Fields/Admin widgets inside new tabs.
3. Dashboard (KPIs, trend, most-changed, recent changes).
4. Optional features via settings flags: reasons, photos, missing-entry status, drift alerts.
5. Weekly PDF report (matplotlib/reportlab — pick one, add to requirements) + auto-create on app start if a week has elapsed.
6. Cross-line compare chart.
7. Tests: change detection, migration, backup/restore round trip, drift logic; headless smoke run of every tab in both themes.
8. Package for Windows (PyInstaller one-folder) and update README.

## 10. Forms editor (schema v4)
- Forms and their fields are data, not code: `forms(form_no, name, notes)` and `form_fields(form_no, key, role)`. A fresh install or a v3 → v4 migration seeds exactly the field lists that were previously hard-coded (`FORM_SPECIFIC` in `fields.js`), all `tracked`.
- **Role**: `tracked` fields change day to day and are asked on every entry. `initial` ("set once") fields are fixed setup values, asked on the first entry for a Line + Part and on demand afterwards (Data Entry → *Show setup fields*). Both roles use the same storage and the same change detection.
- **Forms tab**: add a form (empty or copied from another, roles included), rename its number everywhere (field list and line mapping; stored entries are unaffected), delete it (refused while a line uses it), edit name / notes. Per form: add an existing field, create a new field (this form only or all forms), remove a field (stored values are kept), change a field's name / section / type / setting-or-reading / unit, set its role.
- Name, section, type, kind and unit belong to the field and are shared by every form that uses it; the role belongs to the form.
- `addField` attaches the new field to all forms by default (or the forms given); imported custom fields join every existing form; mapping a line to an unknown form number creates that form with the default field set.

## 11. Data integrity (schema v5, v0.2.0)
- `entries.voided`, `void_reason`, `voided_ts`, `corrected_by` (the entry that replaced it); `fields.choices` (pick-list, one value per line, text settings only); index on `entry_values(key)`.
- Service: `voidEntry(id, reason)`, `restoreEntry(id)`, `saveEntry({ corrects, correct_reason })`, `checkPart(line, part)`, `renamePart(line, from, to)`, `listPartsDetailed()`, `valueSuggestions()`; `listEntries({ includeVoided })`.
- Data tab: **Show voided**, and **Revise** (new entry, original still counts), **Correct** (original voided on save) and **Void** per row. Forms tab: a pick-list column for text settings.
- The v4 → v5 migration relabels the tonnage fields only if they still carry the old factory names ("Tonnage setting - station N", "Measured tonnage - piece N / station M") and fills the capacitance unit (µF) if it was empty. "Show setup fields" is remembered per PC, and coil rows beyond "Number of coils" are hidden on Data Entry.

## 12. Notes
- Mockup is a static comp at 1280×840: some cards clip in the PNGs; real app should scroll/resize. All mockup data is sample.
- `seed_from_sheets.py` loads baseline setpoints from 6 sample sheets (transcribed from scans; verify).
- `existing_app_v3/` is the authoritative current code (app.py ~660 lines, db.py ~380).
