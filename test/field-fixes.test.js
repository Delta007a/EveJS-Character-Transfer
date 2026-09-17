"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../src/core");

function pristineRelease(root) {
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "package.json"), JSON.stringify({ version: "0.12.7.1" }));
  fs.writeFileSync(path.join(root, "SetupEveJS.bat"), "@echo off");
  fs.writeFileSync(path.join(root, "StartServer.bat"), "@echo off");
}

test("F01 native ABI mismatch becomes structured compatibility data", () => {
  const error = "was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.";
  assert.deepEqual(core.parseAbiMismatch(error), { sourceAbi: 127, currentAbi: 137, technicalDetails: error });
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.doesNotMatch(main, /spawnSync\(["']npm|execSync\(["']npm/);
  assert.match(main, /choose-node/);
});

test("F02 source and target changes are independent", () => {
  assert.deepEqual(core.rootChanges("C:\\source-a", "C:\\target-a", "C:\\source-b", "C:\\target-a"), { sourceChanged: true, targetChanged: false });
  assert.deepEqual(core.rootChanges("C:\\source-a", "C:\\target-a", "C:\\source-a", "C:\\target-b"), { sourceChanged: false, targetChanged: true });
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /if \(sourceChanged\) clearSourceAnalysis/);
  assert.match(main, /if \(targetChanged\) clearTargetState/);
});

test("F03 blocker and warning metrics are separate", () => {
  assert.deepEqual(core.analysisSeverity([{ class: "BLOCKER" }, { class: "BLOCKER" }, { class: "WARNING" }], [{ class: "DEFERRED" }]), { blockers: 2, warnings: 1, deferred: 1 });
});

test("F04 known entity names resolve and unknown names remain explicit", () => {
  const known = core.enrichCard({ code: "ACTIVE_INDUSTRY_JOB", affected: { characterID: 1401, typeID: 99, locationID: 2003, jobID: 7 } }, { characters: { "1401": "Test01" }, types: { "99": "Pioneer Blueprint" } });
  assert.deepEqual(known.display.slice(0, 3), [["Character", "Test01 (1401)"], ["Blueprint", "Pioneer Blueprint (99)"], ["Location", "Industry installation"]]);
  const unknown = core.enrichCard({ code: "X", affected: { typeID: 88, locationID: 1234 } }, {});
  assert.match(unknown.display[0][1], /Unknown item type \(88\)/);
  assert.match(unknown.display[1][1], /Unknown dynamic location \(1234\)/);
});

test("F05 mail uses transfer engine message-key semantics", () => {
  const summary = core.summarizeBundle({ rows: { mail: [{ key: `messages${core.US}1` }, { key: `messages${core.US}2` }, { key: `mailboxes${core.US}3` }] }, warnings: [] });
  assert.equal(summary.mail, 2);
});

test("F06 pristine EveJS target is recognized without gameStore", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evegui-pristine-"));
  try { pristineRelease(root); const runtime = core.detectRuntime(root); assert.equal(runtime.recognized, true); assert.equal(runtime.pristine, true); assert.equal(runtime.lifecycle, "PRISTINE_SETUP_REQUIRED"); assert.equal(core.validateTarget(runtime).length, 0); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("F06 preparing an already pristine target is a no-op", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evegui-pristine-prepare-"));
  const target = path.join(temp, "target");
  try { pristineRelease(target); const result = core.prepareFreshTarget({ sourceRoot: path.join(temp, "source"), targetRoot: target, backupRoot: path.join(temp, "backups"), runningState: "unknown", confirmUnknown: false }); assert.equal(result.alreadyPristine, true); assert.equal(result.backupDir, null); assert.equal(fs.existsSync(path.join(target, "SetupEveJS.bat")), true); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("F07 setup script and native setup controls are exposed", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /Run SetupEveJS\.bat/); assert.match(html, /Open Target Folder/); assert.match(html, /EVE client path/);
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /shell\.openPath\(file\)/);
});

test("F08 source validation does not depend on target readiness", () => {
  const source = { recognized: true, version: "0.12.7", sqlite: true };
  assert.equal(core.validateSource(source).length, 0);
  assert.equal(core.validateSource(source, null).length, 0);
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const analyzeBody = main.slice(main.indexOf("async function analyze"), main.indexOf("function verifyTarget"));
  assert.doesNotMatch(analyzeBody, /validateSelection\(\)/);
});

test("engine SHA constant is pinned to r1.7", () => {
  assert.equal(core.ENGINE_SHA256, "a5e41e0a2c246b7ce5ae9d2ef84e21b70c852bf28e70e66b5a9af25545ec4f53");
  assert.equal(core.ENGINE_REVISION, "r1.7");
});
