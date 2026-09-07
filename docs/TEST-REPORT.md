# Test report

Run date: 2026-09-07 — updated for engine r1.6 / GUI v0.1.3

- JavaScript syntax checks: PASS.
- GUI unit/integration suite: PASS, 33/33, including focused F01–F14 and blueprint presentation regressions.
- Blueprint state verifier: `BLUEPRINT_STATE_VERIFIER_PASS 33`.
- Accepted static verifier: `STATIC_VERIFIER_PASS 20`.
- Accepted structure policy verifier: `STRUCTURE_POLICY_VERIFIER_PASS 19`.
- Accepted wallet verifier: `WALLET_VERIFIER_PASS 13`.
- Accepted portrait verifier: `PORTRAIT_VERIFIER_PASS 14`.
- Accepted r1.6 engine source SHA invariant: PASS, `84BFD06394300251192DA979A56B9C0B26F480C83D761101DD6A3813373C1F95` in source and embedded copy. Accepted r1.5 remains `BC1955281A791F05A733A618717198DA163BDA8BB5063BF80694C85BDF0C3422`.
- Portable Windows x64 build and exact artifact name: PASS (`EveJS-Character-Transfer.exe`).
- Windows identity/icon audit: PASS — ProductName and version are correct; the executable's extracted 32 px icon is pixel-identical to the corresponding supplied ICO frame (zero differences), not Electron's default icon.
- Package exclusion audit: PASS, zero `runs` directories, migration bundles, SQLite/gameStore data, backups, portraits, Node runtimes, temporary files, or user data.
- Real local read-only smoke: PASS — 0.12.7, 83 selected blueprint companion records, 47 researched blueprints, 16 copies, 0 blueprint blockers/deferred rows, and 0 warnings. Known original `9988400001226` retained ME 10 / TE 20 / unlimited runs; known copy `9988400004985` retained ME 10 / TE 12 / 100 runs.
- Read-only field matrix: PASS — 0.12.4.1 unresolved dynamic location remains generic; 0.12.5 retains 2 blockers/2 structures/38 deferred items; 0.12.6 retains proven Industry blocker plus mission warning with resolved entities; 0.12.7 accepted baseline remains unchanged.
- Native ABI reproduction: PASS — 0.12.3.1 source reports ABI 127 against current ABI 137 through a read-only database-open probe.
- Pristine target recognition: PASS — `EveJS-0.12.7.1-gui-test` recognized as `PRISTINE_SETUP_REQUIRED`, with `SetupEveJS.bat` detected.
- F09 same-session pristine provenance persists through initialization for the same target and clears on target path change.
- F10 historical version detection ignores internal `0.0.1`, labels folder-name fallback, and keeps unknown versions analyzable but transfer-blocked.
- F11 Review readiness combines current analysis, supported source version, zero blockers, and verified target.
- F12 missing portrait media produces INFO/zero counts and skips portrait transfer.
- F13 sources below 0.12.5 are Analyze-only with no bypass.
- F14 a prepared configured target receives start-once reinitialization guidance, not SetupEveJS guidance.
- Real-smoke temporary artifact cleanup: PASS.

Coverage includes detection, path equality, engine hash invariance, bundle/portrait parsing, warning remediation, deferred structure UX, reset preservation of content-packs/non-Character images, blocker gating, absence of bypass UI, report generation, and DB/media failure separation. All write-path tests used operating-system temporary fixtures. No reset/import/apply command was run against a gameplay runtime.
