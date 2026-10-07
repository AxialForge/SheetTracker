# Conventions

- **Commits**: short imperative subject, body only when the why isn't obvious. No AI attribution lines (no `Co-Authored-By`, no "generated with"). Commit with the global AxialForge git identity; `git config --local --get-regexp "^user\."` should print nothing.
- **Stack**: Electron + `node:sqlite` (built in, no native modules), plain HTML/CSS/JS in the renderer, no bundler, no runtime dependencies. Dev dependencies only: `electron`, `electron-builder`.
- **Layout**
  - `app/main/service.js` — schema, migrations, change detection, drift, backups. Pure Node, unit-tested, no Electron imports.
  - `app/main/main.js` — window, IPC allow-list, file dialogs, PDF.
  - `app/shared/compare.js` — equality rules shared by main and renderer.
  - `app/renderer/` — one file per tab in `js/`.
- **Rules that must not drift** (see `docs/SPEC.md` §4): readings never count as changes; blanks are ignored (carry-forward); equality is numeric-aware and text-normalized; entries are append-only (a wrong entry is voided with a reason, never deleted or overwritten); notes edits, voids and part renames are audit-logged.
- **Schema changes**: bump `SCHEMA_VERSION`, add a step in `migrate()`, add a migration test. The app backs up before migrating.
- **Before pushing**: `npm test` and `npm run screenshots` must pass.
- **Releases**: bump `version` in `package.json`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. CI builds `Setup Tracker-X.Y.Z-setup.exe`, `latest.yml` and the `.blockmap`.
