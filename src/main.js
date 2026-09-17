"use strict";

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const core = require("./core");
const storage = require("./storage");
const supportReport = require("./support-report");
const history = require("./history");
const updateChecker = require("./update-checker");
function externalResource(relativePath) {
  return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", relativePath) : path.join(__dirname, "..", relativePath);
}
const ENGINE_DIR = externalResource(path.join("engine", "r1.7"));
const ENGINE = path.join(ENGINE_DIR, "private-identity-transfer.js");
const SESSION_ID = crypto.randomUUID();
const DATA_PATHS = storage.pathsFor(storage.resolveDataRoot({ isPackaged: app.isPackaged, execPath: process.execPath, env: process.env, devRoot: path.join(__dirname, "..", ".dev-data") }));
app.setPath("userData", DATA_PATHS.electron);
let win;
let state = {
  sourceRoot: "", targetRoot: "", source: null, target: null, bundlePath: "", bundleSha256: "", bundle: null,
  summary: null, diagnostics: [], cards: [], deferred: [], portraits: null, targetPrepared: false, targetVerified: false,
  reviewReady: false, engineSha256: "", mechanical: {}, commandResults: [], backupPaths: [], finalStatus: "NOT_STARTED",
  sourceState: "SOURCE_UNSELECTED", targetState: "TARGET_UNSELECTED", analysisMessage: "No valid analysis exists for the currently selected source.",
  analysisValidFor: "", manualNodePath: "", activeNodePath: "", nodeCompatibility: null, resolution: {}, severity: { blockers: 0, warnings: 0, deferred: 0 },
  pristineProvenancePath: "", preparedConfiguredTarget: false, portraitSourceAvailable: false,
  prepareBackupDir: "", transferAppliedSincePrepare: false, undoPrepareStatus: "NOT_AVAILABLE",
  storageInfo: { dataRoot: DATA_PATHS.root, backupLocation: DATA_PATHS.backups, estimatedBackupBytes: 0, estimatedBackupSize: "0 B", freeSpaceBytes: null, freeSpace: "Unavailable", backup: null, completedCleanup: { count: 0, bytes: 0, size: "0 B" } },
  update: { status: "NOT_CHECKED", currentVersion: "", latestVersion: "", releaseNotes: "" },
};

function publicState() {
  const { bundle, bundlePath, prepareBackupDir, ...safe } = state;
  const readiness = core.reviewReadiness(state);
  const canUndoPrepare = Boolean(prepareBackupDir && state.targetPrepared && !state.transferAppliedSincePrepare && state.undoPrepareStatus !== "UNDONE");
  return { ...safe, appVersion: app.getVersion(), hasBundle: Boolean(bundlePath && fs.existsSync(bundlePath)), transferBlocked: transferBlockers().length > 0, canUndoPrepare, readiness };
}

function sendState() { if (win && !win.isDestroyed()) win.webContents.send("state", publicState()); }

function appPaths() { return DATA_PATHS; }

function ensureAppDirs() { return storage.ensureWritable(DATA_PATHS); }

function currentBackupInfo() {
  const backupDir = state.prepareBackupDir || state.backupPaths.at(-1);
  if (!backupDir) return null;
  const info = { path: backupDir, bytes: 0, size: "0 B", status: "UNKNOWN", cleanupAllowed: false };
  if (!fs.existsSync(backupDir)) return { ...info, status: "DELETED" };
  try { info.bytes = storage.measurePath(backupDir); info.size = storage.formatBytes(info.bytes); } catch { info.size = "Unavailable"; }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, core.PREPARE_MANIFEST), "utf8"));
    if (manifest.kind === core.PREPARE_MANIFEST_KIND && manifest.schemaVersion === 1) info.status = String(manifest.status || "UNKNOWN");
  } catch {}
  info.cleanupAllowed = Boolean(storage.validCompletedBackup(DATA_PATHS.backups, backupDir));
  return info;
}

function refreshStorageInfo() {
  let estimatedBackupBytes = 0;
  let estimateError = "";
  if (state.targetRoot) {
    try { estimatedBackupBytes = storage.measurePaths(core.targetResetPlan(state.targetRoot).remove); }
    catch (error) { estimateError = error.message; }
  }
  const freeSpaceBytes = storage.freeSpace(DATA_PATHS.root);
  const candidates = storage.completedBackups(DATA_PATHS.backups);
  const cleanupBytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
  state.storageInfo = {
    dataRoot: DATA_PATHS.root,
    backupLocation: DATA_PATHS.backups,
    estimatedBackupBytes,
    estimatedBackupSize: storage.formatBytes(estimatedBackupBytes),
    estimateError,
    freeSpaceBytes,
    freeSpace: freeSpaceBytes == null ? "Unavailable" : storage.formatBytes(freeSpaceBytes),
    insufficientSpace: storage.backupSpaceStatus(estimatedBackupBytes, freeSpaceBytes).insufficient,
    backup: currentBackupInfo(),
    completedCleanup: { count: candidates.length, bytes: cleanupBytes, size: storage.formatBytes(cleanupBytes) },
  };
  return state.storageInfo;
}

function recordHistory() {
  return history.appendHistorySafe(appPaths().history, history.historyEntry({ ...state, appVersion: app.getVersion() }));
}

function log(event, details = {}) {
  ensureAppDirs();
  const file = path.join(appPaths().logs, `transfer-${new Date().toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), event, sourceRoot: state.sourceRoot, targetRoot: state.targetRoot, sourceVersion: state.source && state.source.version, targetVersion: state.target && state.target.version, engineSha256: state.engineSha256, bundleSha256: state.bundleSha256, ...details })}\n`);
  return file;
}

function nodeCandidates(roots = []) {
  const candidates = [];
  if (state.manualNodePath) candidates.push(state.manualNodePath);
  for (const root of roots.filter(Boolean)) candidates.push(path.join(root, "node.exe"), path.join(root, "server", "node.exe"));
  try {
    const result = cp.spawnSync("where.exe", ["node.exe"], { encoding: "utf8", windowsHide: true });
    candidates.push(...String(result.stdout || "").split(/\r?\n/).filter(Boolean));
  } catch {}
  return [...new Set(candidates.map((candidate) => path.resolve(candidate).toLowerCase()))].filter((candidate) => fs.existsSync(candidate));
}

function probeNode(node, runtimeRoot) {
  const abiResult = cp.spawnSync(node, ["-p", "process.versions.modules"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
  const currentAbi = Number(String(abiResult.stdout || "").trim()) || null;
  const modulePath = [path.join(runtimeRoot, "server", "node_modules", "better-sqlite3"), path.join(runtimeRoot, "node_modules", "better-sqlite3")].find((p) => fs.existsSync(p));
  if (!modulePath) return { compatible: false, nodePath: node, currentAbi, sourceAbi: null, reason: "Source better-sqlite3 was not found.", technicalDetails: "No source better-sqlite3 module directory was detected." };
  const sqlitePath = path.join(runtimeRoot, "_local", "gameStore", "gamestore.sqlite");
  const result = cp.spawnSync(node, ["-e", "const Database=require(process.argv[1]);const db=new Database(process.argv[2],{readonly:true,fileMustExist:true});db.close();", modulePath, sqlitePath], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.status === 0) return { compatible: true, nodePath: node, currentAbi, sourceAbi: currentAbi, reason: "Compatible" };
  const details = String(result.stderr || result.stdout || result.error || "Native module probe failed.");
  const mismatch = core.parseAbiMismatch(details, currentAbi);
  return { compatible: false, nodePath: node, currentAbi, sourceAbi: mismatch && mismatch.sourceAbi, reason: mismatch ? "ABI_MISMATCH" : "NATIVE_MODULE_LOAD_FAILED", technicalDetails: details.trim() };
}

function findCompatibleNode(runtimeRoot) {
  const probes = nodeCandidates([runtimeRoot]).map((node) => probeNode(node, runtimeRoot));
  return { selected: probes.find((probe) => probe.compatible) || null, probes };
}

function assertEngine() {
  if (!fs.existsSync(ENGINE)) throw new Error("Engine r1.7 is missing from the application package.");
  const actual = core.sha256(ENGINE);
  if (actual !== core.ENGINE_SHA256) throw new Error(`Engine r1.7 SHA mismatch. Expected ${core.ENGINE_SHA256}, got ${actual}.`);
  state.engineSha256 = actual;
  return actual;
}

function runEngine(args, stage) {
  assertEngine();
  const runtimeRoot = args.includes("--target-root") && !args.includes("--source-root") ? state.targetRoot : state.sourceRoot;
  const compatibility = findCompatibleNode(runtimeRoot);
  const node = compatibility.selected && compatibility.selected.nodePath;
  if (!node) {
    const mismatch = compatibility.probes.find((probe) => probe.reason === "ABI_MISMATCH");
    const error = new Error(mismatch ? "This EveJS installation uses a native SQLite module built for an older Node.js runtime." : "No compatible Node.js executable was found for this EveJS runtime.");
    error.compatibility = mismatch || compatibility.probes[0] || null;
    throw error;
  }
  state.activeNodePath = node;
  state.nodeCompatibility = compatibility.selected;
  const result = cp.spawnSync(node, [ENGINE, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const record = { stage, exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  state.commandResults.push(record);
  log("engine-command", { stage, exitCode: result.status });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${stage} failed (exit ${result.status}).\n${result.stderr || result.stdout}`);
  return record;
}

function runDiagnostics(bundlePath) {
  const compatibility = findCompatibleNode(state.sourceRoot);
  const node = compatibility.selected && compatibility.selected.nodePath;
  if (!node) return { cards: [{ source: "diagnostic", class: "WARNING", code: "PROCESS_DIAGNOSTICS_UNAVAILABLE", title: "Process-state diagnostic scan unavailable", why: "Node.js executable was not found for the read-only schema classifier.", affected: {}, fix: ["The transfer engine remains authoritative for this operation. Raw external-location blockers still fail closed."] }], resolution: {} };
  const helper = externalResource(path.join("src", "diagnostic-helper.js"));
  const result = cp.spawnSync(node, [helper, state.sourceRoot, bundlePath], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return { cards: [{ source: "diagnostic", class: "WARNING", code: "PROCESS_DIAGNOSTICS_UNAVAILABLE", title: "Process-state diagnostic scan unavailable", why: String(result.stderr || result.stdout || `exit ${result.status}`).trim(), affected: {}, fix: ["The transfer engine remains authoritative for this operation. Raw external-location blockers still fail closed."] }], resolution: {} };
  try { return JSON.parse(result.stdout); } catch { return { cards: [{ source: "diagnostic", class: "WARNING", code: "PROCESS_DIAGNOSTICS_UNAVAILABLE", title: "Process-state diagnostic output was invalid", why: "The classifier returned unreadable output.", affected: {}, fix: ["Raw external-location blockers still fail closed."] }], resolution: {} }; }
}

function transferBlockers() {
  const result = [];
  const readiness = core.reviewReadiness(state);
  if (!readiness.ready) result.push(readiness.message);
  for (const card of state.cards || []) if (Array.isArray(card) ? card.some((c) => c.class === "BLOCKER") : card.class === "BLOCKER") result.push(card.code || "BLOCKER");
  return result;
}

function cleanupBundle({ required = false } = {}) {
  if (!state.bundlePath) return;
  const dir = path.dirname(state.bundlePath);
  try {
    if (fs.existsSync(dir)) storage.removeOwnedRun(DATA_PATHS.runs, dir);
    state.bundlePath = "";
  } catch (error) {
    if (required) throw error;
  }
}

function removeRun(runDir) { if (fs.existsSync(runDir)) storage.removeOwnedRun(DATA_PATHS.runs, runDir); }

function clearSourceAnalysis(message = "No valid analysis exists for the currently selected source.") {
  cleanupBundle();
  Object.assign(state, { bundle: null, bundleSha256: "", summary: null, diagnostics: [], cards: [], deferred: [], portraits: null, portraitSourceAvailable: false, resolution: {}, severity: { blockers: 0, warnings: 0, deferred: 0 }, analysisValidFor: "", reviewReady: false, mechanical: {}, analysisMessage: message });
  if (state.sourceRoot) state.sourceState = state.source && core.validateSource(state.source).length === 0 ? "SOURCE_READY_TO_ANALYZE" : "SOURCE_INVALID";
}

function clearTargetState() {
  Object.assign(state, { targetPrepared: false, targetVerified: false, pristineProvenancePath: "", preparedConfiguredTarget: false, prepareBackupDir: "", transferAppliedSincePrepare: false, undoPrepareStatus: "NOT_AVAILABLE", reviewReady: false, mechanical: {}, finalStatus: state.summary ? "ANALYZED" : "NOT_STARTED" });
  state.targetState = !state.targetRoot ? "TARGET_UNSELECTED" : !state.target || !state.target.recognized ? "TARGET_INVALID" : state.target.pristine ? "TARGET_PRISTINE_SETUP_REQUIRED" : state.target.lifecycle === "UNINITIALIZED" ? "TARGET_SETUP_DONE_NOT_INITIALIZED" : "TARGET_INITIALIZED_UNVERIFIED";
}

async function chooseFolder() {
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Select EveJS server folder" });
  return result.canceled ? null : result.filePaths[0];
}

async function chooseNode() {
  const result = await dialog.showOpenDialog(win, { properties: ["openFile"], title: "Select compatible node.exe", filters: [{ name: "Node.js executable", extensions: ["exe"] }] });
  return result.canceled ? null : result.filePaths[0];
}

function refreshRoots(sourceRoot, targetRoot) {
  const nextSource = sourceRoot === undefined ? state.sourceRoot : sourceRoot;
  const nextTarget = targetRoot === undefined ? state.targetRoot : targetRoot;
  const { sourceChanged, targetChanged } = core.rootChanges(state.sourceRoot, state.targetRoot, nextSource, nextTarget);
  state.sourceRoot = nextSource || "";
  state.targetRoot = nextTarget || "";
  state.source = state.sourceRoot ? core.detectRuntime(state.sourceRoot) : null;
  state.target = state.targetRoot ? core.detectRuntime(state.targetRoot) : null;
  if (state.source) state.source.running = core.detectRunning(state.sourceRoot);
  if (state.target) state.target.running = core.detectRunning(state.targetRoot);
  if (sourceChanged) clearSourceAnalysis();
  if (targetChanged) clearTargetState();
  if (targetChanged && state.target && state.target.pristine) state.pristineProvenancePath = state.targetRoot;
  state.sourceState = !state.sourceRoot ? "SOURCE_UNSELECTED" : core.validateSource(state.source).length ? "SOURCE_INVALID" : state.analysisValidFor && core.samePath(state.analysisValidFor, state.sourceRoot) ? "SOURCE_ANALYZED" : "SOURCE_READY_TO_ANALYZE";
  if (!targetChanged) state.targetState = !state.targetRoot ? "TARGET_UNSELECTED" : !state.target || !state.target.recognized ? "TARGET_INVALID" : state.targetVerified ? "TARGET_VERIFIED" : state.target.pristine ? "TARGET_PRISTINE_SETUP_REQUIRED" : state.target.lifecycle === "UNINITIALIZED" ? "TARGET_SETUP_DONE_NOT_INITIALIZED" : "TARGET_INITIALIZED_UNVERIFIED";
  if (targetChanged) refreshStorageInfo();
  return publicState();
}

function validateSelection() {
  if (!state.source || !state.target) throw new Error("Select both source and target folders.");
  const blockers = core.validatePair(state.source, state.target);
  if (blockers.length) throw new Error(blockers.map((b) => b.message).join("\n"));
}

async function analyze() {
  ensureAppDirs();
  const sourceProblems = core.validateSource(state.source);
  clearSourceAnalysis();
  if (sourceProblems.length) { state.sourceState = "SOURCE_INVALID"; state.analysisMessage = sourceProblems.map((p) => p.message).join(" "); sendState(); return publicState(); }
  const runDir = storage.createOwnedRun(appPaths().runs, SESSION_ID);
  const bundlePath = path.join(runDir, "private-transfer-temporary.json");
  let exported;
  try { exported = runEngine(["export", "--source-root", state.sourceRoot, "--out", bundlePath], "source-export-read-only"); }
  catch (error) {
    removeRun(runDir);
    cleanupBundle();
    state.sourceState = "SOURCE_ANALYSIS_BLOCKED";
    const compatibility = error.compatibility;
    state.cards = [{ class: "BLOCKER", code: "NODE_ABI_INCOMPATIBLE", title: compatibility && compatibility.reason === "ABI_MISMATCH" ? "This EveJS installation uses a native SQLite module built for an older Node.js runtime" : "No compatible Node.js runtime could analyze this source", why: "The source server does not need to be rebuilt or modified. The GUI will not run npm rebuild or npm install against it.", display: [["Source native ABI", compatibility && compatibility.sourceAbi || "Unknown"], ["Current Node ABI", compatibility && compatibility.currentAbi || "Unknown"], ["Node executable", compatibility && compatibility.nodePath || "Not found"]], affected: { sourceAbi: compatibility && compatibility.sourceAbi, currentAbi: compatibility && compatibility.currentAbi, nodePath: compatibility && compatibility.nodePath }, technicalDetails: compatibility && compatibility.technicalDetails || error.message, fix: ["Choose a compatible Node executable below, or install one separately and select its node.exe.", "Do not rebuild or modify the source EveJS runtime.", "Click Scan Again."] }];
    state.severity = core.analysisSeverity(state.cards, []);
    state.analysisMessage = "No valid analysis exists for the currently selected source.";
    sendState(); return publicState();
  }
  if (!/EXPORT_OK/.test(exported.stdout)) { removeRun(runDir); state.sourceState = "SOURCE_ANALYSIS_BLOCKED"; state.analysisMessage = "No valid analysis exists for the currently selected source."; state.cards = [{ class: "BLOCKER", code: "ANALYZE_FAILED", title: "Source analysis could not be completed", why: "Engine r1.7 did not report EXPORT_OK.", technicalDetails: exported.stdout + exported.stderr, fix: ["Open Technical details, correct the source issue, and click Scan Again."] }]; state.severity = core.analysisSeverity(state.cards, []); sendState(); return publicState(); }
  const bundle = core.readJson(bundlePath);
  if (!bundle) { removeRun(runDir); state.sourceState = "SOURCE_ANALYSIS_BLOCKED"; state.analysisMessage = "No valid analysis exists for the currently selected source."; state.cards = [{ class: "BLOCKER", code: "ANALYZE_FAILED", title: "Source analysis could not be completed", why: "Engine r1.7 output bundle could not be read.", technicalDetails: "Temporary output was missing or invalid JSON.", fix: ["Correct the source issue and click Scan Again."] }]; state.severity = core.analysisSeverity(state.cards, []); sendState(); return publicState(); }
  state.bundlePath = bundlePath;
  state.bundleSha256 = core.sha256(bundlePath);
  state.bundle = bundle;
  state.summary = core.summarizeBundle(bundle);
  const diagnosed = runDiagnostics(bundlePath);
  state.diagnostics = diagnosed.cards || [];
  state.resolution = diagnosed.resolution || {};
  state.cards = (bundle.warnings || []).flatMap((warning) => core.warningCard(warning, state.diagnostics));
  state.cards.push(...state.diagnostics.filter((d) => d.source !== "external-item"));
  state.cards = state.cards.map((card) => core.enrichCard(card, state.resolution));
  state.deferred = core.deferredCards(bundle).map((card) => core.enrichCard({ ...card, affected: { structureID: card.structureID, typeID: (bundle.deferred.playerStructures || []).find((s) => Number(s.structureID) === card.structureID)?.typeID } }, state.resolution));
  state.portraitSourceAvailable = Boolean(state.source.portraits);
  if (state.portraitSourceAvailable) {
    const portraitTarget = path.join(runDir, "portrait-target");
    fs.mkdirSync(path.join(portraitTarget, "_local", "gameStore", "images", "Character"), { recursive: true });
    let portrait;
    try { portrait = runEngine(["portraits", "--source-root", state.sourceRoot, "--target-root", portraitTarget, "--in", bundlePath], "portrait-dry-run"); }
    catch (error) { clearSourceAnalysis(); removeRun(runDir); state.sourceState = "SOURCE_ANALYSIS_BLOCKED"; state.analysisMessage = "No valid analysis exists for the currently selected source."; state.cards = [{ class: "BLOCKER", code: "ANALYZE_FAILED", title: "Source analysis could not be completed", why: error.message, technicalDetails: error.stack || error.message, fix: ["Review Technical details, correct the source compatibility issue, and click Scan Again."] }]; state.severity = core.analysisSeverity(state.cards, []); sendState(); return publicState(); }
    fs.rmSync(portraitTarget, { recursive: true, force: true });
    state.portraits = core.parsePortraitOutput(portrait.stdout);
  } else {
    state.portraits = { charactersWithMedia: 0, charactersWithoutMedia: state.summary.characters || 0, files: 0, ok: true, skipped: true };
    state.cards.push({ class: "INFO", code: "PORTRAIT_SOURCE_ABSENT", title: "No source portrait directory", why: "Character portrait media is optional. Database analysis remains valid and portrait transfer will be skipped cleanly.", affected: { expectedPath: path.join(state.sourceRoot, "_local", "gameStore", "images", "Character") }, fix: [] });
  }
  const support = core.sourceTransferSupport(state.source);
  if (!support.supported) state.cards.push({ class: "BLOCKER", code: support.code, title: support.label, why: support.reason, affected: { detectedVersion: state.source.version, versionSource: state.source.versionSource }, fix: ["Use Analyze to inspect this source.", "Transfer from this source is not supported in v0.2.0."] });
  state.severity = core.analysisSeverity(state.cards, state.deferred);
  state.analysisValidFor = state.sourceRoot;
  state.analysisMessage = "Valid analysis exists for the currently selected source.";
  state.sourceState = "SOURCE_ANALYZED";
  state.reviewReady = false;
  state.finalStatus = "ANALYZED";
  log("analysis-complete", { summary: state.summary, blockers: state.cards.filter((c) => c.class === "BLOCKER"), warnings: state.cards.filter((c) => c.class === "WARNING"), deferred: state.deferred, portraitCounts: state.portraits });
  sendState();
  return publicState();
}

function verifyTarget({ confirmFresh = false } = {}) {
  ensureAppDirs();
  if (core.validateTarget(state.target).length) throw new Error("Select a recognizable EveJS target release root.");
  state.target = core.detectRuntime(state.targetRoot);
  state.target.running = core.detectRunning(state.targetRoot);
  const missing = ["sqlite", "manifest", "data"].filter((key) => !state.target[key]);
  if (missing.length) throw new Error(`Target initialization is incomplete: missing ${missing.join(", ")}. Start it once normally, wait for DB generation, then shut it down and retry.`);
  const hasProvenance = core.hasPristineProvenance(state.targetRoot, state.pristineProvenancePath);
  if (!state.targetPrepared && !hasProvenance && !confirmFresh) throw new Error("This target was not proven pristine in this session. Confirm that it is fresh/disposable before verification.");
  if (state.target.running === "running") throw new Error("Target appears to be running. Shut it down before verification.");
  state.targetVerified = true;
  state.targetState = "TARGET_VERIFIED";
  state.finalStatus = "TARGET_VERIFIED";
  log("target-verified", { preparedByGui: state.targetPrepared, pristineProvenance: hasProvenance, userConfirmedFresh: confirmFresh });
  sendState();
  return publicState();
}

function prepareTarget({ confirmUnknown = false } = {}) {
  ensureAppDirs();
  if (core.validateTarget(state.target).length) throw new Error("Select a recognizable EveJS target release root.");
  if (state.sourceRoot && core.samePath(state.sourceRoot, state.targetRoot)) throw new Error("Source and target must be different folders.");
  const estimate = storage.measurePaths(core.targetResetPlan(state.targetRoot).remove);
  const available = storage.freeSpace(DATA_PATHS.root);
  if (storage.backupSpaceStatus(estimate, available).insufficient) throw new Error(`Prepare requires approximately ${storage.formatBytes(estimate)} for its backup, but only ${storage.formatBytes(available)} is available at:\n${DATA_PATHS.backups}\n\nMove or extract the application to a writable volume with enough free space.`);
  state.target.running = core.detectRunning(state.targetRoot);
  const result = core.prepareFreshTarget({ sourceRoot: state.sourceRoot, targetRoot: state.targetRoot, backupRoot: appPaths().backups, runningState: state.target.running, confirmUnknown });
  if (result.backupDir) state.backupPaths.push(result.backupDir);
  state.prepareBackupDir = result.backupDir || "";
  state.transferAppliedSincePrepare = false;
  state.undoPrepareStatus = result.backupDir ? "AVAILABLE" : "NOT_NEEDED";
  state.targetPrepared = true;
  state.pristineProvenancePath = state.targetRoot;
  state.preparedConfiguredTarget = !result.alreadyPristine;
  state.targetVerified = false;
  state.reviewReady = false;
  state.finalStatus = result.alreadyPristine ? "TARGET_ALREADY_PRISTINE_SETUP_REQUIRED" : "TARGET_PREPARED_REINITIALIZATION_REQUIRED";
  state.targetState = result.alreadyPristine ? "TARGET_PRISTINE_SETUP_REQUIRED" : "TARGET_PREPARED_REINITIALIZATION_REQUIRED";
  state.target = core.detectRuntime(state.targetRoot);
  refreshStorageInfo();
  log("target-prepared", { backupPath: result.backupDir, preservedContentPacks: result.preservedContentPacks, removed: result.removed });
  sendState();
  return { state: publicState(), result: { alreadyPristine: result.alreadyPristine, removedCount: result.removed.length, preservedContentPacks: result.preservedContentPacks, undoAvailable: Boolean(result.backupDir) } };
}

function undoPreparedTarget({ confirmUnknown = false } = {}) {
  ensureAppDirs();
  if (!state.prepareBackupDir || !state.targetPrepared) throw new Error("Undo Prepare is available only for a target prepared by this app in the current session.");
  if (state.transferAppliedSincePrepare) throw new Error("Undo Prepare is blocked because Transfer successfully applied.");
  state.target = core.detectRuntime(state.targetRoot);
  state.target.running = core.detectRunning(state.targetRoot);
  const result = core.undoPrepare({ targetRoot: state.targetRoot, backupDir: state.prepareBackupDir, backupRoot: appPaths().backups, runningState: state.target.running, confirmUnknown });
  const retainedBackup = state.prepareBackupDir;
  clearSourceAnalysis("Analysis invalidated by Undo Prepare. Analyze the source again before any future transfer.");
  Object.assign(state, { targetPrepared: false, targetVerified: false, pristineProvenancePath: "", preparedConfiguredTarget: false, prepareBackupDir: "", transferAppliedSincePrepare: false, undoPrepareStatus: "UNDONE", reviewReady: false, mechanical: {}, finalStatus: "PREPARE_UNDONE" });
  state.target = core.detectRuntime(state.targetRoot);
  state.target.running = core.detectRunning(state.targetRoot);
  state.targetState = state.target.lifecycle === "INITIALIZED" ? "TARGET_INITIALIZED_UNVERIFIED" : "TARGET_UNINITIALIZED";
  refreshStorageInfo();
  log("prepare-undone", { backupPath: retainedBackup, restored: result.restored, backupRetained: result.backupRetained });
  sendState();
  return { state: publicState(), result: { restoredCount: result.restored.length, backupRetained: result.backupRetained } };
}

async function checkForUpdates() {
  state.update = { status: "CHECKING", currentVersion: app.getVersion(), latestVersion: "", releaseNotes: "" };
  sendState();
  try { state.update = await updateChecker.checkForUpdates({ currentVersion: app.getVersion() }); }
  catch { state.update = { status: "ERROR", currentVersion: app.getVersion(), latestVersion: "", releaseNotes: "Update check unavailable. Migration features are unaffected." }; }
  sendState();
  return publicState();
}

function review() {
  ensureAppDirs();
  validateSelection();
  const readiness = core.reviewReadiness(state);
  if (!readiness.canDryRun || !state.bundlePath || !fs.existsSync(state.bundlePath)) throw new Error(readiness.message);
  const result = runEngine(["import", "--target-root", state.targetRoot, "--in", state.bundlePath, "--replace-existing"], "import-dry-run");
  if (!/DRY_RUN_OK/.test(result.stdout)) throw new Error("Engine r1.7 did not report DRY_RUN_OK.");
  state.reviewReady = true;
  state.finalStatus = "READY";
  log("review-ready", { summary: state.summary });
  sendState();
  return publicState();
}

function transfer({ confirmSourceUnknown = false, confirmTargetUnknown = false } = {}) {
  ensureAppDirs();
  validateSelection();
  const blockers = transferBlockers();
  if (blockers.length) throw new Error(`Transfer is blocked:\n${blockers.join("\n")}`);
  state.source.running = core.detectRunning(state.sourceRoot);
  state.target.running = core.detectRunning(state.targetRoot);
  if (state.source.running === "running" || state.target.running === "running") throw new Error("Source and target servers must both be stopped.");
  if (state.source.running === "unknown" && !confirmSourceUnknown) throw new Error("Source running state is unknown; explicit stopped confirmation is required.");
  if (state.target.running === "unknown" && !confirmTargetUnknown) throw new Error("Target running state is unknown; explicit stopped confirmation is required.");
  state.mechanical = { dbImport: "RUNNING", integrity: "NOT RUN", worldIsolation: "NOT RUN", walletAuthority: "NOT RUN", blueprintState: "NOT RUN", portraits: "NOT RUN" };
  sendState();
  try {
    let imported;
    try { imported = runEngine(["import", "--target-root", state.targetRoot, "--in", state.bundlePath, "--replace-existing", "--apply"], "database-apply"); }
    catch (error) { state.mechanical.dbImport = "FAIL"; state.finalStatus = "TRANSFER_FAILED"; throw error; }
    if (!/IMPORT_OK/.test(imported.stdout)) { state.mechanical.dbImport = "FAIL"; state.finalStatus = "TRANSFER_FAILED"; throw new Error("Database stage did not report IMPORT_OK."); }
    state.mechanical.dbImport = "PASS";
    state.transferAppliedSincePrepare = true;
    state.undoPrepareStatus = "BLOCKED_TRANSFER_APPLIED";
    state.mechanical.integrity = /SQLite integrity_check:\s*ok/i.test(imported.stdout) ? "PASS" : "FAIL";
    state.mechanical.worldIsolation = /Forbidden world-state fingerprints:\s*unchanged/i.test(imported.stdout) ? "PASS" : "FAIL";
    state.mechanical.walletAuthority = state.summary.walletAuthority === 0 || /Written tables:.*walletAuthorityState/i.test(imported.stdout) ? "PASS" : "FAIL";
    state.mechanical.blueprintState = state.summary.blueprintState === 0 || /Written tables:.*industryBlueprintState/i.test(imported.stdout) ? "PASS" : "FAIL";
    if (Object.values(state.mechanical).slice(0, 5).includes("FAIL")) { state.finalStatus = "MECHANICAL_VERIFICATION_FAILED"; throw new Error("Database apply completed but one or more required mechanical assertions failed. Portrait copy was not started."); }
    sendState();
    if (!state.portraitSourceAvailable) state.mechanical.portraits = "SKIPPED — no source media";
    else {
      const portraitDry = runEngine(["portraits", "--source-root", state.sourceRoot, "--target-root", state.targetRoot, "--in", state.bundlePath], "portrait-pre-apply-dry-run");
      if (!/PORTRAIT_DRY_RUN_OK/.test(portraitDry.stdout)) throw new Error("Portrait dry-run failed after DB success.");
      try {
        const portraits = runEngine(["portraits", "--source-root", state.sourceRoot, "--target-root", state.targetRoot, "--in", state.bundlePath, "--apply"], "portrait-apply");
        state.mechanical.portraits = /PORTRAITS_OK/.test(portraits.stdout) ? "PASS" : "FAIL";
      } catch (error) {
        state.mechanical.portraits = "FAIL";
        state.finalStatus = "DB_PASS_PORTRAIT_FAIL";
        log("transfer-partial", { mechanical: state.mechanical, error: error.message });
        sendState();
        throw new Error(`Database migration passed, but portrait copy failed.\n${error.message}`);
      }
    }
    if (state.prepareBackupDir) core.markPrepareTransferApplied(state.prepareBackupDir);
    state.finalStatus = "MECHANICAL_PASS_GAMEPLAY_REQUIRED";
    log("transfer-complete", { mechanical: state.mechanical, gameplay: "REQUIRED", backupPaths: state.backupPaths });
    cleanupBundle({ required: true });
    refreshStorageInfo();
    sendState();
    return publicState();
  } catch (error) {
    if (!["TRANSFER_FAILED", "MECHANICAL_VERIFICATION_FAILED", "DB_PASS_PORTRAIT_FAIL"].includes(state.finalStatus)) state.finalStatus = state.mechanical.dbImport === "PASS" ? "DB_PASS_POST_IMPORT_FAILED" : "TRANSFER_FAILED";
    sendState();
    throw error;
  } finally {
    recordHistory();
  }
}

async function deleteCurrentCompletedBackup() {
  ensureAppDirs();
  const backupDir = state.prepareBackupDir || state.backupPaths.at(-1);
  const candidate = backupDir && storage.validCompletedBackup(DATA_PATHS.backups, backupDir);
  if (!candidate) throw new Error("Cleanup is unavailable: this backup is still needed for Undo/recovery, is incomplete/unknown, or is not an app-owned completed v0.2.0 backup.");
  const confirmation = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancel", "Delete Completed Backup"],
    defaultId: 0,
    cancelId: 0,
    title: "Delete completed backup?",
    message: "Delete this completed backup permanently?",
    detail: `${candidate.path}\n\nSize: ${storage.formatBytes(candidate.bytes)}\n\nThis does not change the migrated target.`,
    noLink: true,
  });
  if (confirmation.response !== 1) return { state: publicState(), canceled: true };
  storage.deleteCompletedBackup(DATA_PATHS.backups, candidate.path);
  state.backupPaths = state.backupPaths.filter((item) => !core.samePath(item, candidate.path));
  if (core.samePath(state.prepareBackupDir, candidate.path)) state.prepareBackupDir = "";
  refreshStorageInfo();
  sendState();
  return { state: publicState(), result: { deleted: 1, bytes: candidate.bytes } };
}

async function cleanCompletedBackups() {
  ensureAppDirs();
  const candidates = storage.completedBackups(DATA_PATHS.backups);
  const bytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
  if (!candidates.length) throw new Error("No completed, non-Undo-eligible v0.2.0 backups are available for cleanup. Recovery, failed/unknown, invalid, and foreign directories were left untouched.");
  const confirmation = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancel", "Delete Completed Backups"],
    defaultId: 0,
    cancelId: 0,
    title: "Clean completed backups?",
    message: `Permanently delete ${candidates.length} completed backup${candidates.length === 1 ? "" : "s"}?`,
    detail: `Total size: ${storage.formatBytes(bytes)}\n\nOnly valid v0.2.0 backups marked transfer-applied will be deleted. This does not change migrated targets.`,
    noLink: true,
  });
  if (confirmation.response !== 1) return { state: publicState(), canceled: true };
  try {
    const result = storage.cleanCompletedBackups(DATA_PATHS.backups);
    state.backupPaths = state.backupPaths.filter((item) => fs.existsSync(item));
    if (state.prepareBackupDir && !fs.existsSync(state.prepareBackupDir)) state.prepareBackupDir = "";
    refreshStorageInfo();
    sendState();
    return { state: publicState(), result: { deleted: result.deleted.length, bytes: result.bytes } };
  } catch (error) {
    state.backupPaths = state.backupPaths.filter((item) => fs.existsSync(item));
    if (state.prepareBackupDir && !fs.existsSync(state.prepareBackupDir)) state.prepareBackupDir = "";
    refreshStorageInfo();
    sendState();
    throw error;
  }
}

function registerIpc() {
  ipcMain.handle("get-state", () => { ensureAppDirs(); assertEngine(); refreshStorageInfo(); return publicState(); });
  ipcMain.handle("choose-folder", chooseFolder);
  ipcMain.handle("choose-node", chooseNode);
  ipcMain.handle("set-node", (_event, nodePath) => { state.manualNodePath = nodePath || ""; state.activeNodePath = ""; state.nodeCompatibility = null; return publicState(); });
  ipcMain.handle("set-roots", (_event, roots) => refreshRoots(roots.sourceRoot, roots.targetRoot));
  ipcMain.handle("analyze", analyze);
  ipcMain.handle("prepare-target", (_event, options) => prepareTarget(options));
  ipcMain.handle("undo-prepare", (_event, options) => undoPreparedTarget(options));
  ipcMain.handle("verify-target", (_event, options) => verifyTarget(options));
  ipcMain.handle("review", review);
  ipcMain.handle("transfer", (_event, options) => transfer(options));
  ipcMain.handle("export-report", async () => {
    const result = await dialog.showSaveDialog(win, { title: "Export transfer report", defaultPath: `EveJS-Character-Transfer-Report-${new Date().toISOString().slice(0, 10)}.md`, filters: [{ name: "Markdown", extensions: ["md"] }, { name: "Text", extensions: ["txt"] }] });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, core.reportMarkdown({ ...state, appVersion: app.getVersion() }), "utf8");
    return result.filePath;
  });
  ipcMain.handle("create-support-report", async () => {
    const result = await dialog.showSaveDialog(win, { title: "Create sanitized support report", defaultPath: `EveJS-Character-Transfer-Support-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
    if (result.canceled) return null;
    supportReport.createSupportZip(result.filePath, { ...state, appVersion: app.getVersion() }, { platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node });
    return result.filePath;
  });
  ipcMain.handle("copy-sanitized-summary", async () => { await clipboard.writeText(core.reportMarkdown({ ...state, appVersion: app.getVersion() })); return true; });
  ipcMain.handle("get-history", () => history.readHistory(appPaths().history));
  ipcMain.handle("clear-history", () => {
    if (!history.clearHistorySafe(appPaths().history)) throw new Error("Migration history could not be cleared.");
    return [];
  });
  ipcMain.handle("check-for-updates", checkForUpdates);
  ipcMain.handle("open-latest-release", () => shell.openExternal(updateChecker.OFFICIAL_LATEST_RELEASE_URL));
  ipcMain.handle("open-log", () => shell.openPath(appPaths().logs));
  ipcMain.handle("open-backup", () => shell.openPath(state.backupPaths.at(-1) || appPaths().backups));
  ipcMain.handle("delete-completed-backup", deleteCurrentCompletedBackup);
  ipcMain.handle("clean-completed-backups", cleanCompletedBackups);
  ipcMain.handle("open-target", () => state.targetRoot ? shell.openPath(state.targetRoot) : null);
  ipcMain.handle("run-setup", () => { const file = path.join(state.targetRoot || "", "SetupEveJS.bat"); if (!state.target || !state.target.setupScript || !fs.existsSync(file)) throw new Error("SetupEveJS.bat was not found in the target root."); return shell.openPath(file); });
  ipcMain.handle("copy-text", async (_event, text) => { await clipboard.writeText(String(text || "")); return true; });
}

function createWindow() {
  win = new BrowserWindow({ width: 1180, height: 820, minWidth: 940, minHeight: 680, backgroundColor: "#071016", title: "EveJS Character Transfer", icon: externalResource(path.join("assets", "icon.ico")), webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  try {
    ensureAppDirs();
    storage.cleanupStaleRuns(DATA_PATHS.runs);
    storage.cleanupLogs(DATA_PATHS.logs, { retentionDays: 30 });
    refreshStorageInfo();
    assertEngine();
    registerIpc();
    createWindow();
  } catch (error) {
    dialog.showErrorBox("EveJS Character Transfer cannot start safely", error.message);
    app.quit();
  }
});
app.on("before-quit", cleanupBundle);
app.on("window-all-closed", () => { cleanupBundle(); if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
