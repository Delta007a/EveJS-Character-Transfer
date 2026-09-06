# v0.1.1 narrow field-fix status

- F01 — Implemented. Analyze probes candidate Node runtimes by opening the source SQLite read-only. ABI mismatches become a human blocker showing source/current ABI, manual `node.exe` selection, and collapsible technical details. No source rebuild/install path exists.
- F02 — Implemented. Source changes clear the bundle, counts, media analysis, findings, diagnostics, review, transfer readiness, and source-dependent status. Failed Analyze leaves no valid analysis. Target changes preserve Source analysis while clearing target-derived readiness/status.
- F03 — Implemented. Summary shows separate BLOCKERS, WARNINGS, and DEFERRED counts; accepted engine array length is retained only as neutral internal metadata.
- F04 — Implemented. Read-only character, corporation, type, NPC station, solar-system, structure/type, proven Industry job, and proven mission-name resolution. Unknowns are explicit. Raw IDs and native errors are under Technical details with Copy Technical Details.
- F05 — Implemented. Mail Messages counts only accepted-engine `mail` rows under `messages<US>...`.
- F06 — Implemented. Release recognition is independent of generated gameStore. A never-initialized target is `PRISTINE_SETUP_REQUIRED`; Prepare is a non-destructive no-op when generated state is absent.
- F07 — Implemented. Pristine targets show the mandatory SetupEveJS → normal setup → first launch → shutdown → Verify sequence, with Open Target Folder and Run SetupEveJS.bat controls. Setup logic is not emulated.
- F08 — Implemented. Analyze validates Source only and uses an app-owned temporary portrait target. Target may be absent, invalid, or pristine without blocking Source analysis or receiving writes.

No accepted migration behavior or scope changed.
