"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../src/core");

function runtime(root, label = "fixture") {
  const gameStore = path.join(root, "_local", "gameStore");
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.mkdirSync(path.join(gameStore, "data", "nested"), { recursive: true });
  fs.mkdirSync(path.join(gameStore, "content-packs"), { recursive: true });
  fs.mkdirSync(path.join(gameStore, "images", "Character"), { recursive: true });
  fs.mkdirSync(path.join(gameStore, "images", "Ship"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "package.json"), JSON.stringify({ name: "evejs", version: "0.12.7.1" }));
  fs.writeFileSync(path.join(root, "SetupEveJS.bat"), "@echo off\r\n");
  fs.writeFileSync(path.join(root, "unrelated.txt"), `unrelated-${label}`);
  fs.writeFileSync(path.join(gameStore, "gamestore.sqlite"), `db-${label}`);
  fs.writeFileSync(path.join(gameStore, "gamestore.sqlite-wal"), `wal-${label}`);
  fs.writeFileSync(path.join(gameStore, "gamestore.sqlite-shm"), `shm-${label}`);
  fs.writeFileSync(path.join(gameStore, "manifest.json"), JSON.stringify({ label }));
  fs.writeFileSync(path.join(gameStore, "data", "nested", "state.json"), `private-state-${label}`);
  fs.writeFileSync(path.join(gameStore, "content-packs", "keep.pack"), `pack-${label}`);
  fs.writeFileSync(path.join(gameStore, "images", "Character", "portrait.jpg"), `portrait-${label}`);
  fs.writeFileSync(path.join(gameStore, "images", "Ship", "keep.jpg"), `ship-${label}`);
}

function prepareCase(root, name) {
  const source = path.join(root, `${name}-source`);
  const target = path.join(root, `${name}-target`);
  const backups = path.join(root, `${name}-backups`);
  runtime(source, `${name}-source`);
  runtime(target, name);
  const result = core.prepareFreshTarget({ sourceRoot: source, targetRoot: target, backupRoot: backups, runningState: "stopped", confirmUnknown: false });
  return { source, target, backups, result };
}

test("Undo Prepare restores the exact preimage and preserves unrelated/content-pack files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-undo-exact-"));
  try {
    const source = path.join(root, "source"), target = path.join(root, "target"), backups = path.join(root, "backups");
    runtime(source, "source"); runtime(target, "target");
    const sourceBefore = core.fingerprintPath(source);
    const targetBefore = core.fingerprintPath(target);
    const packBefore = core.sha256(path.join(target, "_local", "gameStore", "content-packs", "keep.pack"));
    const shipBefore = core.sha256(path.join(target, "_local", "gameStore", "images", "Ship", "keep.jpg"));
    const prepared = core.prepareFreshTarget({ sourceRoot: source, targetRoot: target, backupRoot: backups, runningState: "stopped", confirmUnknown: false });
    for (const removed of core.targetResetPlan(target).remove) assert.equal(fs.existsSync(removed), false);
    assert.equal(core.sha256(path.join(target, "_local", "gameStore", "content-packs", "keep.pack")), packBefore);
    assert.equal(core.sha256(path.join(target, "_local", "gameStore", "images", "Ship", "keep.jpg")), shipBefore);
    const undone = core.undoPrepare({ targetRoot: target, backupDir: prepared.backupDir, backupRoot: backups, runningState: "stopped", confirmUnknown: false });
    assert.equal(undone.status, "UNDONE");
    assert.equal(undone.backupRetained, true);
    assert.deepEqual(core.fingerprintPath(target), targetBefore);
    assert.deepEqual(core.fingerprintPath(source), sourceBefore);
    assert.equal(fs.existsSync(prepared.backupDir), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Undo Prepare hard-blocks wrong target, missing manifest, incomplete backup, and altered metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-undo-reject-"));
  try {
    const wrong = prepareCase(root, "wrong");
    const other = path.join(root, "wrong-other"); runtime(other, "wrong");
    assert.throws(() => core.undoPrepare({ targetRoot: other, backupDir: wrong.result.backupDir, backupRoot: wrong.backups, runningState: "stopped" }), /different target/);

    const missing = prepareCase(root, "missing");
    fs.rmSync(path.join(missing.result.backupDir, core.PREPARE_MANIFEST));
    assert.throws(() => core.undoPrepare({ targetRoot: missing.target, backupDir: missing.result.backupDir, backupRoot: missing.backups, runningState: "stopped" }), /manifest is missing/);

    const incomplete = prepareCase(root, "incomplete");
    fs.rmSync(path.join(incomplete.result.backupDir, "data", "nested", "state.json"));
    assert.throws(() => core.undoPrepare({ targetRoot: incomplete.target, backupDir: incomplete.result.backupDir, backupRoot: incomplete.backups, runningState: "stopped" }), /incomplete or altered/);

    const altered = prepareCase(root, "altered");
    const manifestFile = path.join(altered.result.backupDir, core.PREPARE_MANIFEST);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.targetBinding.pathSha256 = "0".repeat(64);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => core.undoPrepare({ targetRoot: altered.target, backupDir: altered.result.backupDir, backupRoot: altered.backups, runningState: "stopped" }), /different target/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Undo Prepare hard-blocks double undo and a successful Transfer marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-undo-consumed-"));
  try {
    const doubled = prepareCase(root, "double");
    core.undoPrepare({ targetRoot: doubled.target, backupDir: doubled.result.backupDir, backupRoot: doubled.backups, runningState: "stopped" });
    assert.throws(() => core.undoPrepare({ targetRoot: doubled.target, backupDir: doubled.result.backupDir, backupRoot: doubled.backups, runningState: "stopped" }), /already undone/);

    const transferred = prepareCase(root, "transferred");
    core.markPrepareTransferApplied(transferred.result.backupDir);
    assert.throws(() => core.undoPrepare({ targetRoot: transferred.target, backupDir: transferred.result.backupDir, backupRoot: transferred.backups, runningState: "stopped" }), /Transfer successfully applied/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Undo Prepare honors running and unknown process safety", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-undo-process-"));
  try {
    const running = prepareCase(root, "running");
    assert.throws(() => core.undoPrepare({ targetRoot: running.target, backupDir: running.result.backupDir, backupRoot: running.backups, runningState: "running" }), /appears to be running/);
    assert.throws(() => core.undoPrepare({ targetRoot: running.target, backupDir: running.result.backupDir, backupRoot: running.backups, runningState: "unknown", confirmUnknown: false }), /explicit confirmation/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed restore keeps complete recovery material and a reusable PREPARED manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-undo-failure-"));
  const originalCopy = fs.cpSync;
  try {
    const failed = prepareCase(root, "failure");
    fs.cpSync = () => { throw new Error("simulated restore failure"); };
    assert.throws(() => core.undoPrepare({ targetRoot: failed.target, backupDir: failed.result.backupDir, backupRoot: failed.backups, runningState: "stopped" }), /simulated restore failure/);
    fs.cpSync = originalCopy;
    const manifest = JSON.parse(fs.readFileSync(path.join(failed.result.backupDir, core.PREPARE_MANIFEST), "utf8"));
    assert.equal(manifest.status, "PREPARED");
    assert.equal(fs.readFileSync(path.join(failed.result.backupDir, "gamestore.sqlite"), "utf8"), "db-failure");
    assert.equal(fs.readFileSync(path.join(failed.result.backupDir, "data", "nested", "state.json"), "utf8"), "private-state-failure");
  } finally { fs.cpSync = originalCopy; fs.rmSync(root, { recursive: true, force: true }); }
});
