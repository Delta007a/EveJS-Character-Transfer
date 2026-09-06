# EveJS Character Transfer

**Local Character Transfer**  
**EveJS Community Tool**

EveJS Character Transfer is a Windows GUI utility for moving private character and account state between supported EveJS installations. No PowerShell knowledge is required. Analyze treats the Source as read-only, while target preparation is narrowly scoped and backed up before generated target state is removed.

The tool intentionally excludes player structures and world runtime rather than merging or remapping them into a dirty target.

## Compatibility

- **Supported automatic Transfer:** EveJS 0.12.5 and newer.
- **Field-tested:** EveJS 0.12.5 → 0.12.7.1 and EveJS 0.12.7 → 0.12.7.1.
- EveJS versions older than 0.12.5: Analyze only. Transfer is hard-blocked.
- Unknown release version: Analyze only. Transfer is hard-blocked.

“Supported” describes the enforced version policy; “field-tested” identifies the specific source/target paths exercised end to end. It is not a claim of compatibility with every possible customized installation.

Historical `server/package.json` value `0.0.1` is internal package metadata, not an EveJS release version. Root release metadata is preferred; a version recovered only from the selected folder name is visibly labeled `folder-name fallback`.

Character portrait media is optional. A missing `_local/gameStore/images/Character` directory produces an informational result with zero files and skips the portrait stage; it does not invalidate database analysis.

## Quick workflow

1. Select Source and Target.
2. Analyze Source.
3. Resolve blockers.
4. Prepare, initialize, and verify the Target.
5. Run the accepted import dry-run.
6. Transfer.
7. Perform gameplay verification.

## Findings

- **BLOCKER** — automatic Transfer is disabled until the unsafe or unsupported state is resolved.
- **WARNING** — review the condition, but it does not automatically stop Transfer.
- **DEFERRED** — the named state stays on the Source and is intentionally not migrated.

## Classic Character Transfer scope

The accepted workflow transfers private identity state such as accounts, characters, ordinary inventory, skills, wallets, fittings, mail, NPC-station corporation hangars, and available character portraits.

It intentionally excludes:

- player structures;
- inventory rooted in player structures;
- world runtime;
- active unsupported process/runtime state;
- dirty-target merging or ID remapping.

## Safety contract

- The accepted engine is byte-pinned to SHA256 `BC1955281A791F05A733A618717198DA163BDA8BB5063BF80694C85BDF0C3422`.
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

## Disclaimer

Unofficial community tool. Not affiliated with CCP Games. EVE Online and related marks belong to their respective owners.
