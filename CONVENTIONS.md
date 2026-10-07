# Conventions

- **Commits**: short imperative subject, body only when the why isn't obvious. No AI attribution lines (no `Co-Authored-By`, no "generated with"). Commit with the global AxialForge git identity; `git config --local --get-regexp "^user\."` should print nothing.
- **Stack**: Electron + `node:sqlite` (built in, no native modules), plain HTML/CSS/JS in the renderer, no bundler, no runtime dependencies. Dev dependencies only: `electron`, `electron-builder`.
- **Layout**
  - `app/main/service.js` — schema, migrations, change detection, drift, backups. Pure Node, unit-tested, no Electron imports.
  - `app/main/main.js` — window, IPC allow-list, file dialogs, PDF.
  - `app/shared/compare.js`, `app/shared/types.js` — equality rules and field-type parsing/validation, shared by main and renderer. A new field type means: add it to `KINDS`, `parse`, and (if it is a single number) `NUMERIC`; the entry box lives in `entry.js` `input()`.
  - `app/main/template.js` — Excel form templates: export, parse, plan (diff), apply. `app/main/export.js` holds the dependency-free xlsx writer and reader.
  - `app/main/profiles.js` — one database per job.
  - `app/renderer/` — one file per tab in `js/`.
- **Rules that must not drift** (see `docs/SPEC.md` §4): readings never count as changes; blanks are ignored (carry-forward); equality is numeric-aware and text-normalized; entries are append-only (a wrong entry is voided with a reason, never deleted or overwritten); notes edits, voids and part renames are audit-logged.
- **Imports never touch stored entries.** Anything that changes forms or fields (template import) shows a plan first and backs up before applying.
- **Schema changes**: bump `SCHEMA_VERSION`, add a step in `migrate()`, add a migration test. The app backs up before migrating.
- **Before pushing**: `npm test` and `npm run screenshots` must pass.
- **Releases**: bump `version` in `package.json`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. CI builds `Setup Tracker-X.Y.Z-setup.exe`, `latest.yml` and the `.blockmap`.
