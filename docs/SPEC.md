# Setup Tracker — Spec

> Status: v0.1.0 implements everything below on the Bracket stack (Electron + node:sqlite), replacing the v3 Python/PySide6 prototype. The one deviation: the kit ships dark themes only, so the "Light" theme in the mockup is not built; the default is the kit's `crimson` theme (dark, red accent). Sections 5 and 9 describe the old Python plan; the schema now lives in `app/main/service.js` and the build plan is done.

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
- Lines → form: L1=10900 (2500T), L3=10880 (1300T), L4=10880, L5=10899 (1600T), L7=10899, L9=10899, L11=10903 (4000T). Editable per line (`line_forms` table). (Joe confirmed L4 is 10880.)
- Forms differ in which setting fields they contain (`FORM_FIELDS` in db.py): 10880 = base + coil 1–2 amps; 10899 = base + coil 1–3 amps + robot; 10900 = base + capacitance, run line speed, run power, roller hi/low delay, coil exit timer; 10903 = base + coil 1–5 amps + robot + gripper size.
- **Settings** have a printed sheet setpoint + handwritten actual. **Readings** are actual-only and excluded from change tracking: Heat #, Avg Heat Temp (average of last 10 billet temps, °F), Part-to-Part Time (PTP, s), Dousing pump condition (x/5), Condat lube flow (xx of xx/xxx), Water inflow, Wagner pump pressure (PSI), and the 3×3 measured tonnage grid (3 pieces × stations 1–3; parts have 2 or 3 hits).
- All lube is **Condat 529** (template placeholders were just placeholders; no Condamix field).
- Sheet header: Line, Part No, Rev, revised date, HMI file #.
- Template filenames vs internal form numbers mismatched; internal Form # is authoritative.

## 4. Change-detection rules (keep as implemented)
- Compare each setting's actual to the last known non-blank value for that Line+Part (carry-forward). Blanks ignored. Numeric-aware equality (2300 == 2300.0). Readings never count as changes.
- Entry form is a **blank fill-in form**: gray placeholders + "Last" column show previous values; "Fill blanks with last values" fills settings only; "Clear form"; Ctrl+S.
- Changed cells yellow; actual ≠ sheet setpoint orange (drift).
- Entries append-only (edit = new revision, never overwrite). Notes editable in Data tab (audit-logged).

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

## 10. Notes
- Mockup is a static comp at 1280×840: some cards clip in the PNGs; real app should scroll/resize. All mockup data is sample.
- `seed_from_sheets.py` loads baseline setpoints from 6 sample sheets (transcribed from scans; verify).
- `existing_app_v3/` is the authoritative current code (app.py ~660 lines, db.py ~380).
