# Build instructions

Requirements: Windows 10/11 x64 and Node.js/npm. Network access is needed only if dependencies are not already installed. App v0.2.0 pins Electron 44.2.0; the CI build runtime is pinned to Node.js 22.23.2.

```powershell
npm ci
npm test
npm run verify:engine
npm run build
```

The portable EXE is built once as an intermediate `dist/EveJS-Character-Transfer.exe`. The primary binary release asset is `dist/EveJS-Character-Transfer-v0.2.0.zip`, containing exactly `EveJS-Character-Transfer-v0.2.0/EveJS-Character-Transfer.exe` and `EveJS-Character-Transfer-v0.2.0/README.txt`.

The distributable source archive is `dist/EveJS-Character-Transfer-Source-v0.2.0.zip`. It contains the source corresponding to the executable and excludes `node_modules`, `dist`, all `runs` trees, migration bundles, SQLite databases, backups, portraits/gameStore data, Node runtimes, temporary files, and user data.

The build allowlist contains GUI source, documentation, supplied icon assets, tests/scripts, and only `engine/accepted-r1.6`. That engine directory contains source, verifier scripts, checksums, and required documentation only. No accepted-source `runs` tree is read during build or verification.

At runtime the utility discovers a Node executable from the selected EveJS roots or `PATH`. Missing Node is shown as an actionable blocker.

Pull requests and pushes to `main` run tests and accepted-engine verification. A dependent Windows job performs one portable x64 package build, creates/audits the binary ZIP, and uploads that ZIP as the workflow artifact. Tags matching `v*`, or a manual dispatch naming an existing tag, run the release gate: exact tag/package version match, tests, engine verification, one build, binary and allowlisted source ZIP creation/audit, SHA-256 generation for both ZIPs, and GitHub Release upload. Ordinary CI never publishes a release.
