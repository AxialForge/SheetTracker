# Setup checklist for Setup Tracker

- [x] GitHub repo: `AxialForge/SheetTracker`.
- [ ] Git identity: `git config --local --get-regexp "^user\."` prints nothing (global AxialForge identity); commits carry no AI attribution (see `CONVENTIONS.md`).
- [x] `npm test` passes.
- [ ] `npm install && npm start`: the app opens on the dark crimson Dashboard. Settings → Data → *Load sample data* to try it, or *Import a v3 database* to bring over the Python prototype's entries.
- [x] `npm run screenshots` passes (exit code 0).
- [ ] First release: `git tag v0.1.0 && git push origin v0.1.0` (CI builds `Setup Tracker-0.1.0-setup.exe`, `latest.yml`, `.blockmap`).
- [ ] In Settings, point the **backup folder** at a different drive than the data, and check the **photos** folder is covered by your own backups.
