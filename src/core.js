"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const ACCEPTED_ENGINE_SHA256 = "73458c827f27e85b110e3687ee825616991b3db69ac00cb2a83da6de36079329";
const ACCEPTED_ENGINE_REVISION = "r1.6";
const PREPARE_MANIFEST = "prepare-manifest.json";
const PREPARE_MANIFEST_KIND = "EVEJS_CHARACTER_TRANSFER_PREPARE_BACKUP";
const US = String.fromCharCode(31);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase();
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function releaseVersion(value) {
  const match = String(value || "").match(/(?:^|[^\d])(\d+\.\d+\.\d+(?:\.\d+)?)(?:$|[^\d])/);
  return match ? match[1] : null;
}

function detectVersionInfo(root) {
  const rootPackage = readJson(path.join(root, "package.json"));
  const rootLock = readJson(path.join(root, "package-lock.json"));
  const serverPackage = readJson(path.join(root, "server", "package.json"));
  const candidates = [
    [rootPackage && rootPackage.version, "root-package"],
    [rootLock && rootLock.packages && rootLock.packages[""] && rootLock.packages[""].version, "root-package-lock"],
    [serverPackage && serverPackage.version, "server-package"],
  ];
  for (const [raw, source] of candidates) {
    const version = releaseVersion(raw);
    // Historical EveJS releases used 0.0.1 for the internal server package.
    if (version && !(source === "server-package" && version === "0.0.1")) return { version, source, reliable: true };
  }
  const folderVersion = releaseVersion(path.basename(path.resolve(root)));
  if (folderVersion) return { version: folderVersion, source: "folder-name-fallback", reliable: false };
  return { version: null, source: "unknown", reliable: false };
}

function detectVersion(root) { return detectVersionInfo(root).version; }

function compareVersions(left, right) {
  const a = String(left || "").split(".").map(Number);
  const b = String(right || "").split(".").map(Number);
  if (!a.length || a.some(Number.isNaN) || !b.length || b.some(Number.isNaN)) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

function sourceTransferSupport(runtime, minimum = "0.12.5") {
  if (!runtime || !runtime.version) return { supported: false, code: "SOURCE_VERSION_UNKNOWN", label: "Legacy / version unknown", reason: `Transfer requires EveJS ${minimum} or newer.` };
  const comparison = compareVersions(runtime.version, minimum);
  if (comparison == null || comparison < 0) return { supported: false, code: "LEGACY_SOURCE_ANALYZE_ONLY", label: `LEGACY SOURCE — ANALYZE ONLY (${runtime.version})`, reason: `Transfer requires EveJS ${minimum} or newer.` };
  return { supported: true, code: "SOURCE_VERSION_SUPPORTED", label: `Supported source (${runtime.version})`, reason: `EveJS ${minimum} or newer.` };
}

function detectRuntime(root) {
  const resolved = root ? path.resolve(root) : "";
  const gameStore = path.join(resolved, "_local", "gameStore");
  const versionInfo = resolved ? detectVersionInfo(resolved) : { version: null, source: "unknown", reliable: false };
  const status = {
    root: resolved,
    version: versionInfo.version,
    versionSource: versionInfo.source,
    versionReliable: versionInfo.reliable,
    gameStore: fs.existsSync(gameStore),
    sqlite: fs.existsSync(path.join(gameStore, "gamestore.sqlite")),
    manifest: fs.existsSync(path.join(gameStore, "manifest.json")),
    data: fs.existsSync(path.join(gameStore, "data")),
    contentPacks: fs.existsSync(path.join(gameStore, "content-packs")),
    portraits: fs.existsSync(path.join(gameStore, "images", "Character")),
    setupScript: fs.existsSync(path.join(resolved, "SetupEveJS.bat")),
    releaseEvidence: resolved ? [path.join(resolved, "server", "package.json"), path.join(resolved, "package.json"), path.join(resolved, "StartServer.bat"), path.join(resolved, "Play.bat"), path.join(resolved, "SetupEveJS.bat")].filter((p) => fs.existsSync(p)) : [],
    running: "unknown",
  };
  status.recognized = Boolean(status.releaseEvidence.length);
  status.pristine = Boolean(status.recognized && !status.gameStore && !status.sqlite && !status.manifest && !status.data);
  status.lifecycle = !status.recognized ? "INVALID" : status.pristine ? "PRISTINE_SETUP_REQUIRED" : !status.sqlite || !status.manifest || !status.data ? "UNINITIALIZED" : "INITIALIZED";
  return status;
}

function detectRunning(root) {
  if (process.platform !== "win32") return "unknown";
  try {
    const escaped = String(path.resolve(root)).replaceAll("'", "''").toLowerCase();
    const script = `$p='${escaped}'; $hit=Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($p) -and $_.ProcessId -ne $PID }; if($hit){'running'}else{'stopped'}`;
    const result = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true });
    const value = String(result.stdout || "").trim().toLowerCase();
    return value === "running" || value === "stopped" ? value : "unknown";
  } catch { return "unknown"; }
}

function validatePair(source, target) {
  const blockers = [];
  if (!source.recognized) blockers.push({ code: "SOURCE_ROOT_INVALID", message: "Source is not a recognizable EveJS runtime." });
  if (!source.sqlite) blockers.push({ code: "SOURCE_DB_MISSING", message: "Source gamestore.sqlite is missing." });
  if (!target.recognized) blockers.push({ code: "TARGET_ROOT_INVALID", message: "Target is not a recognizable EveJS runtime." });
  if (samePath(source.root, target.root)) blockers.push({ code: "SOURCE_EQUALS_TARGET", message: "Source and target must be different folders." });
  return blockers;
}

function validateSource(source) {
  const blockers = [];
  if (!source || !source.recognized) blockers.push({ code: "SOURCE_ROOT_INVALID", message: "Source is not a recognizable EveJS release root." });
  if (source && !source.sqlite) blockers.push({ code: "SOURCE_DB_MISSING", message: "Source gamestore.sqlite is missing." });
  return blockers;
}

function validateTarget(target) {
  if (!target || !target.recognized) return [{ code: "TARGET_ROOT_INVALID", message: "Target is not a recognizable EveJS release root." }];
  return [];
}

function rootChanges(previousSource, previousTarget, nextSource, nextTarget) {
  return {
    sourceChanged: !samePath(previousSource, nextSource) || Boolean(previousSource) !== Boolean(nextSource),
    targetChanged: !samePath(previousTarget, nextTarget) || Boolean(previousTarget) !== Boolean(nextTarget),
  };
}

function analysisSeverity(cards = [], deferred = []) {
  return { blockers: cards.filter((c) => c.class === "BLOCKER").length, warnings: cards.filter((c) => c.class === "WARNING").length, deferred: deferred.length };
}

function reviewReadiness(state = {}) {
  const currentAnalysis = Boolean(state.bundle && state.analysisValidFor && samePath(state.analysisValidFor, state.sourceRoot));
  const sourceSupport = sourceTransferSupport(state.source);
  const blockers = (state.cards || []).filter((card) => card && card.class === "BLOCKER");
  if (!currentAnalysis) return { canDryRun: false, ready: false, message: "Not ready: analyze the currently selected source." };
  if (!sourceSupport.supported) return { canDryRun: false, ready: false, message: `${sourceSupport.label}. ${sourceSupport.reason}` };
  if (blockers.length) return { canDryRun: false, ready: false, message: `Not ready: resolve ${blockers.length} blocking finding${blockers.length === 1 ? "" : "s"}.` };
  if (!state.targetVerified) return { canDryRun: false, ready: false, message: "Not ready: verify the prepared or confirmed-fresh target." };
  if (!state.reviewReady) return { canDryRun: true, ready: false, message: "Target verified. Run the accepted import dry-run to complete review." };
  return { canDryRun: true, ready: true, message: "READY — accepted import dry-run passed and no true blockers remain." };
}

function hasPristineProvenance(targetRoot, pristineProvenancePath) {
  return Boolean(targetRoot && pristineProvenancePath && samePath(targetRoot, pristineProvenancePath));
}

function parseAbiMismatch(text, currentAbi = null) {
  const value = String(text || "");
  const built = value.match(/NODE_MODULE_VERSION\s+(\d+)/i);
  const required = [...value.matchAll(/NODE_MODULE_VERSION\s+(\d+)/gi)].map((m) => Number(m[1]));
  if (!/NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(value)) return null;
  return { sourceAbi: built ? Number(built[1]) : null, currentAbi: required.length > 1 ? required.at(-1) : currentAbi == null ? null : Number(currentAbi), technicalDetails: value.trim() };
}

function summarizeBundle(bundle) {
  const rows = bundle.rows || {};
  const selected = bundle.selected || {};
  const blueprintSummary = bundle.blueprintSummary || {};
  return {
    sourceVersion: bundle.source && bundle.source.version,
    accounts: (selected.accountIDs || rows.accounts || []).length,
    characters: (selected.characterIDs || rows.characters || []).length,
    corporations: (selected.corporationIDs || bundle.corporations || []).length,
    alliances: (selected.allianceIDs || bundle.alliances || []).length,
    items: (selected.itemIDs || rows.items || []).length,
    blueprintState: (rows.industryBlueprintState || []).length,
    researchedBlueprints: Number(blueprintSummary.researchedBlueprints) || 0,
    blueprintCopies: Number(blueprintSummary.blueprintCopies) || 0,
    deferredBlueprintState: (((bundle.deferred || {}).blueprintStateRows) || []).length,
    blockedBlueprintState: Number(blueprintSummary.blockedBlueprintStateRows) || 0,
    mail: (rows.mail || []).filter((row) => String(row.key || "").startsWith(`messages${US}`)).length,
    walletAuthority: (rows.walletAuthorityState || []).length,
    engineFindings: (bundle.warnings || []).length,
    deferredStructures: ((bundle.deferred || {}).playerStructures || []).length,
    deferredOffices: ((bundle.deferred || {}).corporationOffices || []).length,
    deferredItems: ((bundle.deferred || {}).items || []).length,
  };
}

function parsePortraitOutput(output) {
  const take = (label) => {
    const match = String(output).match(new RegExp(`${label}:\\s*(\\d+)`, "i"));
    return match ? Number(match[1]) : 0;
  };
  return {
    charactersWithMedia: take("Characters with portrait media"),
    charactersWithoutMedia: take("Characters without portrait media"),
    files: take("Portrait files selected"),
    ok: /PORTRAIT_DRY_RUN_OK|PORTRAITS_OK/.test(String(output)),
  };
}

const COMMON_FIX = ["1. Start the SOURCE server.", "2. Resolve the affected state in-game.", "3. Log out.", "4. Shut down the source normally.", "5. Click Scan Again."];
const REMEDIATIONS = Object.freeze({
  CHARACTER_ACTIVE_SHIP_DEFERRED: { title: "Character's active ship is inside deferred player-structure/world state", why: "Classic Transfer does not import that structure/world object and cannot preserve the active-ship reference safely.", fix: ["1. Start the SOURCE server.", "2. Log in as the named character.", "3. Move the character and ship to a normal static NPC station.", "4. Log out.", "5. Shut down the source normally.", "6. Click Scan Again."] },
  CHARACTER_IN_PLAYER_STRUCTURE: { title: "Character is docked in a player structure", why: "Classic Transfer intentionally does not import player structures.", fix: ["Dock and log out at a static NPC station, shut down the source normally, then click Scan Again."] },
  CHARACTER_NON_STATIC_STATION: { title: "Character is stored at an unknown/non-static location", why: "The location does not exist in the static station authority used by a fresh target.", fix: ["Move and log out at a normal NPC station. If that is not possible, investigate the raw IDs; no automatic re-home is available. Then click Scan Again."] },
  CORPORATION_HQ_NON_STATIC: { title: "Corporation HQ/base is in a player or non-static structure", why: "The HQ/base would point to world state that Classic Transfer does not import.", fix: ["Move the corporation HQ/base to a static NPC station, shut down the source normally, then click Scan Again."] },
  NON_STATIC_CORP_OFFICE_SKIPPED: { title: "Corporation office uses an unknown non-static location", why: "Known player-structure offices can be deferred, but an unknown dynamic office cannot be transferred safely.", fix: ["Move or remove the office, or relocate wanted assets to a static NPC station, then click Scan Again."] },
  EXTERNAL_ITEM_LOCATIONS: { title: "Item(s) are held by an unresolved dynamic process/location", why: "The item is neither in transferable inventory, a static NPC location, nor a known deferred structure domain.", fix: ["Recover or move the item into ordinary inventory at a static NPC station, shut down the source normally, then click Scan Again."] },
  BLUEPRINT_COPY_STATE_MISSING: { title: "Blueprint copy is missing persistent blueprint state", why: "A copy's remaining runs, ME, and TE cannot be reconstructed safely from its inventory row.", fix: ["Start the SOURCE server and inspect this blueprint copy.", "If it is usable, complete a normal inventory/industry save cycle; otherwise remove the corrupt copy.", "Log out, shut down the source normally, and click Scan Again."] },
  BLUEPRINT_ACTIVE_INDUSTRY_JOB: { title: "Active industry job must be completed or cancelled before transfer", why: "Classic Transfer does not migrate active industry jobs or their allocator/history state.", fix: ["Start the SOURCE server.", "Complete or cancel the named blueprint's active industry job.", "Return the blueprint to ordinary inventory, log out, shut down normally, and click Scan Again."] },
  BLUEPRINT_INSTALLED_LOCATION_ACTIVE: { title: "Blueprint is still installed in an industry job", why: "Industry installation location 2003 is active custody that cannot be moved without its complete job transaction.", fix: ["Start the SOURCE server.", "Complete or cancel the blueprint's job and confirm the blueprint returned to ordinary inventory.", "Log out, shut down normally, and click Scan Again."] },
  BLUEPRINT_STATE_KEY_ITEMID_MISMATCH: { title: "Blueprint state is inconsistent with item identity", why: "The persistent state key and embedded item ID do not describe the same blueprint.", fix: COMMON_FIX },
  BLUEPRINT_STATE_TYPE_MISMATCH: { title: "Blueprint state is inconsistent with item identity", why: "The persistent state type does not match the transferred inventory item.", fix: COMMON_FIX },
  BLUEPRINT_STATE_ITEM_NOT_BLUEPRINT: { title: "Blueprint state points to a non-blueprint item", why: "A blueprint companion record references an item outside EveJS blueprint category 9.", fix: COMMON_FIX },
  BLUEPRINT_STATE_SINGLETON_INVALID: { title: "Blueprint state has an invalid instance marker", why: "The inventory singleton marker cannot represent a valid original or copy.", fix: COMMON_FIX },
  BLUEPRINT_STATE_SINGLETON_ORIGINAL_MISMATCH: { title: "Blueprint original/copy state is inconsistent", why: "The inventory singleton marker disagrees with the persistent original/copy value.", fix: COMMON_FIX },
  BLUEPRINT_STATE_MATERIAL_EFFICIENCY_INVALID: { title: "Blueprint material efficiency is invalid", why: "The stored ME value is outside EveJS's supported 0–10 range.", fix: COMMON_FIX },
  BLUEPRINT_STATE_TIME_EFFICIENCY_INVALID: { title: "Blueprint time efficiency is invalid", why: "The stored TE value is outside EveJS's supported 0–20 range.", fix: COMMON_FIX },
  BLUEPRINT_STATE_RUNS_INVALID: { title: "Blueprint run state is invalid", why: "Originals require unlimited-run semantics and copies require a positive finite remaining-run count.", fix: COMMON_FIX },
});

const TARGET_CODES = new Set(["TARGET_CORP_OFFICE_STATION_MISSING", "TARGET_CHARACTER_ACTIVE_SHIP_DEFERRED", "TARGET_CHARACTER_IN_PLAYER_STRUCTURE", "TARGET_CHARACTER_STATION_MISSING", "TARGET_CORPORATION_HQ_STATION_MISSING", "TARGET_CORP_WORLD_ITEM_PRESENT", "TARGET_EXTERNAL_ITEM_LOCATIONS"]);

function warningCard(warning, diagnostics = []) {
  const code = String(warning.code || "UNKNOWN_WARNING");
  const classified = diagnostics.filter((d) => d.warningCode === code || code === "EXTERNAL_ITEM_LOCATIONS" && d.source === "external-item");
  if (code === "EXTERNAL_ITEM_LOCATIONS" && classified.length) return classified;
  const mapped = REMEDIATIONS[code];
  if (mapped) return [{ class: warning.severity === "blocking" ? "BLOCKER" : "WARNING", code, ...mapped, affected: warning }];
  if (TARGET_CODES.has(code)) return [{ class: "BLOCKER", code, title: "Target static compatibility failure", why: "The target release/static universe cannot satisfy a transferred reference.", fix: ["Verify the correct target release, reinitialize the target cleanly, or resolve source dynamic state before retrying. IDs are never rewritten automatically."], affected: warning }];
  return [{ class: warning.severity === "blocking" ? "BLOCKER" : "WARNING", code, title: code.replaceAll("_", " "), why: warning.message || "The accepted engine reported this condition.", fix: COMMON_FIX, affected: warning }];
}

function entityLabel(kind, id, resolution = {}) {
  const numeric = Number(id);
  const bucket = resolution[kind] || {};
  const name = bucket[String(numeric)];
  const labels = { characters: "Unknown character", corporations: "Unknown corporation", types: "Unknown item type", stations: "Unknown NPC station", systems: "Unknown solar system", structures: "Unknown player structure" };
  return name ? `${name} (${numeric})` : `${labels[kind] || "Unknown entity"} (${numeric})`;
}

function enrichCard(card, resolution = {}) {
  const affected = card.affected || {};
  const display = [];
  if (affected.characterID) display.push(["Character", entityLabel("characters", affected.characterID, resolution)]);
  if (affected.ownerID) {
    const ownerKind = resolution.characters && resolution.characters[String(affected.ownerID)] || Number(affected.ownerID) >= 140_000_001 && Number(affected.ownerID) < 980_000_000 ? "characters" : "corporations";
    display.push(["Owner", entityLabel(ownerKind, affected.ownerID, resolution)]);
  }
  if (affected.corporationID) display.push(["Corporation", entityLabel("corporations", affected.corporationID, resolution)]);
  if (affected.typeID) display.push([card.code === "ACTIVE_INDUSTRY_JOB" || String(card.code).startsWith("BLUEPRINT_") ? "Blueprint" : "Item type", entityLabel("types", affected.typeID, resolution)]);
  if (affected.stationID) display.push(["Station", entityLabel("stations", affected.stationID, resolution)]);
  if (affected.solarSystemID) display.push(["Solar system", entityLabel("systems", affected.solarSystemID, resolution)]);
  if (affected.structureID) display.push(["Structure", entityLabel("structures", affected.structureID, resolution)]);
  if (affected.locationID === 2003) display.push(["Location", "Industry installation"]);
  else if (affected.locationID) display.push(["Location", `Unknown dynamic location (${affected.locationID})`]);
  if (affected.jobID) display.push(["Job", affected.jobDescription || `Proven Industry job (${affected.jobID})`]);
  if (affected.missionName) display.push(["Mission", affected.missionName]);
  return { ...card, display };
}

function deferredCards(bundle) {
  const deferred = bundle.deferred || {};
  const deferredItems = deferred.items || [];
  return (deferred.playerStructures || []).map((structure) => {
    const id = Number(structure.structureID);
    const rooted = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of deferredItems) {
        const itemID = Number(item.itemID);
        const parent = Number(item.locationID || item.shipID);
        if (!rooted.has(itemID) && (parent === id || rooted.has(parent))) { rooted.add(itemID); changed = true; }
      }
    }
    return { class: "DEFERRED", title: "Player structure", name: structure.name || `Structure ${id}`, structureID: id, nestedItems: rooted.size, why: "This structure and its complete rooted inventory remain on the source. Nothing is silently re-homed.", fix: ["Continue without it, or move ordinary assets you want to keep to an NPC station and click Scan Again. Structure Transfer is outside Classic Transfer."] };
  });
}

function targetResetPlan(targetRoot) {
  const gs = path.join(path.resolve(targetRoot), "_local", "gameStore");
  const removeRelative = ["gamestore.sqlite", "gamestore.sqlite-wal", "gamestore.sqlite-shm", "data", "manifest.json", path.join("images", "Character")];
  return {
    root: gs,
    removeRelative,
    remove: removeRelative.map((p) => path.join(gs, p)),
    preserve: [path.join(gs, "content-packs"), path.join(gs, "images")],
  };
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

function sha256Text(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }
function normalizedPath(value) { return path.resolve(value).replace(/[\\/]+$/, "").replaceAll("\\", "/").toLowerCase(); }
function pathBinding(value) { return sha256Text(normalizedPath(value)); }

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}

function fingerprintPath(target) {
  if (!fs.existsSync(target)) return { exists: false };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("Prepare backup does not follow symbolic links.");
  const records = [];
  const visit = (current, relative) => {
    const currentStat = fs.lstatSync(current);
    if (currentStat.isSymbolicLink()) throw new Error("Prepare backup does not follow symbolic links.");
    if (currentStat.isDirectory()) {
      records.push({ path: relative || ".", type: "directory" });
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), relative ? path.join(relative, name) : name);
    } else if (currentStat.isFile()) {
      records.push({ path: relative || ".", type: "file", size: currentStat.size, sha256: sha256(current) });
    } else throw new Error("Prepare backup contains an unsupported filesystem entry.");
  };
  visit(target, "");
  return {
    exists: true,
    type: stat.isDirectory() ? "directory" : "file",
    files: records.filter((entry) => entry.type === "file").length,
    directories: records.filter((entry) => entry.type === "directory").length,
    bytes: records.reduce((total, entry) => total + (entry.size || 0), 0),
    treeSha256: sha256Text(JSON.stringify(records.map((entry) => ({ ...entry, path: entry.path.replaceAll("\\", "/") })))),
  };
}

function targetIdentity(targetRoot) {
  const evidence = ["package.json", "package-lock.json", "StartServer.bat", "Play.bat", "SetupEveJS.bat", path.join("server", "package.json")]
    .map((relative) => ({ relative: relative.replaceAll("\\", "/"), file: path.join(targetRoot, relative) }))
    .filter((entry) => fs.existsSync(entry.file))
    .map((entry) => ({ path: entry.relative, size: fs.statSync(entry.file).size, sha256: sha256(entry.file) }));
  if (!evidence.length) throw new Error("Target release identity could not be established.");
  return sha256Text(JSON.stringify(evidence));
}

function writePrepareManifest(backupDir, manifest) {
  const file = path.join(backupDir, PREPARE_MANIFEST);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
  return file;
}

function readPrepareManifest(backupDir) {
  const file = path.join(backupDir, PREPARE_MANIFEST);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("Prepare backup manifest is missing or unreadable."); }
  return { file, manifest };
}

function verifyPrepareBackup({ targetRoot, backupDir, backupRoot }) {
  if (!targetRoot || !backupDir) throw new Error("Undo Prepare requires the selected target and its app-owned backup.");
  if (backupRoot && !isWithin(backupRoot, backupDir)) throw new Error("Prepare backup is outside the application backup directory.");
  const { file, manifest } = readPrepareManifest(backupDir);
  if (manifest.kind !== PREPARE_MANIFEST_KIND || manifest.schemaVersion !== 1) throw new Error("Prepare backup manifest is not app-owned or supported.");
  if (manifest.engineRevision !== ACCEPTED_ENGINE_REVISION || manifest.engineSha256 !== ACCEPTED_ENGINE_SHA256) throw new Error("Prepare backup engine identity is invalid.");
  if (manifest.status === "UNDONE") throw new Error("Prepare backup was already undone.");
  if (manifest.status === "TRANSFER_APPLIED" || manifest.transferApplied === true) throw new Error("Undo Prepare is blocked because Transfer successfully applied.");
  if (manifest.status !== "PREPARED") throw new Error("Prepare backup is incomplete or not restorable.");
  if (!manifest.targetBinding || manifest.targetBinding.pathSha256 !== pathBinding(targetRoot)) throw new Error("Prepare backup belongs to a different target.");
  if (manifest.targetBinding.identitySha256 !== targetIdentity(targetRoot)) throw new Error("Selected target release identity changed after Prepare.");
  const allowed = new Set(targetResetPlan(targetRoot).removeRelative.map((entry) => entry.replaceAll("\\", "/")));
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error("Prepare backup contains no recoverable preimage.");
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (!entry || !allowed.has(entry.relativePath) || seen.has(entry.relativePath)) throw new Error("Prepare backup manifest contains an invalid entry.");
    seen.add(entry.relativePath);
    const backupPath = path.join(backupDir, ...entry.relativePath.split("/"));
    if (!isWithin(backupDir, backupPath) || JSON.stringify(fingerprintPath(backupPath)) !== JSON.stringify(entry.fingerprint)) throw new Error(`Prepare backup is incomplete or altered: ${entry.relativePath}.`);
  }
  return { file, manifest };
}

function prepareFreshTarget({ sourceRoot, targetRoot, backupRoot, runningState, confirmUnknown }) {
  if (samePath(sourceRoot, targetRoot)) throw new Error("Source and target must be different folders.");
  const plan = targetResetPlan(targetRoot);
  const existing = plan.remove.filter((p) => fs.existsSync(p));
  if (existing.length === 0) return { backupDir: null, removed: [], preservedContentPacks: fs.existsSync(plan.preserve[0]), alreadyPristine: true };
  if (runningState === "running") throw new Error("Target appears to be running. Shut it down before preparing.");
  if (runningState === "unknown" && !confirmUnknown) throw new Error("Target running state is unknown; explicit confirmation is required.");
  const backupDir = path.join(backupRoot, `target-before-prepare-${timestamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const entries = [];
  for (let index = 0; index < plan.remove.length; index += 1) {
    const source = plan.remove[index];
    if (!fs.existsSync(source)) continue;
    const relativePath = plan.removeRelative[index].replaceAll("\\", "/");
    const dest = path.join(backupDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(source, dest, { recursive: true, errorOnExist: true });
    const fingerprint = fingerprintPath(source);
    if (JSON.stringify(fingerprintPath(dest)) !== JSON.stringify(fingerprint)) throw new Error(`Prepare backup verification failed: ${relativePath}.`);
    entries.push({ relativePath, fingerprint });
  }
  const manifest = {
    kind: PREPARE_MANIFEST_KIND,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: "PREPARED",
    transferApplied: false,
    engineRevision: ACCEPTED_ENGINE_REVISION,
    engineSha256: ACCEPTED_ENGINE_SHA256,
    targetBinding: { pathSha256: pathBinding(targetRoot), identitySha256: targetIdentity(targetRoot) },
    entries,
  };
  const manifestPath = writePrepareManifest(backupDir, manifest);
  for (const target of plan.remove) fs.rmSync(target, { recursive: true, force: true });
  return { backupDir, manifestPath, removed: existing.filter((p) => !fs.existsSync(p)), preservedContentPacks: fs.existsSync(plan.preserve[0]), alreadyPristine: false };
}

function markPrepareTransferApplied(backupDir) {
  const { manifest } = readPrepareManifest(backupDir);
  if (manifest.kind !== PREPARE_MANIFEST_KIND || manifest.status !== "PREPARED") throw new Error("Prepare backup cannot be marked as transferred.");
  manifest.status = "TRANSFER_APPLIED";
  manifest.transferApplied = true;
  manifest.transferAppliedAt = new Date().toISOString();
  writePrepareManifest(backupDir, manifest);
  return manifest;
}

function undoPrepare({ targetRoot, backupDir, backupRoot, runningState, confirmUnknown }) {
  if (runningState === "running") throw new Error("Target appears to be running. Shut it down before Undo Prepare.");
  if (runningState === "unknown" && !confirmUnknown) throw new Error("Target running state is unknown; explicit confirmation is required for Undo Prepare.");
  const { manifest } = verifyPrepareBackup({ targetRoot, backupDir, backupRoot });
  const plan = targetResetPlan(targetRoot);
  for (const target of plan.remove) fs.rmSync(target, { recursive: true, force: true });
  for (const entry of manifest.entries) {
    const source = path.join(backupDir, ...entry.relativePath.split("/"));
    const target = path.join(plan.root, ...entry.relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, errorOnExist: true });
  }
  for (const entry of manifest.entries) {
    const restored = path.join(plan.root, ...entry.relativePath.split("/"));
    if (JSON.stringify(fingerprintPath(restored)) !== JSON.stringify(entry.fingerprint)) throw new Error(`Undo Prepare verification failed: ${entry.relativePath}. Recovery material was retained.`);
  }
  manifest.status = "UNDONE";
  manifest.undoneAt = new Date().toISOString();
  writePrepareManifest(backupDir, manifest);
  return { status: manifest.status, restored: manifest.entries.map((entry) => entry.relativePath), backupRetained: true };
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeStatus(value, fallback = "NOT RUN") {
  const normalized = String(value || "").toUpperCase();
  return /^[A-Z][A-Z0-9 _—-]{0,79}$/.test(normalized) ? normalized : fallback;
}

function diagnosticCategories(state, className) {
  const cards = className === "DEFERRED" ? state.deferred || [] : state.cards || [];
  return [...new Set(cards
    .filter((card) => card && card.class === className)
    .map((card) => className === "DEFERRED" && !card.code ? "PLAYER_STRUCTURE_DEFERRED" : String(card.code || ""))
    .filter((code) => /^[A-Z][A-Z0-9_]{1,79}$/.test(code)))]
    .sort();
}

function commandStageStatus(state, stage) {
  const records = (state.commandResults || []).filter((record) => record && record.stage === stage);
  if (!records.length) return "NOT RUN";
  return records.at(-1).exitCode === 0 ? "PASS" : "FAIL";
}

function reportData(state = {}, { generatedAt = new Date().toISOString() } = {}) {
  const summary = state.summary || {};
  const mechanical = state.mechanical || {};
  const source = state.source || {};
  const target = state.target || {};
  const support = sourceTransferSupport(source);
  const counts = {};
  for (const field of ["accounts", "characters", "corporations", "alliances", "items", "blueprintState", "researchedBlueprints", "blueprintCopies", "mail", "walletAuthority"]) counts[field] = safeCount(summary[field]);
  const portrait = state.portraits || {};
  return {
    generatedAt: String(generatedAt),
    appVersion: releaseVersion(state.appVersion) || "unknown",
    engineRevision: ACCEPTED_ENGINE_REVISION,
    engineSha256: /^[a-f0-9]{64}$/i.test(String(state.engineSha256 || "")) ? String(state.engineSha256).toLowerCase() : "unavailable",
    source: {
      version: releaseVersion(source.version) || "unknown",
      detectionSource: safeStatus(source.versionSource, "UNKNOWN").toLowerCase(),
      reliability: source.versionReliable === true ? "reliable" : "unreliable",
      supportCode: safeStatus(support.code, "SOURCE_VERSION_UNKNOWN"),
      supportLabel: support.supported ? "SUPPORTED" : "ANALYZE ONLY",
    },
    target: {
      version: releaseVersion(target.version) || "unknown",
      detectionSource: safeStatus(target.versionSource, "UNKNOWN").toLowerCase(),
      reliability: target.versionReliable === true ? "reliable" : "unreliable",
    },
    counts,
    portraits: {
      charactersWithMedia: safeCount(portrait.charactersWithMedia),
      charactersWithoutMedia: safeCount(portrait.charactersWithoutMedia),
      files: safeCount(portrait.files),
      analysis: portrait.ok === true ? portrait.skipped ? "SKIPPED" : "PASS" : portrait.ok === false ? "FAIL" : "NOT RUN",
    },
    findings: {
      blockers: safeCount((state.severity || {}).blockers),
      warnings: safeCount((state.severity || {}).warnings),
      deferred: safeCount((state.severity || {}).deferred),
      blockerCategories: diagnosticCategories(state, "BLOCKER"),
      warningCategories: diagnosticCategories(state, "WARNING"),
      deferredCategories: diagnosticCategories(state, "DEFERRED"),
    },
    stages: {
      analysis: safeStatus(state.sourceState, "NOT RUN"),
      prepare: state.targetPrepared ? state.preparedConfiguredTarget ? "PASS — REINITIALIZATION REQUIRED" : "PASS — ALREADY PRISTINE" : "NOT RUN",
      targetVerification: state.targetVerified ? "PASS" : "NOT RUN",
      dryRun: state.reviewReady ? "PASS" : commandStageStatus(state, "import-dry-run"),
      import: safeStatus(mechanical.dbImport, commandStageStatus(state, "database-apply")),
      databaseVerification: safeStatus(mechanical.integrity),
      worldIsolation: safeStatus(mechanical.worldIsolation),
      walletVerification: safeStatus(mechanical.walletAuthority),
      blueprintVerification: safeStatus(mechanical.blueprintState),
      portraitVerification: safeStatus(mechanical.portraits, state.portraits ? "NOT RUN" : "NOT APPLICABLE"),
      finalMechanicalResult: safeStatus(state.finalStatus, "NOT STARTED"),
    },
  };
}

function reportMarkdown(state, options) {
  const report = reportData(state, options);
  const line = (label, value) => `| ${label} | ${value} |`;
  const categories = (values) => values.length ? values.join(", ") : "None";
  return [
    "# EveJS Character Transfer Migration Report", "",
    `Generated: ${report.generatedAt}`,
    `App version: ${report.appVersion}`,
    `Accepted engine: ${report.engineRevision}`,
    `Accepted engine SHA-256: ${report.engineSha256}`, "",
    "## Runtime detection", "",
    "| Runtime | EveJS version | Detection source | Reliability | Support |",
    "|---|---:|---|---|---|",
    `| Source | ${report.source.version} | ${report.source.detectionSource} | ${report.source.reliability} | ${report.source.supportLabel} (${report.source.supportCode}) |`,
    `| Target | ${report.target.version} | ${report.target.detectionSource} | ${report.target.reliability} | n/a |`, "",
    "## Aggregate counts", "",
    "| Category | Count |", "|---|---:|",
    line("Accounts", report.counts.accounts),
    line("Characters", report.counts.characters),
    line("Corporations", report.counts.corporations),
    line("Alliances", report.counts.alliances),
    line("Items", report.counts.items),
    line("Blueprint companion rows", report.counts.blueprintState),
    line("Researched blueprints", report.counts.researchedBlueprints),
    line("Blueprint copies", report.counts.blueprintCopies),
    line("Mail messages", report.counts.mail),
    line("Wallet authority rows", report.counts.walletAuthority),
    line("Characters with portrait media", report.portraits.charactersWithMedia),
    line("Characters without portrait media", report.portraits.charactersWithoutMedia),
    line("Portrait files selected", report.portraits.files), "",
    "## Findings", "",
    line("BLOCKER", report.findings.blockers),
    line("WARNING", report.findings.warnings),
    line("DEFERRED", report.findings.deferred), "",
    `Blocker categories: ${categories(report.findings.blockerCategories)}`,
    `Warning categories: ${categories(report.findings.warningCategories)}`,
    `Deferred categories: ${categories(report.findings.deferredCategories)}`, "",
    "## Stage status", "", "| Check | Result |", "|---|---|",
    line("Source analysis", report.stages.analysis),
    line("Prepare", report.stages.prepare),
    line("Target verification", report.stages.targetVerification),
    line("Import dry-run", report.stages.dryRun),
    line("DB import", report.stages.import),
    line("DB verification", report.stages.databaseVerification),
    line("World isolation verification", report.stages.worldIsolation),
    line("Wallet verification", report.stages.walletVerification),
    line("Blueprint verification", report.stages.blueprintVerification),
    line("Portrait analysis", report.portraits.analysis),
    line("Portrait copy", report.stages.portraitVerification),
    line("Final mechanical result", report.stages.finalMechanicalResult),
    line("Gameplay verification", "REQUIRED"), "",
    "This report contains aggregate mechanical evidence only. It does not contain names, IDs, credentials, database rows, paths, portraits, bundles, or private runtime state, and it does not establish gameplay PASS.",
  ].join("\n");
}

module.exports = { ACCEPTED_ENGINE_SHA256, ACCEPTED_ENGINE_REVISION, PREPARE_MANIFEST, PREPARE_MANIFEST_KIND, US, sha256, samePath, readJson, releaseVersion, detectVersionInfo, detectVersion, compareVersions, sourceTransferSupport, detectRuntime, detectRunning, validatePair, validateSource, validateTarget, rootChanges, analysisSeverity, reviewReadiness, hasPristineProvenance, parseAbiMismatch, summarizeBundle, parsePortraitOutput, REMEDIATIONS, warningCard, entityLabel, enrichCard, deferredCards, targetResetPlan, pathBinding, fingerprintPath, targetIdentity, verifyPrepareBackup, prepareFreshTarget, markPrepareTransferApplied, undoPrepare, reportData, reportMarkdown };
