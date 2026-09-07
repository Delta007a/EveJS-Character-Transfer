# EveJS Character Transfer v0.1.3

EveJS Character Transfer is a local Windows utility for moving supported character identity state between EveJS installations. It orchestrates the accepted EveJS Private Identity Transfer r1.6 engine through a guarded source-analysis, target-preparation, dry-run, transfer, and verification workflow.

## Supported sources

- EveJS 0.12.5 and newer: Analyze and Transfer.
- EveJS versions older than 0.12.5: Analyze only. Transfer is hard-blocked.
- Unknown release version: Analyze only. Transfer is hard-blocked.

Historical `server/package.json` value `0.0.1` is internal package metadata, not an EveJS release version. Root release metadata is preferred; a version recovered only from the selected folder name is visibly labeled `folder-name fallback`.

Character portrait media is optional. A missing `_local/gameStore/images/Character` directory produces an informational result with zero files and skips the portrait stage; it does not invalidate database analysis.

## Safety contract

- The accepted r1.6 engine is byte-pinned to SHA256 `84BFD06394300251192DA979A56B9C0B26F480C83D761101DD6A3813373C1F95`.
- Selected blueprint companion state is transferred with validated ME, TE, original/copy identity, and copy runs; active or inconsistent blueprint state is shown as a human-readable blocker.
- The GUI does not change migration semantics, broaden scope, migrate player structures/world state, merge dirty worlds, remap IDs, auto-rehome items, or bypass blockers.
- Prepare backs up and removes only generated target gameStore state listed in the UI. `content-packs`, non-Character images, code, and config are preserved.
- Analysis is read-only. Apply/reset require stopped servers or explicit confirmation when process detection is unknown.
- Temporary bundles are created only below the application's own user-data `runs` directory and are cleaned after success and on exit.
- The accepted engine source package's `runs` directory is never inspected, copied, packaged, or used as fixture data. `private-state-*.json` and generated migration `.sha256` bundles are excluded.
- Gameplay PASS is never inferred from mechanical checks.

## Run from source

```powershell
npm ci
npm test
npm start
```

See [Build instructions](docs/BUILD.md), [Architecture](docs/ARCHITECTURE.md), and the [Blocker catalog](docs/BLOCKERS.md).
