"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../src/core");

function fixtureRuntime(root, version = "0.12.7") {
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.mkdirSync(path.join(root, "_local", "gameStore", "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "_local", "gameStore", "content-packs"), { recursive: true });
  fs.mkdirSync(path.join(root, "_local", "gameStore", "images", "Character"), { recursive: true });
  fs.mkdirSync(path.join(root, "_local", "gameStore", "images", "Ship"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "_local", "gameStore", "gamestore.sqlite"), "fixture");
  fs.writeFileSync(path.join(root, "_local", "gameStore", "manifest.json"), "{}");
}

test("root and version detection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evegui-detect-"));
  try { fixtureRuntime(dir); const got = core.detectRuntime(dir); assert.equal(got.recognized, true); assert.equal(got.version, "0.12.7"); assert.equal(got.contentPacks, true); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("source equals target blocks case-insensitively", () => {
  assert.equal(core.samePath("C:\\EveJS\\Server", "c:\\evejs\\server\\"), true);
  const runtime = { recognized: true, sqlite: true, root: "C:\\EveJS" };
  assert.ok(core.validatePair(runtime, { ...runtime, root: "c:\\evejs\\" }).some((x) => x.code === "SOURCE_EQUALS_TARGET"));
});

test("bundle summary parsing", () => {
  const summary = core.summarizeBundle({ source: { version: "0.12.7" }, selected: { accountIDs: [1], characterIDs: [2,3], corporationIDs: [4], allianceIDs: [], itemIDs: [5,6,7] }, rows: { walletAuthorityState: [{}, {}], mailMessages: [{}] }, warnings: [{}], deferred: { playerStructures: [{}], corporationOffices: [{}], items: [{}, {}] } });
  assert.deepEqual(summary, { sourceVersion: "0.12.7", accounts: 1, characters: 2, corporations: 1, alliances: 0, items: 3, mail: 0, walletAuthority: 2, blueprintState: 0, researchedBlueprints: 0, blueprintCopies: 0, deferredBlueprintState: 0, blockedBlueprintState: 0, engineFindings: 1, deferredStructures: 1, deferredOffices: 1, deferredItems: 2 });
});

test("all accepted warning codes have human remediation", () => {
  for (const code of ["CHARACTER_ACTIVE_SHIP_DEFERRED","CHARACTER_IN_PLAYER_STRUCTURE","CHARACTER_NON_STATIC_STATION","CORPORATION_HQ_NON_STATIC","NON_STATIC_CORP_OFFICE_SKIPPED","EXTERNAL_ITEM_LOCATIONS"]) {
    const [card] = core.warningCard({ code, severity: "blocking", itemID: 9 });
    assert.equal(card.class, "BLOCKER"); assert.ok(card.title); assert.ok(card.why); assert.ok(card.fix.length); assert.equal(card.affected.itemID, 9);
  }
});

test("target warning remediation and deferred structure UX", () => {
  const [target] = core.warningCard({ code: "TARGET_CHARACTER_STATION_MISSING", severity: "blocking" });
  assert.equal(target.class, "BLOCKER"); assert.match(target.fix[0], /reinitialize/i);
  const cards = core.deferredCards({ deferred: { playerStructures: [{ structureID: 44, name: "Astrahus" }], items: [{ itemID: 1, locationID: 44 }] } });
  assert.equal(cards[0].class, "DEFERRED"); assert.equal(cards[0].nestedItems, 1); assert.match(cards[0].why, /Nothing is silently/);
});

test("portrait dry-run parsing", () => {
  assert.deepEqual(core.parsePortraitOutput("Characters with portrait media: 29\nCharacters without portrait media: 4\nPortrait files selected: 174\nPORTRAIT_DRY_RUN_OK"), { charactersWithMedia: 29, charactersWithoutMedia: 4, files: 174, ok: true });
});

test("target reset preserves content-packs and non-Character media", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evegui-reset-"));
  const source = path.join(temp, "source"), target = path.join(temp, "target"), backups = path.join(temp, "backups");
  try {
    fixtureRuntime(source); fixtureRuntime(target, "0.12.7.1");
    fs.writeFileSync(path.join(target, "_local", "gameStore", "content-packs", "keep.pack"), "keep");
    fs.writeFileSync(path.join(target, "_local", "gameStore", "images", "Ship", "keep.jpg"), "keep");
    fs.writeFileSync(path.join(target, "_local", "gameStore", "images", "Character", "old.jpg"), "old");
    const got = core.prepareFreshTarget({ sourceRoot: source, targetRoot: target, backupRoot: backups, runningState: "stopped", confirmUnknown: false });
    assert.equal(fs.existsSync(path.join(target, "_local", "gameStore", "gamestore.sqlite")), false);
    assert.equal(fs.readFileSync(path.join(target, "_local", "gameStore", "content-packs", "keep.pack"), "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(target, "_local", "gameStore", "images", "Ship", "keep.jpg"), "utf8"), "keep");
    assert.equal(fs.existsSync(path.join(got.backupDir, "gamestore.sqlite")), true);
    assert.equal(fs.existsSync(path.join(got.backupDir, "data")), true);
    assert.equal(fs.existsSync(path.join(got.backupDir, core.PREPARE_MANIFEST)), true);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("reset rejects same target and unknown status without confirmation", () => {
  assert.throws(() => core.prepareFreshTarget({ sourceRoot: "C:\\x", targetRoot: "c:\\x", backupRoot: os.tmpdir(), runningState: "stopped" }), /different/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evegui-unknown-running-"));
  const target = path.join(temp, "target");
  try { fixtureRuntime(target); assert.throws(() => core.prepareFreshTarget({ sourceRoot: path.join(temp, "source"), targetRoot: target, backupRoot: path.join(temp, "backups"), runningState: "unknown", confirmUnknown: false }), /confirmation/); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("report separates DB/media and never claims gameplay PASS", () => {
  const report = core.reportMarkdown({ mechanical: { dbImport: "PASS", portraits: "FAIL" }, summary: {} });
  assert.match(report, /DB import \| PASS/); assert.match(report, /Portrait copy \| FAIL/); assert.match(report, /Gameplay verification \| REQUIRED/); assert.doesNotMatch(report, /Gameplay verification \| PASS/);
});

test("no ignore-blocker bypass is present", () => {
  const root = path.join(__dirname, "..");
  const text = ["src/main.js", "src/preload.js", "src/renderer/index.html", "src/renderer/renderer.js"].map((p) => fs.readFileSync(path.join(root, p), "utf8")).join("\n");
  assert.doesNotMatch(text, /ignore blocker|ignore-blocker/i);
});
