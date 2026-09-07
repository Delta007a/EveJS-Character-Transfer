# EveJS Character Transfer v0.1.3 implementation report

## r1.6 / v0.1.3 changes

- Added authoritative selected-blueprint companion-state export/import and semantic post-import verification.
- Preserved blueprint ME/TE, original/copy identity, and copy runs; missing original state safely defaults to ME 0 / TE 0 / unlimited runs.
- Hard-blocked active-job custody, missing copy state, and inconsistent blueprint state rather than guessing.
- Added GUI blueprint summary evidence and human-readable remediation for every r1.6 blueprint blocker.
- Added a dedicated 33-assertion blueprint verifier while retaining all F01–F14 GUI behavior.

## Earlier final-pass behavior retained

- Rebranded the public product, window, package, report, and Windows build identity.
- Built a seven-frame Windows icon from the supplied `assets/icon-source.png` artwork (16, 24, 32, 48, 64, 128, and 256 px).
- Preserved same-session pristine-target provenance through first initialization while clearing it on target path change.
- Corrected historical release detection so internal server version `0.0.1` is never presented as the EveJS release; root metadata is authoritative and folder-only fallback is labeled.
- Combined source currency, source support, blocking findings, and target verification into one Review readiness decision used by both UI and main-process enforcement.
- Made missing source portrait media informational and cleanly skippable.
- Enforced EveJS 0.12.5 as the minimum transfer source with no bypass; older/unknown sources remain analyzable.
- Split pristine SetupEveJS guidance from already-configured target reinitialization guidance.

## Delivered

- Electron main/preload/vanilla renderer stepper with native folder pickers.
- Root/version/gameStore detection and best-effort Windows process state.
- Accepted r1.6 engine child-process orchestration with launch-time and per-command SHA verification.
- App-owned temporary export, aggregate bundle rendering, portrait dry-run, and cleanup.
- Friendly blocker, warning, deferred, and target-compatibility cards.
- Read-only proof-gated Industry, market, contract, mission-settlement, and active-mission diagnostics.
- Guarded fresh-target preparation with timestamped app-local backups and scoped removal.
- Target verification, accepted import dry-run, apply gating, DB/media stage separation, logs, and Markdown report export.
- Portable Windows x64 executable.

## Build

v0.1.3 is delivered as `dist/EveJS-Character-Transfer.exe`, with matching source archive and `SHA256SUMS.txt`.

## Known limitations

- A compatible Node executable must be available in a selected EveJS root or on PATH; the GUI reports a blocker when absent.
- Windows process detection is best-effort. Unknown state requires explicit stopped confirmation before destructive work.
- Targets not prepared by the GUI require explicit fresh/disposable confirmation. v0.1 does not attempt to merge or remap lived-in state.
- Only process custody relations proven from EveJS 0.12.7 source/schema are classified; unknown relationships remain raw-ID blockers.
- Player structures/world runtime and launcher portrait cache repair remain out of scope.
- Mechanical success never establishes gameplay PASS.
- A visual launch smoke was not automated because running a newly built desktop executable requires a separate action-time confirmation; source, archive, engine-path, syntax, and packaging checks passed.

## Safety confirmation

The accepted r1.5 engine stayed byte-identical while r1.6 was developed in isolation. No accepted-source `runs` directory was read or copied during this implementation, and all real/generated migration bundles are excluded from fixtures, source, build, and release archives. Development analysis used only application-owned temporary storage and cleaned its temporary smoke bundle. Gameplay runtimes remained read-only.
