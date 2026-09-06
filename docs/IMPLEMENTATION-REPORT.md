# EveJS Character Transfer v0.1.2 implementation report

## Final pass changes

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
- Frozen r1.5 engine child-process orchestration with launch-time and per-command SHA verification.
- App-owned temporary export, aggregate bundle rendering, portrait dry-run, and cleanup.
- Friendly blocker, warning, deferred, and target-compatibility cards.
- Read-only proof-gated Industry, market, contract, mission-settlement, and active-mission diagnostics.
- Guarded fresh-target preparation with timestamped app-local backups and scoped removal.
- Target verification, accepted import dry-run, apply gating, DB/media stage separation, logs, and Markdown report export.
- Portable Windows x64 executable.

## Build

v0.1.2 is delivered as `dist/EveJS-Character-Transfer.exe`, with matching source archive and `SHA256SUMS.txt`.

## Known limitations

- A compatible Node executable must be available in a selected EveJS root or on PATH; the GUI reports a blocker when absent.
- Windows process detection is best-effort. Unknown state requires explicit stopped confirmation before destructive work.
- Targets not prepared by the GUI require explicit fresh/disposable confirmation. v0.1 does not attempt to merge or remap lived-in state.
- Only process custody relations proven from EveJS 0.12.7 source/schema are classified; unknown relationships remain raw-ID blockers.
- Player structures/world runtime and launcher portrait cache repair remain out of scope.
- Mechanical success never establishes gameplay PASS.
- A visual launch smoke was not automated because running a newly built desktop executable requires a separate action-time confirmation; source, archive, engine-path, syntax, and packaging checks passed.

## Safety confirmation

The accepted engine stayed byte-identical. The accepted source package `runs` directory was not inspected or copied, and all real/generated migration bundles were excluded from fixtures, source, build, and release archives. Development analysis uses only application-owned temporary storage. Current gameplay runtimes remain read-only; only the named disposable GUI target may be mutated.
