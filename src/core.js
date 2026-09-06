"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const ACCEPTED_ENGINE_SHA256 = "bc1955281a791f05a733a618717198da163bda8bb5063bf80694c85bdf0c3422";
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
  return {
    sourceVersion: bundle.source && bundle.source.version,
    accounts: (selected.accountIDs || rows.accounts || []).length,
    characters: (selected.characterIDs || rows.characters || []).length,
    corporations: (selected.corporationIDs || bundle.corporations || []).length,
    alliances: (selected.allianceIDs || bundle.alliances || []).length,
    items: (selected.itemIDs || rows.items || []).length,
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
  if (affected.typeID) display.push([card.code === "ACTIVE_INDUSTRY_JOB" ? "Blueprint" : "Item type", entityLabel("types", affected.typeID, resolution)]);
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
    return { class: "DEFERRED", title: "Player structure", name: structure.name || `Structure ${id}`, structureID: id, nestedItems: rooted.size, why: "This structure and its complete rooted inventory remain on the source. Nothing is silently re-homed.", fix: ["Continue without it, or move ordinary assets you want to keep to an NPC station and click Scan Again. Structure Transfer is outside v0.1."] };
  });
}

function targetResetPlan(targetRoot) {
  const gs = path.join(path.resolve(targetRoot), "_local", "gameStore");
  return {
    remove: ["gamestore.sqlite", "gamestore.sqlite-wal", "gamestore.sqlite-shm", "data", "manifest.json", path.join("images", "Character")].map((p) => path.join(gs, p)),
    preserve: [path.join(gs, "content-packs"), path.join(gs, "images")],
  };
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

function prepareFreshTarget({ sourceRoot, targetRoot, backupRoot, runningState, confirmUnknown }) {
  if (samePath(sourceRoot, targetRoot)) throw new Error("Source and target must be different folders.");
  const plan = targetResetPlan(targetRoot);
  const existing = plan.remove.filter((p) => fs.existsSync(p));
  if (existing.length === 0) return { backupDir: null, removed: [], preservedContentPacks: fs.existsSync(plan.preserve[0]), alreadyPristine: true };
  if (runningState === "running") throw new Error("Target appears to be running. Shut it down before preparing.");
  if (runningState === "unknown" && !confirmUnknown) throw new Error("Target running state is unknown; explicit confirmation is required.");
  const backupDir = path.join(backupRoot, `target-before-prepare-${timestamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupSet = new Set([plan.remove[0], plan.remove[1], plan.remove[2], plan.remove[4], plan.remove[5]]);
  for (const source of plan.remove) {
    if (!backupSet.has(source)) continue;
    if (!fs.existsSync(source)) continue;
    const rel = path.relative(path.join(targetRoot, "_local", "gameStore"), source);
    const dest = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(source, dest, { recursive: true, errorOnExist: true });
  }
  for (const target of plan.remove) fs.rmSync(target, { recursive: true, force: true });
  return { backupDir, removed: existing.filter((p) => !fs.existsSync(p)), preservedContentPacks: fs.existsSync(plan.preserve[0]), alreadyPristine: false };
}

function reportMarkdown(state) {
  const s = state.summary || {};
  const m = state.mechanical || {};
  const line = (label, value) => `| ${label} | ${value || "NOT RUN"} |`;
  return [`# EveJS Character Transfer Report`, ``, `Generated: ${new Date().toISOString()}`, `Source: ${state.sourceRoot || ""} (${state.sourceVersion || "unknown"})`, `Target: ${state.targetRoot || ""} (${state.targetVersion || "unknown"})`, `Engine SHA256: ${state.engineSha256 || ""}`, `Bundle SHA256: ${state.bundleSha256 || ""}`, ``, `## Counts`, ``, `Characters: ${s.characters || 0}  `, `Items: ${s.items || 0}  `, `Wallet authority rows: ${s.walletAuthority || 0}  `, `Deferred structures/items: ${s.deferredStructures || 0}/${s.deferredItems || 0}`, ``, `## Mechanical status`, ``, `| Check | Result |`, `|---|---|`, line("DB import", m.dbImport), line("SQLite integrity", m.integrity), line("World-state isolation", m.worldIsolation), line("Wallet authority", m.walletAuthority), line("Portrait copy", m.portraits), line("Gameplay verification", "REQUIRED"), ``, `## Gameplay checklist`, ``, `- Representative player: launch/location, active ship/fitting, personal inventory, portrait.`, `- CEO/corporation: membership/roles, NPC-station corp hangar, skills/queue, bookmarks, current ISK, wallet history, PLEX/AUR if applicable.`, ``, `Migration mechanical checks do not establish gameplay PASS.`].join("\n");
}

module.exports = { ACCEPTED_ENGINE_SHA256, US, sha256, samePath, readJson, releaseVersion, detectVersionInfo, detectVersion, compareVersions, sourceTransferSupport, detectRuntime, detectRunning, validatePair, validateSource, validateTarget, rootChanges, analysisSeverity, reviewReadiness, hasPristineProvenance, parseAbiMismatch, summarizeBundle, parsePortraitOutput, REMEDIATIONS, warningCard, entityLabel, enrichCard, deferredCards, targetResetPlan, prepareFreshTarget, reportMarkdown };
