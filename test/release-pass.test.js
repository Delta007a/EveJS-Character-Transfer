"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../src/core");

function releaseSkeleton(root, { rootVersion, serverVersion = "0.0.1", portraits = true } = {}) {
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.mkdirSync(path.join(root, "_local", "gameStore", "data"), { recursive: true });
  if (portraits) fs.mkdirSync(path.join(root, "_local", "gameStore", "images", "Character"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "package.json"), JSON.stringify({ name: "eve.js", version: serverVersion }));
  if (rootVersion) fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: rootVersion }));
  fs.writeFileSync(path.join(root, "StartServer.bat"), "@echo off");
  fs.writeFileSync(path.join(root, "_local", "gameStore", "gamestore.sqlite"), "fixture");
  fs.writeFileSync(path.join(root, "_local", "gameStore", "manifest.json"), "{}");
}

test("F09 pristine provenance survives initialization for the same target and not a path change", () => {
  assert.equal(core.hasPristineProvenance("C:\\target", "c:\\TARGET\\"), true);
  assert.equal(core.hasPristineProvenance("C:\\target-two", "C:\\target"), false);
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /if \(targetChanged\)[\s\S]*clearTargetState\(\)/);
  assert.match(main, /hasPristineProvenance/);
});

test("F10 ignores internal 0.0.1 and labels legacy folder fallback", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "EveJS-0.12.3.1-test-"));
  const named = path.join(temp, "EveJS-0.12.3.1-test");
  try {
    releaseSkeleton(named);
    const runtime = core.detectRuntime(named);
    assert.equal(runtime.version, "0.12.3.1");
    assert.equal(runtime.versionSource, "folder-name-fallback");
    assert.equal(runtime.versionReliable, false);
    assert.notEqual(runtime.version, "0.0.1");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("F10 unknown legacy version remains analyzable but transfer-blocked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-legacy-unknown-"));
  try {
    releaseSkeleton(root);
    const runtime = core.detectRuntime(root);
    assert.equal(runtime.recognized, true);
    assert.equal(runtime.version, null);
    assert.equal(core.validateSource(runtime).length, 0);
    assert.deepEqual(core.sourceTransferSupport(runtime).supported, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("F11 dry-run readiness combines current analysis, supported source, blockers, and target", () => {
  const base = { bundle: {}, analysisValidFor: "C:\\source", sourceRoot: "c:\\SOURCE\\", source: { version: "0.12.5" }, cards: [], targetVerified: true, reviewReady: false };
  assert.equal(core.reviewReadiness(base).canDryRun, true);
  assert.equal(core.reviewReadiness({ ...base, cards: [{ class: "BLOCKER" }] }).canDryRun, false);
  assert.equal(core.reviewReadiness({ ...base, source: { version: "0.12.4.1" } }).canDryRun, false);
  assert.equal(core.reviewReadiness({ ...base, targetVerified: false }).canDryRun, false);
  assert.equal(core.reviewReadiness({ ...base, reviewReady: true }).ready, true);
});

test("F12 missing portrait directory is optional and skipped", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /PORTRAIT_SOURCE_ABSENT/);
  assert.match(main, /SKIPPED — no source media/);
  assert.match(main, /if \(state\.portraitSourceAvailable\)/);
});

test("F13 minimum source gate is exactly 0.12.5", () => {
  assert.equal(core.sourceTransferSupport({ version: "0.12.4.1" }).supported, false);
  assert.equal(core.sourceTransferSupport({ version: "0.12.5" }).supported, true);
  assert.equal(core.sourceTransferSupport({ version: "0.12.7.1" }).supported, true);
});

test("F14 configured prepared target receives start-once state, not pristine setup state", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  assert.match(main, /TARGET_PREPARED_REINITIALIZATION_REQUIRED/);
  assert.match(main, /preparedConfiguredTarget = !result\.alreadyPristine/);
  assert.match(renderer, /!state\.preparedConfiguredTarget/);
});

test("v0.1.2 branding and exact artifact identity are configured", () => {
  const pkg = require("../package.json");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.equal(pkg.name, "evejs-character-transfer");
  assert.equal(pkg.version, "0.1.2");
  assert.equal(pkg.build.artifactName, "EveJS-Character-Transfer.${ext}");
  assert.match(html, /EVEJS COMMUNITY TOOL/);
  assert.match(html, /Local Character Transfer/);
  assert.match(html, /App v/);
});
