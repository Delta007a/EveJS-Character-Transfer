"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("../src/core");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return path.resolve(process.argv[index + 1]);
}

function snapshot(root) {
  const entries = [];
  const visit = (current, relative = "") => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in local Undo verification: ${relative}`);
    if (stat.isDirectory()) {
      entries.push({ path: (relative || ".").replaceAll("\\", "/"), type: "directory" });
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), relative ? path.join(relative, name) : name);
    } else if (stat.isFile()) entries.push({ path: relative.replaceAll("\\", "/"), type: "file", size: stat.size, sha256: core.sha256(current) });
  };
  visit(root);
  return entries;
}

function snapshotHash(entries) { return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex"); }
function manifestFile(backup) { return path.join(backup, core.PREPARE_MANIFEST); }
function cloneBackupManifest(source, root, name) {
  const target = path.join(root, "failure-fixtures", name);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(manifestFile(source), manifestFile(target), fs.constants.COPYFILE_EXCL);
  return target;
}

const source = arg("source");
const target = arg("target");
const wrongTarget = arg("wrong-target");
const backupRoot = arg("backup-root");
assert.equal(fs.existsSync(source), true, "Source must exist");
assert.equal(fs.existsSync(target), true, "Disposable target must exist");
assert.equal(fs.existsSync(wrongTarget), true, "Wrong-target fixture must exist");
assert.equal(core.samePath(source, target), false);
assert.equal(core.samePath(target, wrongTarget), false);
fs.mkdirSync(backupRoot, { recursive: true });

const sourceBefore = snapshot(source);
const targetBefore = snapshot(target);
const prepared = core.prepareFreshTarget({ sourceRoot: source, targetRoot: target, backupRoot, runningState: "stopped", confirmUnknown: false });
assert.ok(prepared.backupDir, "The disposable target must contain generated state to exercise Undo");
const targetPrepared = snapshot(target);
const beforeMap = new Map(targetBefore.map((entry) => [entry.path, JSON.stringify(entry)]));
const afterMap = new Map(targetPrepared.map((entry) => [entry.path, JSON.stringify(entry)]));
const changed = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter((key) => beforeMap.get(key) !== afterMap.get(key));
const allowedPrefixes = core.targetResetPlan(target).removeRelative.map((relative) => `_local/gameStore/${relative.replaceAll("\\", "/")}`);
assert.ok(changed.length > 0, "Prepare must remove intended generated state");
for (const changedPath of changed) assert.ok(allowedPrefixes.some((prefix) => changedPath === prefix || changedPath.startsWith(`${prefix}/`)), `Unexpected Prepare change: ${changedPath}`);

assert.throws(() => core.undoPrepare({ targetRoot: wrongTarget, backupDir: prepared.backupDir, backupRoot, runningState: "stopped" }), /different target/);

const missing = cloneBackupManifest(prepared.backupDir, backupRoot, "missing-manifest");
fs.rmSync(manifestFile(missing), { force: true });
assert.throws(() => core.undoPrepare({ targetRoot: target, backupDir: missing, backupRoot, runningState: "stopped" }), /manifest is missing/);

const incomplete = cloneBackupManifest(prepared.backupDir, backupRoot, "incomplete-backup");
assert.throws(() => core.undoPrepare({ targetRoot: target, backupDir: incomplete, backupRoot, runningState: "stopped" }), /incomplete or altered/);

const altered = cloneBackupManifest(prepared.backupDir, backupRoot, "altered-metadata");
const alteredManifest = JSON.parse(fs.readFileSync(manifestFile(altered), "utf8"));
alteredManifest.targetBinding.pathSha256 = "0".repeat(64);
fs.writeFileSync(manifestFile(altered), `${JSON.stringify(alteredManifest, null, 2)}\n`);
assert.throws(() => core.undoPrepare({ targetRoot: target, backupDir: altered, backupRoot, runningState: "stopped" }), /different target/);

const transferred = cloneBackupManifest(prepared.backupDir, backupRoot, "transfer-applied");
core.markPrepareTransferApplied(transferred);
assert.throws(() => core.undoPrepare({ targetRoot: target, backupDir: transferred, backupRoot, runningState: "stopped" }), /Transfer successfully applied/);

assert.throws(() => core.undoPrepare({ targetRoot: target, backupDir: prepared.backupDir, backupRoot, runningState: "running" }), /appears to be running/);
assert.throws(() => core.undoPrepare({ targetRoot: target, backupDir: prepared.backupDir, backupRoot, runningState: "unknown", confirmUnknown: false }), /explicit confirmation/);

const backupBeforeFailure = core.fingerprintPath(prepared.backupDir);
const originalCopy = fs.cpSync;
try {
  fs.cpSync = () => { throw new Error("simulated restore failure"); };
  assert.throws(() => core.undoPrepare({ targetRoot: target, backupDir: prepared.backupDir, backupRoot, runningState: "stopped" }), /simulated restore failure/);
} finally { fs.cpSync = originalCopy; }
assert.deepEqual(core.fingerprintPath(prepared.backupDir), backupBeforeFailure, "Failed restore must retain all recovery material");

const undone = core.undoPrepare({ targetRoot: target, backupDir: prepared.backupDir, backupRoot, runningState: "stopped" });
assert.equal(undone.backupRetained, true);
assert.throws(() => core.undoPrepare({ targetRoot: target, backupDir: prepared.backupDir, backupRoot, runningState: "stopped" }), /already undone/);

const targetAfter = snapshot(target);
const sourceAfter = snapshot(source);
assert.deepEqual(targetAfter, targetBefore, "Post-Undo target must match its complete pre-Prepare tree");
assert.deepEqual(sourceAfter, sourceBefore, "Source must remain byte-unchanged");

process.stdout.write(`${JSON.stringify({
  result: "LOCAL_UNDO_VERIFY_PASS",
  sourceFiles: sourceBefore.filter((entry) => entry.type === "file").length,
  sourceTreeSha256: snapshotHash(sourceBefore),
  targetFiles: targetBefore.filter((entry) => entry.type === "file").length,
  targetPreimageSha256: snapshotHash(targetBefore),
  targetPostUndoSha256: snapshotHash(targetAfter),
  prepareChangedEntries: changed.length,
  backupEntries: JSON.parse(fs.readFileSync(manifestFile(prepared.backupDir), "utf8")).entries.length,
  failureCases: ["wrong-target", "missing-manifest", "incomplete-backup", "altered-metadata", "double-undo", "transfer-applied", "running-target", "unknown-process", "restore-failure-retains-backup"],
}, null, 2)}\n`);
