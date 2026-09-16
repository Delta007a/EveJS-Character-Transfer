# Architecture

The Electron main process is the privileged orchestration boundary. A sandboxed renderer communicates through a narrow preload API. `src/core.js` owns testable path detection, bundle/output parsing, remediation mapping, target-reset policy, backup, and report generation. `src/diagnostics.js` opens the source SQLite database read-only using that EveJS runtime's own `better-sqlite3` module.

The accepted engine is an immutable, explicit allowlist under `engine/accepted-r1.6`. Every launch and engine command verifies its SHA256 before spawning a discovered Node executable. The GUI only invokes accepted `export`, `import`, and `portraits` commands; replacement flags are internal and never become user-facing switches. Blueprint companion state is carried in the accepted bundle and verified after import in the same database transaction as the rest of the identity state.

State flows in one direction: select → analyze → target verify → import dry-run → apply DB → validate accepted engine signals → portrait dry-run/apply → mechanical report. A DB-stage failure stops media copy. A later media failure retains DB PASS while reporting portrait FAIL.

Operational artifacts are derived through explicit privacy allowlists. `src/support-report.js` constructs a two-entry ZIP without directory traversal. `src/history.js` atomically stores at most 50 sanitized transfer-attempt records and defensively discards corrupt input. `src/update-checker.js` talks only to the pinned GitHub Releases endpoint and never downloads or executes release assets.

Prepare backups carry an app-owned manifest with the accepted engine identity, a digest of the exact target path, a stable target-release identity digest, and fingerprints for every reset-scope preimage. Undo revalidates all of that before touching the target, restores only the six reset scopes, retains recovery material, and consumes the manifest after verified restoration. Database apply immediately blocks Undo in-session; only full mechanical Transfer success marks the retained manifest `TRANSFER_APPLIED` and makes explicit cleanup eligible.

Process diagnostics are presentation-only. Classifiers use source-proven custody relations: Industry location 2003 plus a matching live job; market escrow range 9.2B plus derived order ID; contract escrow 9.3B plus a matching active `contractRuntime` record; mission reward settlement custody 9.5B plus a matching settlement. Unknown locations remain unresolved blockers.
