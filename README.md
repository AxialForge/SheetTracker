# Setup Tracker

Log checked-off press setup sheets and see what changed day to day, per **Line + Part**. Single user, all local, Windows desktop app (Electron + SQLite).

![Dashboard](docs/screenshots/crimson-dashboard.png)

## Install

Download `Setup Tracker-<version>-setup.exe` from [Releases](../../releases) and run it. The installer is unsigned, so Windows SmartScreen shows *More info → Run anyway* once.

Data lives in `%USERPROFILE%\.setup_tracker\` (`setups.db`, `config.json`, `backups\`, `photos\`). Nothing leaves the PC.

## What it does

| Tab | |
|---|---|
| **Dashboard** | KPIs, trend chart (actual vs sheet setpoint, optional compare-lines), most-changed settings, drift alerts, recent changes, line status today |
| **Data Entry** | Blank fill-in form per line's sheet form. Gray placeholders and a *Last* column show previous values; changed cells go yellow, actual ≠ setpoint orange. *Fill blanks with last values*, *Clear*, `Ctrl+S` |
| **Data** | Filterable table sorted by line. Editable notes, reasons, photos. *Revise* (a new entry), *Correct* (replaces a wrong entry), *Void* (takes it out of change detection, with a reason; *Show voided* lists them) |
| **Export** | CSV / XLSX (one part or all, date range, reasons) and the weekly change report (PDF, optional auto-create on app start) |
| **Forms** | Add, renumber, copy and delete forms; choose which fields each form carries and whether each is *Tracked* (asked every entry) or *Set once* (asked on the first entry for a Line + Part); add, edit or remove fields |
| **Settings** | Fields (hide / rename / add for all forms), line → form map, parts (rename, or merge two spellings into one history), optional features, backup & restore, audit log, theme, date format, sample data, import of the v3 Python database |
| **About** | Version, local-data statement, roadmap |

Change rules (`docs/SPEC.md` §4): each setting's actual is compared to the last known non-blank value for that Line + Part; blanks are ignored; `2300` equals `2300.0`; text ignores case and extra spaces; readings (heat #, PTP, tonnage, …) never count as changes; entries are append-only (a wrong one is voided, not deleted). A Part No. with no history on its line asks for confirmation and suggests near matches, so a typo cannot silently start a new history.

Backups are taken on save (max one per 5 min), before restore / import / migration, kept to the newest 100. Restore runs an integrity check and backs up the current database first. Put the backup folder on a different drive (Settings → Backup & restore).

## Develop

```
npm install
npm start               # run the app
npm test                # unit tests (node:test)
npm run screenshots     # headless smoke run of every tab in every theme -> docs/screenshots
npm run dist            # Windows installer in dist/ (run on Windows; Linux needs wine)
```

Set `SETUP_TRACKER_DATA_DIR` to run against a scratch data folder. Release: bump the version, `git tag vX.Y.Z && git push origin vX.Y.Z`; CI builds and attaches the installer.

## Known gaps

- The factory setting names, units and sections are a starting set. Change what each form carries in the Forms tab (and rename, hide or add fields there or in Settings → Fields); the line → form mapping is in Settings.
- Dark themes only (crimson default, amber, steel).
- No code signing and no auto-update.
- Deferred by design: OCR / photo extraction, network-folder database, multi-user.
