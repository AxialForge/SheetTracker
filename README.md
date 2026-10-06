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
| **Data** | Filterable table sorted by line. Editable notes, reasons, photos, *Revise* (loads an entry as a new revision) |
| **Export** | CSV / XLSX (one part or all, date range, reasons) and the weekly change report (PDF, optional auto-create on app start) |
| **Settings** | Fields (hide / rename / add), line → form map, optional features, backup & restore, audit log, theme, date format, sample data, import of the v3 Python database |
| **About** | Version, local-data statement, roadmap |

Change rules (`docs/SPEC.md` §4): each setting's actual is compared to the last known non-blank value for that Line + Part; blanks are ignored; `2300` equals `2300.0`; readings (heat #, PTP, tonnage, …) never count as changes; entries are append-only.

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

- The factory setting names, units and sections are a starting set. Rename, hide or add fields in Settings → Fields to match the real sheets; the line → form mapping is in Settings too.
- Dark themes only (crimson default, amber, steel).
- No code signing and no auto-update.
- Deferred by design: OCR / photo extraction, network-folder database, multi-user.
