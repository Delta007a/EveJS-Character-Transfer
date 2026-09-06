# Build instructions

Requirements: Windows 10/11 x64 and Node.js/npm. Network access is needed only if dependencies are not already installed.

```powershell
npm ci
npm test
npm run verify:engine
npm run build
```

The portable artifact is exactly `dist/EveJS-Character-Transfer.exe`. The Windows executable name, ProductName, file description, window title, and application icon use the EveJS Character Transfer identity.

The distributable source archive is `dist/EveJS-Character-Transfer-Source-v0.1.2.zip`. It contains the source corresponding to the executable and excludes `node_modules`, `dist`, all `runs` trees, migration bundles, SQLite databases, backups, portraits/gameStore data, Node runtimes, temporary files, and user data.

The build allowlist contains GUI source, documentation, supplied icon assets, and only `engine/accepted-r1.5`. That engine directory contains source, verifier scripts, checksums, and required documentation only. The accepted source package's `runs` tree is not read during build or verification.

At runtime the utility discovers a Node executable from the selected EveJS roots or `PATH`. Missing Node is shown as an actionable blocker.
