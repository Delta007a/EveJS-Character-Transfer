# Update policy

App v0.2.0 keeps the portable Windows EXE execution model but distributes it inside a versioned ZIP folder so writable adjacent `data` storage is obvious. Its updater is deliberately limited to checking the latest stable public release from the pinned `Delta007a/EveJS-Character-Transfer` GitHub repository and opening that repository's fixed latest-release page.

The application does not download, replace, or execute binaries. Network errors are informational and never affect migration readiness or execution. Drafts, prereleases, malformed tags, and release URLs outside the pinned repository are rejected.

True in-app self-update is not enabled because Electron Builder documents Windows automatic updating for NSIS targets, while the portable target is a manual-update format. A future move to a signed NSIS distribution would require a separately designed migration path, update metadata, Authenticode policy, and installed-app testing.
