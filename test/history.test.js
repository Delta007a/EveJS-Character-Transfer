"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../src/core");
const history = require("../src/history");

function state(index = 1) {
  return {
    appVersion: "0.1.3", engineSha256: core.ACCEPTED_ENGINE_SHA256,
    sourceRoot: `C:\\Users\\Private${index}\\Source`, targetRoot: "D:\\Secret\\Target", bundlePath: "private-state.json",
    source: { version: "0.12.7", versionSource: "root-package", versionReliable: true }, target: { version: "0.12.7.1", versionSource: "root-package", versionReliable: true },
    summary: { accounts: 1, characters: index, corporations: 1, alliances: 0, items: index * 2, blueprintState: 3, researchedBlueprints: 2, blueprintCopies: 1, mail: 4, walletAuthority: 5 },
    severity: { blockers: 0, warnings: 1, deferred: 2 }, cards: [{ class: "WARNING", code: "ACTIVE_MISSION_PROGRESS", affected: { characterName: `Hidden Pilot ${index}`, characterID: 99000000 + index } }], deferred: [],
    reviewReady: true, targetVerified: true, mechanical: { dbImport: "PASS", integrity: "PASS", worldIsolation: "PASS", walletAuthority: "PASS", blueprintState: "PASS", portraits: "SKIPPED — no source media" }, finalStatus: "MECHANICAL_PASS_GAMEPLAY_REQUIRED",
  };
}

test("history appends atomically and caps at the newest 50 entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-history-cap-"));
  const file = path.join(root, "history.json");
  try {
    for (let i = 1; i <= 55; i += 1) history.appendHistory(file, history.historyEntry(state(i), { generatedAt: `2026-09-${String(Math.min(i, 30)).padStart(2, "0")}T00:00:00.000Z` }));
    const entries = history.readHistory(file);
    assert.equal(entries.length, 50);
    assert.equal(entries[0].counts.characters, 6);
    assert.equal(entries.at(-1).counts.characters, 55);
    assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("corrupt history recovers to an empty list and can be replaced", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-history-corrupt-"));
  const file = path.join(root, "history.json");
  try {
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(history.readHistory(file), []);
    history.appendHistory(file, history.historyEntry(state(), { generatedAt: "2026-09-07T00:00:00.000Z" }));
    assert.equal(history.readHistory(file).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed history writes are contained and cannot throw into migration", () => {
  const fsImpl = { readFileSync() { throw new Error("missing"); }, mkdirSync() {}, writeFileSync() { throw new Error("disk full"); }, rmSync() {} };
  const result = history.appendHistorySafe("X:\\history.json", history.historyEntry(state()), { fsImpl });
  assert.equal(result.ok, false);
});

test("history read and write sanitize private or hostile fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-history-private-"));
  const file = path.join(root, "history.json");
  try {
    const entry = history.historyEntry(state(), { generatedAt: "2026-09-07T00:00:00.000Z" });
    history.appendHistory(file, { ...entry, sourceRoot: "C:\\Users\\Delta", characterName: "Hidden Pilot", credentials: "super-secret-token", counts: { ...entry.counts, rawRows: [{ itemID: 1234 }] } });
    fs.writeFileSync(file, JSON.stringify([{ ...JSON.parse(fs.readFileSync(file, "utf8"))[0], targetPath: "D:\\Secret", technicalDetails: "password=hunter2" }]));
    const serialized = JSON.stringify(history.readHistory(file));
    for (const value of ["Delta", "Hidden Pilot", "super-secret-token", "rawRows", "1234", "targetPath", "Secret", "technicalDetails", "hunter2"]) assert.doesNotMatch(serialized, new RegExp(value, "i"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("clear history leaves a valid empty store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-history-clear-"));
  const file = path.join(root, "history.json");
  try {
    history.appendHistory(file, history.historyEntry(state()));
    assert.equal(history.readHistory(file).length, 1);
    assert.deepEqual(history.clearHistory(file), []);
    assert.deepEqual(history.readHistory(file), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
