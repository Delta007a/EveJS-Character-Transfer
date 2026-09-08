"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../src/core");
const storage = require("../src/storage");

function tempRoot(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); }
function targetFixture(root, label) {
  const target = path.join(root, label);
  const gameStore = path.join(target, "_local", "gameStore");
  fs.mkdirSync(path.join(gameStore, "data", "nested"), { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ version: "0.12.7.1" }));
  fs.writeFileSync(path.join(gameStore, "gamestore.sqlite"), `db-${label}`);
  fs.writeFileSync(path.join(gameStore, "manifest.json"), "{}");
  fs.writeFileSync(path.join(gameStore, "data", "nested", "state.json"), `state-${label}`);
  return target;
}
function prepare(root, backups, label, finalName) {
  const target = targetFixture(root, label);
  const result = core.prepareFreshTarget({ sourceRoot: path.join(root, "source"), targetRoot: target, backupRoot: backups, runningState: "stopped", confirmUnknown: false });
  const renamed = path.join(backups, finalName);
  fs.renameSync(result.backupDir, renamed);
  return { target, backupDir: renamed };
}

test("packaged portable data root resolves beside the actual portable launcher and ignores dev override/AppData", () => {
  const env = { PORTABLE_EXECUTABLE_FILE: "G:\\Tools\\EveJS-Character-Transfer-v0.2.0\\EveJS-Character-Transfer.exe", EVEJS_TRANSFER_DATA_ROOT: "C:\\Users\\user\\AppData\\Roaming\\override", APPDATA: "C:\\Users\\user\\AppData\\Roaming" };
  assert.equal(storage.resolveDataRoot({ isPackaged: true, execPath: "C:\\Temp\\portable-extract\\app.exe", env }), path.resolve("G:\\Tools\\EveJS-Character-Transfer-v0.2.0\\data"));
  assert.equal(storage.resolveDataRoot({ isPackaged: true, execPath: "G:\\Portable\\EveJS-Character-Transfer.exe", env: {} }), path.resolve("G:\\Portable\\data"));
});

test("development/test override is deliberate and never touches the developer AppData", () => {
  const root = tempRoot("eve-storage-dev");
  const appData = path.join(root, "AppData", "Roaming", "evejs-character-transfer");
  const override = path.join(root, "test-data");
  try {
    fs.mkdirSync(appData, { recursive: true });
    const legacy = path.join(appData, "legacy-backup.keep");
    fs.writeFileSync(legacy, "legacy-data-must-remain-untouched");
    const dataRoot = storage.resolveDataRoot({ isPackaged: false, execPath: process.execPath, env: { EVEJS_TRANSFER_DATA_ROOT: override, APPDATA: appData } });
    storage.ensureWritable(storage.pathsFor(dataRoot));
    assert.equal(dataRoot, path.resolve(override));
    assert.equal(fs.readFileSync(legacy, "utf8"), "legacy-data-must-remain-untouched");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unwritable portable root fails clearly with exact intended path and no fallback", () => {
  const intended = path.resolve("G:\\Protected\\Tool\\data");
  const fakeFs = { mkdirSync() { const error = new Error("access denied"); error.code = "EACCES"; throw error; }, rmSync() {} };
  assert.throws(() => storage.ensureWritable(storage.pathsFor(intended), { fsImpl: fakeFs, token: "fixed" }), (error) => error.code === "PORTABLE_DATA_UNWRITABLE" && error.message.includes(intended) && /Move or extract/.test(error.message));
});

test("backup-size calculation and formatting cover the actual Prepare scopes", () => {
  const root = tempRoot("eve-storage-size");
  try {
    const target = targetFixture(root, "target");
    const scopes = core.targetResetPlan(target).remove;
    const expected = Buffer.byteLength("db-target") + Buffer.byteLength("{}") + Buffer.byteLength("state-target");
    assert.equal(storage.measurePaths(scopes), expected);
    assert.equal(storage.formatBytes(0), "0 B");
    assert.equal(storage.formatBytes(1024), "1.00 KB");
    assert.equal(storage.formatBytes(3 * 1024 ** 3), "3.00 GB");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("insufficient space blocks only when available space is known and provably too small", () => {
  assert.equal(storage.backupSpaceStatus(101, 100).insufficient, true);
  assert.equal(storage.backupSpaceStatus(100, 100).insufficient, false);
  assert.equal(storage.backupSpaceStatus(101, null).insufficient, false);
});

test("completed backup deletion is manifest/fingerprint bounded; recovery and foreign data survive", () => {
  const root = tempRoot("eve-storage-clean-one");
  const backups = path.join(root, "data", "backups");
  fs.mkdirSync(backups, { recursive: true });
  try {
    const recovery = prepare(root, backups, "recovery", "target-before-prepare-2026-09-08T01-00-00-000Z");
    const completed = prepare(root, backups, "completed", "target-before-prepare-2026-09-08T01-00-01-000Z");
    core.markPrepareTransferApplied(completed.backupDir);
    const unknown = prepare(root, backups, "unknown", "target-before-prepare-2026-09-08T01-00-02-000Z");
    const unknownManifest = path.join(unknown.backupDir, core.PREPARE_MANIFEST);
    const unknownData = JSON.parse(fs.readFileSync(unknownManifest, "utf8"));
    unknownData.status = "UNKNOWN";
    fs.writeFileSync(unknownManifest, JSON.stringify(unknownData));
    const foreign = path.join(backups, "foreign-directory");
    fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, "keep.txt"), "keep");

    assert.throws(() => storage.deleteCompletedBackup(backups, recovery.backupDir), /Undo-eligible, failed, unknown/);
    assert.throws(() => storage.deleteCompletedBackup(backups, unknown.backupDir), /failed, unknown/);
    const deleted = storage.deleteCompletedBackup(backups, completed.backupDir);
    assert.ok(deleted.bytes > 0);
    assert.equal(fs.existsSync(completed.backupDir), false);
    assert.equal(fs.existsSync(recovery.backupDir), true);
    assert.equal(fs.existsSync(unknown.backupDir), true);
    assert.equal(fs.existsSync(foreign), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bulk cleanup deletes only valid completed v0.2.0 backups", () => {
  const root = tempRoot("eve-storage-clean-bulk");
  const backups = path.join(root, "backups");
  fs.mkdirSync(backups, { recursive: true });
  try {
    const one = prepare(root, backups, "one", "target-before-prepare-2026-09-08T02-00-00-000Z");
    const two = prepare(root, backups, "two", "target-before-prepare-2026-09-08T02-00-01-000Z");
    const recovery = prepare(root, backups, "three", "target-before-prepare-2026-09-08T02-00-02-000Z");
    core.markPrepareTransferApplied(one.backupDir);
    core.markPrepareTransferApplied(two.backupDir);
    fs.rmSync(path.join(two.backupDir, "data", "nested", "state.json"));
    const invalid = path.join(backups, "target-before-prepare-2026-09-08T02-00-03-000Z");
    fs.mkdirSync(invalid); fs.writeFileSync(path.join(invalid, core.PREPARE_MANIFEST), "not json");
    const result = storage.cleanCompletedBackups(backups);
    assert.equal(result.deleted.length, 1);
    assert.equal(fs.existsSync(one.backupDir), false);
    assert.equal(fs.existsSync(two.backupDir), true);
    assert.equal(fs.existsSync(recovery.backupDir), true);
    assert.equal(fs.existsSync(invalid), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stale run cleanup removes only manifest-owned inactive runs", () => {
  const root = tempRoot("eve-storage-runs");
  const runs = path.join(root, "runs");
  fs.mkdirSync(runs);
  try {
    const stale = storage.createOwnedRun(runs, "old-session", { id: "11111111-1111-4111-8111-111111111111" });
    const active = storage.createOwnedRun(runs, "current-session", { id: "22222222-2222-4222-8222-222222222222" });
    const foreign = path.join(runs, "foreign"); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, "keep"), "keep");
    const result = storage.cleanupStaleRuns(runs, { active: [active] });
    assert.deepEqual(result.deleted, [stale]);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(active), true);
    assert.equal(fs.existsSync(foreign), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("log cleanup removes only owned log names older than 30 days", () => {
  const root = tempRoot("eve-storage-logs");
  try {
    for (const name of ["transfer-2026-07-01.jsonl", "transfer-2026-08-20.jsonl", "notes.txt"]) fs.writeFileSync(path.join(root, name), name);
    storage.cleanupLogs(root, { now: Date.parse("2026-09-08T12:00:00Z"), retentionDays: 30 });
    assert.equal(fs.existsSync(path.join(root, "transfer-2026-07-01.jsonl")), false);
    assert.equal(fs.existsSync(path.join(root, "transfer-2026-08-20.jsonl")), true);
    assert.equal(fs.existsSync(path.join(root, "notes.txt")), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("GUI exposes storage paths via textContent and retains successful Transfer backups", () => {
  const root = path.join(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");
  assert.doesNotMatch(main, /getPath\(["']userData["']\)/);
  assert.match(renderer, /backupLocation\"\)\.textContent/);
  assert.match(renderer, /currentBackupPath\"\)\.textContent/);
  assert.doesNotMatch(renderer, /backupLocation\"\)\.innerHTML/);
  assert.ok(main.indexOf("core.markPrepareTransferApplied") > main.indexOf("portrait-apply"));
  assert.doesNotMatch(main, /rmSync\([^\n]*prepareBackupDir/);
});
