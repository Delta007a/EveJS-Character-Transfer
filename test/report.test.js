"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core");

function reportState(overrides = {}) {
  return {
    appVersion: "0.1.3",
    engineSha256: core.ENGINE_SHA256,
    sourceRoot: "C:\\Users\\SecretUser\\EveJS-Source",
    targetRoot: "D:\\Private\\EveJS-Target",
    bundlePath: "C:\\Users\\SecretUser\\private-state-123.json",
    bundleSha256: "b".repeat(64),
    source: { version: "0.12.7", versionSource: "root-package", versionReliable: true },
    target: { version: "0.12.7.1", versionSource: "root-package-lock", versionReliable: true },
    summary: { accounts: 2, characters: 3, corporations: 1, alliances: 1, items: 44, blueprintState: 9, researchedBlueprints: 5, blueprintCopies: 2, mail: 7, walletAuthority: 6 },
    portraits: { charactersWithMedia: 2, charactersWithoutMedia: 1, files: 12, ok: true },
    severity: { blockers: 1, warnings: 1, deferred: 1 },
    cards: [
      { class: "BLOCKER", code: "ACTIVE_INDUSTRY_JOB", affected: { characterName: "Private Pilot", characterID: 90000001 } },
      { class: "WARNING", code: "ACTIVE_MISSION_PROGRESS", technicalDetails: "password=hunter2" },
    ],
    deferred: [{ class: "DEFERRED", name: "Private Astrahus", structureID: 1029384756 }],
    sourceState: "SOURCE_ANALYZED",
    targetPrepared: true,
    preparedConfiguredTarget: true,
    targetVerified: true,
    reviewReady: true,
    mechanical: { dbImport: "PASS", integrity: "PASS", worldIsolation: "PASS", walletAuthority: "PASS", blueprintState: "PASS", portraits: "PASS" },
    finalStatus: "MECHANICAL_PASS_GAMEPLAY_REQUIRED",
    ...overrides,
  };
}

test("migration report exports the complete aggregate and lifecycle allowlist", () => {
  const report = core.reportMarkdown(reportState(), { generatedAt: "2026-09-07T12:34:56.000Z" });
  for (const expected of [
    "Generated: 2026-09-07T12:34:56.000Z",
    "App version: 0.1.3",
    "Engine revision: r1.7",
    core.ENGINE_SHA256,
    "| Source | 0.12.7 | root-package | reliable | SUPPORTED",
    "| Target | 0.12.7.1 | root-package-lock | reliable |",
    "| Accounts | 2 |", "| Characters | 3 |", "| Corporations | 1 |", "| Alliances | 1 |", "| Items | 44 |",
    "| Blueprint companion rows | 9 |", "| Researched blueprints | 5 |", "| Blueprint copies | 2 |",
    "| Mail messages | 7 |", "| Wallet authority rows | 6 |", "| BLOCKER | 1 |", "| WARNING | 1 |", "| DEFERRED | 1 |",
    "ACTIVE_INDUSTRY_JOB", "ACTIVE_MISSION_PROGRESS", "PLAYER_STRUCTURE_DEFERRED",
    "| Prepare | PASS — REINITIALIZATION REQUIRED |", "| Target verification | PASS |", "| Import dry-run | PASS |",
    "| DB import | PASS |", "| DB verification | PASS |", "| World isolation verification | PASS |", "| Wallet verification | PASS |",
    "| Blueprint verification | PASS |", "| Portrait copy | PASS |", "| Final mechanical result | MECHANICAL_PASS_GAMEPLAY_REQUIRED |",
  ]) assert.match(report, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("migration report excludes private and hostile state at every supported stage", () => {
  const forbidden = ["SecretUser", "EveJS-Source", "EveJS-Target", "private-state-123.json", "Private Pilot", "Private Astrahus", "90000001", "1029384756", "hunter2", "password=", "b".repeat(64)];
  const stages = [
    reportState({ targetPrepared: false, targetVerified: false, reviewReady: false, mechanical: {}, finalStatus: "ANALYZED" }),
    reportState({ reviewReady: false, commandResults: [{ stage: "import-dry-run", exitCode: 0 }], mechanical: {}, finalStatus: "TARGET_VERIFIED" }),
    reportState(),
    reportState({ summary: null, portraits: null, severity: { blockers: 1, warnings: 0, deferred: 0 }, cards: [{ class: "BLOCKER", code: "ANALYZE_FAILED", technicalDetails: "C:\\Users\\SecretUser password=hunter2" }], deferred: [], sourceState: "SOURCE_ANALYSIS_BLOCKED", targetPrepared: false, targetVerified: false, reviewReady: false, mechanical: {}, finalStatus: "NOT_STARTED" }),
  ];
  for (const state of stages) {
    const report = core.reportMarkdown(state, { generatedAt: "2026-09-07T00:00:00.000Z" });
    for (const value of forbidden) assert.doesNotMatch(report, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.match(report, /Gameplay verification \| REQUIRED/);
  }
});

test("report data is a detached privacy-safe allowlist", () => {
  const data = core.reportData(reportState(), { generatedAt: "2026-09-07T00:00:00.000Z" });
  assert.deepEqual(Object.keys(data).sort(), ["appVersion", "counts", "engineRevision", "engineSha256", "findings", "generatedAt", "portraits", "source", "stages", "target"].sort());
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /sourceRoot|targetRoot|bundlePath|bundleSha256|affected|technicalDetails|Private|SecretUser/i);
});
