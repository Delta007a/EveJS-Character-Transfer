#!/usr/bin/env node
"use strict";

/*
 * EveJS Private Identity Transfer r1.7
 *
 * Selective cross-version migration helper for a private EveJS server.
 * Moves player/account/corporation identity + inventory/economy state while
 * intentionally NOT moving world/universe runtime state (dungeons, scheduler,
 * wormholes, NPC runtime, mining runtime, structures, missions, market runtime,
 * etc.).
 *
 * Designed after source review of EveJS v0.12.6 and v0.12.7. Their upstream
 * exportPlayers.js/importPlayers.js/playerTransferShared.js are byte-identical;
 * this tool extends that idea for same-private-universe migrations where corp
 * membership and original IDs should be retained.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOL_NAME = "EveJS-Private-Identity-Transfer";
const TOOL_VERSION = "r1.7";
const BUNDLE_VERSION = 6;
const LEGACY_BUNDLE_VERSION = 5;
const ACHIEVEMENT_TABLE = "achievements";
const ACHIEVEMENT_ROOT_VERSION = 1;
const ACHIEVEMENT_CHARACTER_VERSION = 1;
const ACHIEVEMENT_DEFINITIONS_VERSION = "1.0.3";
const ACHIEVEMENT_TITLES_VERSION = "1.0.0";
const PI_TABLE = "planetRuntimeState";
const PI_SCHEMA_VERSION = 2;
const PI_TRANSFER_SCHEMA_VERSION = 1;
const PI_DEFAULT_NEXT_IDS = Object.freeze({
  pinID: 900_000_000_000,
  routeID: 1,
  launchID: 910_000_000_000,
});
const PI_GROUPS = Object.freeze([
  "resourcesByPlanetID",
  "coloniesByKey",
  "launchesByID",
  "acceptedNetworkEditsByKey",
  "networkEditReceiptsByKey",
]);
const PI_FLAT_KEYS = Object.freeze([
  "schemaVersion",
  "customsOperationReceipts",
  "nextIDs",
]);
const PI_PIN_GROUP_IDS = new Set([1026, 1027, 1028, 1029, 1030, 1063]);
const PI_COMMAND_PIN_GROUP_ID = 1027;
const PI_PROCESS_PIN_GROUP_ID = 1028;
const PI_SPACEPORT_PIN_GROUP_ID = 1030;
const PI_ECU_PIN_GROUP_ID = 1063;
const PI_LINK_GROUP_ID = 1036;
const PI_LAUNCH_CONTAINER_TYPE_ID = 2263;
const PI_CUSTOMS_ESCROW_LOCATION_BASE = 9_600_000_000;
const PI_CUSTOMS_JOB_TYPE = "planet.customs-settle";
const PI_CUSTOMS_JOB_PREFIX = "planet-customs:";
const FILETIME_UNIX_EPOCH_OFFSET = 116_444_736_000_000_000n;
const PI_LAUNCH_ORBIT_DECAY_TICKS = 5n * 24n * 60n * 60n * 10_000_000n;
const US = String.fromCharCode(31);
const PLAYER_CORP_FLOOR = 98_000_000;
const PLAYER_ALLIANCE_FLOOR = 99_000_000;
const CHARACTER_ID_FLOOR = 140_000_001;
const ITEM_ID_FLOOR = 1_990_000_000;
const BLUEPRINT_CATEGORY_ID = 9;
const INDUSTRY_INSTALLED_LOCATION_ID = 2003;
const MAX_MATERIAL_EFFICIENCY = 10;
const MAX_TIME_EFFICIENCY = 20;

// These tables are deliberately never written by r1. The post-import verifier
// fingerprints a critical subset to prove they stayed byte-logically unchanged.
const FORBIDDEN_WORLD_TABLES = Object.freeze([
  "dungeonRuntimeState",
  "scheduledJobs",
  "wormholeRuntimeState",
  "npcRuntimeState",
  "npcRuntimeControllers",
  "miningRuntimeState",
  "missionRuntimeState",
  "probeRuntimeState",
  "planetRuntimeState",
  "structures",
  "moonExtractions",
  "marketRuntime",
  "tradeRuntime",
  "sovereignty",
]);

const SIMPLE_CHARACTER_TABLES = Object.freeze([
  { table: "skills", key: (id) => String(id) },
  { table: "skillPlans", key: (id) => String(id) },
  { table: "skillQueues", key: (id) => String(id) },
  { table: "skillTradingState", key: (id) => String(id) },
  { table: "characterExpertSystems", key: (id) => String(id) },
  { table: "walletAuthorityState", key: (id) => `character:${String(id)}` },
  { table: "lpWallets", key: (id) => exploded("characterWallets", id) },
  { table: "bookmarkKnownFolders", key: (id) => exploded("recordsByCharacterID", id) },
  { table: "savedFittings", key: (id) => exploded("owners", id) },
  { table: "notifications", key: (id) => exploded("boxes", id) },
  { table: "mapTelemetry", key: (id) => exploded("visitsByCharacterID", id) },
  { table: "evermarkEntitlements", key: (id) => exploded("characters", id) },
]);

const SIMPLE_CORPORATION_TABLES = Object.freeze([
  { table: "lpWallets", key: (id) => exploded("corporationWallets", id) },
  { table: "savedFittings", key: (id) => exploded("owners", id) },
]);

const SHIP_SCOPED_TABLES = Object.freeze([
  { table: "moduleGroupingState", group: "ships" },
  { table: "shipDirt", group: "ships" },
  { table: "shipKillCounters", group: "ships" },
  { table: "shipLogoFittings", group: "ships" },
]);

const BLOCKED_CORP_ITEM_CATEGORIES = new Set([
  22, // Deployable
  23, // Starbase
  40, // Sovereignty Structure
  46, // Orbital
  65, // Structure
]);

function exploded(group, id) {
  return `${group}${US}${String(id)}`;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function positive(value, fallback = 0) {
  const n = toInt(value, 0);
  return n > 0 ? n : fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeList(raw) {
  if (raw == null) return null;
  return String(raw)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    command: null,
    sourceRoot: null,
    targetRoot: null,
    sourceSqlite: null,
    targetSqlite: null,
    in: null,
    out: null,
    includeUsers: null,
    excludeUsers: [],
    includeOrphans: false,
    replaceExisting: false,
    apply: false,
    backupDir: null,
    verbose: false,
  };
  const args = [...argv];
  out.command = args.shift() || null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => args[(i += 1)];
    switch (arg) {
      case "--source-root": out.sourceRoot = next(); break;
      case "--target-root": out.targetRoot = next(); break;
      case "--source-sqlite": out.sourceSqlite = next(); break;
      case "--target-sqlite": out.targetSqlite = next(); break;
      case "--in": out.in = next(); break;
      case "--out": out.out = next(); break;
      case "--include-users": out.includeUsers = normalizeList(next()); break;
      case "--exclude-users": out.excludeUsers = normalizeList(next()) || []; break;
      case "--include-orphans": out.includeOrphans = true; break;
      case "--replace-existing": out.replaceExisting = true; break;
      case "--apply": out.apply = true; break;
      case "--backup-dir": out.backupDir = next(); break;
      case "--verbose": out.verbose = true; break;
      case "--help":
      case "-h": out.help = true; break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function printHelp() {
  console.log(`
${TOOL_NAME} ${TOOL_VERSION}

Commands:
  export    Build a portable identity/economy bundle from a source runtime.
  import    Dry-run or apply a bundle into a fresh/disposable target runtime.
  inspect   Print a bundle summary without opening a target DB.
  portraits Dry-run or copy selected character portrait media by preserved characterID.

EXPORT:
  node private-identity-transfer.js export \\
    --source-root G:\\...\\EveJS-0.12.6-test \\
    --out G:\\...\\private-transfer.json

  Optional:
    --include-users user1,user2   Only these account usernames
    --exclude-users test,test2    Skip usernames
    --include-orphans             Include accountless player-range characters

IMPORT DRY-RUN (default, no writes):
  node private-identity-transfer.js import \\
    --target-root G:\\...\\EveJS-0.12.7-test \\
    --in G:\\...\\private-transfer.json

IMPORT APPLY:
  node private-identity-transfer.js import \\
    --target-root G:\\...\\EveJS-0.12.7-test \\
    --in G:\\...\\private-transfer.json \\
    --replace-existing --apply


PORTRAIT MEDIA DRY-RUN:
  node private-identity-transfer.js portraits \
    --source-root G:\\...\\EveJS-0.12.7-test \
    --target-root G:\\...\\EveJS-0.12.7.1-test \
    --in G:\\...\\private-transfer.json

PORTRAIT MEDIA APPLY:
  node private-identity-transfer.js portraits \
    --source-root G:\\...\\EveJS-0.12.7-test \
    --target-root G:\\...\\EveJS-0.12.7.1-test \
    --in G:\\...\\private-transfer.json --apply

Important:
  * Target server MUST be stopped for import.
  * --apply alone is not enough if IDs/usernames collide; use
    --replace-existing only for a fresh/disposable target whose canonical
    fixture rows are intentionally being replaced by the source state.
  * r1.7 classic transfer defers player structures and their inventory domain.
  * Optional structure transfer is a separate later pass; world runtime remains excluded here.
`);
}

function runtimeSqlite(root) {
  return path.join(path.resolve(root), "_local", "gameStore", "gamestore.sqlite");
}

function runtimePortraitDir(root) {
  return path.join(path.resolve(root), "_local", "gameStore", "images", "Character");
}

function serverRoot(root) {
  return path.join(path.resolve(root), "server");
}

function loadBetterSqlite(runtimeRoot) {
  const candidates = [
    path.join(serverRoot(runtimeRoot), "node_modules", "better-sqlite3"),
    path.join(path.resolve(runtimeRoot), "node_modules", "better-sqlite3"),
    "better-sqlite3",
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error && error.message ? error.message : error}`);
    }
  }
  throw new Error(
    "Could not load better-sqlite3. Run this with an EveJS runtime whose server dependencies are installed.\n" +
      errors.join("\n"),
  );
}

function q(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table));
}

function getRow(db, table, key) {
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`SELECT key,json FROM ${q(table)} WHERE key=?`).get(String(key));
  if (!row) return null;
  return { key: row.key, value: JSON.parse(row.json) };
}

function allRows(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT key,json FROM ${q(table)}`).all().map((row) => ({
    key: row.key,
    value: JSON.parse(row.json),
  }));
}

function putRow(db, table, key, value) {
  if (!tableExists(db, table)) {
    throw new Error(`Target table does not exist: ${table}`);
  }
  db.prepare(
    `INSERT INTO ${q(table)} (key,json) VALUES (?,?) ` +
      "ON CONFLICT(key) DO UPDATE SET json=excluded.json",
  ).run(String(key), JSON.stringify(value));
}

function deleteRow(db, table, key) {
  if (!tableExists(db, table)) return 0;
  return db.prepare(`DELETE FROM ${q(table)} WHERE key=?`).run(String(key)).changes;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function achievementAbort(message) {
  throw new Error(`SAFETY ABORT: achievement state ${message}`);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    achievementAbort(`${label} must be an array of strings`);
  }
}

function assertStringArrayMap(value, label) {
  if (!isRecord(value)) achievementAbort(`${label} must be an object`);
  for (const [key, entries] of Object.entries(value)) {
    if (!key) achievementAbort(`${label} contains an empty key`);
    assertStringArray(entries, `${label}.${key}`);
  }
}

function validateAchievementCharacterState(value, ownerKey, context) {
  if (!/^[1-9]\d*$/.test(String(ownerKey))) {
    achievementAbort(`${context} has invalid character key ${ownerKey}`);
  }
  const characterID = Number(ownerKey);
  if (!Number.isSafeInteger(characterID) || !isRecord(value)) {
    achievementAbort(`${context} character ${ownerKey} is not a valid object`);
  }
  if (value.version !== ACHIEVEMENT_CHARACTER_VERSION) {
    achievementAbort(`${context} character ${ownerKey} has unsupported state version ${value.version}`);
  }
  if (value.characterID !== characterID) {
    achievementAbort(`${context} character key/value ownership mismatch for ${ownerKey}`);
  }
  if (!isRecord(value.achievementsById)) {
    achievementAbort(`${context} character ${ownerKey}.achievementsById must be an object`);
  }
  for (const [achievementID, state] of Object.entries(value.achievementsById)) {
    if (!achievementID || !isRecord(state)) {
      achievementAbort(`${context} character ${ownerKey} has malformed achievement ${achievementID}`);
    }
    if (!isNonNegativeInteger(state.progressValue) ||
        !isNonNegativeInteger(state.completedAtMs) ||
        !isNonNegativeInteger(state.updatedAtMs)) {
      achievementAbort(`${context} character ${ownerKey} achievement ${achievementID} has invalid counters`);
    }
    assertStringArrayMap(
      state.checklistValuesByType,
      `${context} character ${ownerKey} achievement ${achievementID}.checklistValuesByType`,
    );
    assertStringArrayMap(
      state.hiddenUniqueValuesByType,
      `${context} character ${ownerKey} achievement ${achievementID}.hiddenUniqueValuesByType`,
    );
    if (!isRecord(state.reachedMilestonesById)) {
      achievementAbort(`${context} character ${ownerKey} achievement ${achievementID}.reachedMilestonesById must be an object`);
    }
    for (const [milestoneID, receipt] of Object.entries(state.reachedMilestonesById)) {
      if (!milestoneID || !isRecord(receipt) ||
          !isNonNegativeInteger(receipt.reachedAtMs) ||
          !isNonNegativeInteger(receipt.categoryPointsAwarded)) {
        achievementAbort(`${context} character ${ownerKey} achievement ${achievementID} has malformed milestone ${milestoneID}`);
      }
    }
  }
  if (!isRecord(value.categoryScoresById) ||
      Object.entries(value.categoryScoresById).some(([key, score]) => !key || !isNonNegativeInteger(score)) ||
      !isNonNegativeInteger(value.totalScore) ||
      !isRecord(value.unclaimedSourcesByKey) ||
      !isRecord(value.claimedRewardKeys)) {
    achievementAbort(`${context} character ${ownerKey} has malformed score/reward state`);
  }
  for (const [sourceKey, source] of Object.entries(value.unclaimedSourcesByKey)) {
    if (!sourceKey || !isRecord(source) || typeof source.sourceKind !== "string" ||
        typeof source.sourceID !== "string" || typeof source.milestoneID !== "string" ||
        !isNonNegativeInteger(source.createdAtMs)) {
      achievementAbort(`${context} character ${ownerKey} has malformed pending reward ${sourceKey}`);
    }
    assertStringArray(source.rewardIds, `${context} character ${ownerKey} pending reward ${sourceKey}.rewardIds`);
  }
  for (const [rewardKey, receipt] of Object.entries(value.claimedRewardKeys)) {
    if (!rewardKey || !isRecord(receipt) || !isNonNegativeInteger(receipt.claimedAtMs)) {
      achievementAbort(`${context} character ${ownerKey} has malformed claimed reward ${rewardKey}`);
    }
  }
  assertStringArray(value.ownedTitleIds, `${context} character ${ownerKey}.ownedTitleIds`);
  if (value.ownedTitleIds.some((titleID) => !titleID) ||
      (value.equippedTitleId !== null &&
       (typeof value.equippedTitleId !== "string" || !value.equippedTitleId))) {
    achievementAbort(`${context} character ${ownerKey}.equippedTitleId must be a string or null`);
  }
  if (!isRecord(value.legacyTracker) ||
      !isRecord(value.legacyTracker.completedByAchievementId) ||
      !isRecord(value.legacyTracker.eventCountsByName) ||
      typeof value.legacyTracker.hasEverWarped !== "boolean" ||
      Object.entries(value.legacyTracker.completedByAchievementId)
        .some(([key, entry]) => !/^[1-9]\d*$/.test(key) || typeof entry !== "string" || !/^\d+$/.test(entry)) ||
      Object.entries(value.legacyTracker.eventCountsByName)
        .some(([key, entry]) => !key || !isNonNegativeInteger(entry)) ||
      !isNonNegativeInteger(value.createdAtMs) ||
      !isNonNegativeInteger(value.updatedAtMs)) {
    achievementAbort(`${context} character ${ownerKey} has malformed legacy/timestamp state`);
  }
  return characterID;
}

function readAchievementRoot(db, context) {
  if (!tableExists(db, ACHIEVEMENT_TABLE)) return null;
  const rows = allRows(db, ACHIEVEMENT_TABLE);
  if (rows.length === 0) return null;
  const keys = new Set(rows.map((row) => String(row.key)));
  const unknown = [...keys].filter((key) => key !== "version" && key !== "characters");
  if (unknown.length || !keys.has("version") || !keys.has("characters") || rows.length !== 2) {
    achievementAbort(`${context} root has invalid physical keys${unknown.length ? `: ${unknown.join(", ")}` : ""}`);
  }
  const version = rows.find((row) => String(row.key) === "version").value;
  const characters = rows.find((row) => String(row.key) === "characters").value;
  if (version !== ACHIEVEMENT_ROOT_VERSION || !isRecord(characters)) {
    achievementAbort(`${context} root schema/version is incompatible`);
  }
  for (const [ownerKey, state] of Object.entries(characters)) {
    validateAchievementCharacterState(state, ownerKey, context);
  }
  return { version, characters: clone(characters) };
}

function achievementDataPaths(runtimeRoot) {
  const base = path.join(
    path.resolve(runtimeRoot), "server", "src", "services", "achievement",
  );
  return {
    state: path.join(base, "achievementState.js"),
    definitions: path.join(base, "data", "definitions.json"),
    titles: path.join(base, "data", "titles.json"),
  };
}

function readAchievementCompatibility(runtimeRoot, context) {
  const files = achievementDataPaths(runtimeRoot);
  for (const [kind, filePath] of Object.entries(files)) {
    if (!fs.existsSync(filePath)) {
      achievementAbort(`${context} lacks native achievement ${kind} authority at ${filePath}`);
    }
  }
  const stateSource = fs.readFileSync(files.state, "utf8");
  if (!/const\s+TABLE_NAME\s*=\s*["']achievements["']\s*;/.test(stateSource) ||
      !/const\s+ROOT_VERSION\s*=\s*1\s*;/.test(stateSource)) {
    achievementAbort(`${context} native achievement root authority is incompatible`);
  }
  let definitions;
  let titles;
  try {
    definitions = JSON.parse(fs.readFileSync(files.definitions, "utf8"));
    titles = JSON.parse(fs.readFileSync(files.titles, "utf8"));
  } catch (error) {
    achievementAbort(`${context} catalog JSON is invalid: ${error.message}`);
  }
  const result = {
    definitionsVersion: String(definitions && definitions.version && definitions.version.raw || ""),
    titlesVersion: String(titles && titles.version && titles.version.raw || ""),
  };
  if (result.definitionsVersion !== ACHIEVEMENT_DEFINITIONS_VERSION ||
      result.titlesVersion !== ACHIEVEMENT_TITLES_VERSION) {
    achievementAbort(
      `${context} catalog versions are incompatible ` +
      `(definitions ${result.definitionsVersion || "missing"}, titles ${result.titlesVersion || "missing"})`,
    );
  }
  return result;
}

function collectAchievementTransfer(db, runtimeRoot, selectedCharacterIDs) {
  const root = readAchievementRoot(db, "source");
  if (!root) return null;
  const characters = {};
  for (const characterID of [...selectedCharacterIDs].sort((a, b) => a - b)) {
    const key = String(characterID);
    if (Object.prototype.hasOwnProperty.call(root.characters, key)) {
      characters[key] = clone(root.characters[key]);
    }
  }
  if (Object.keys(characters).length === 0) return null;
  const compatibility = readAchievementCompatibility(runtimeRoot, "source");
  return {
    schemaVersion: 1,
    rootVersion: ACHIEVEMENT_ROOT_VERSION,
    ...compatibility,
    characters,
  };
}

function piAbort(message) {
  throw new Error(`SAFETY ABORT: planetary interaction ${message}`);
}

function isCanonicalPositiveID(value) {
  return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
}

function assertExactKeys(value, required, label, optional = []) {
  if (!isRecord(value)) piAbort(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) {
    piAbort(
      `${label} has incompatible keys` +
      `${missing.length ? `; missing ${missing.join(", ")}` : ""}` +
      `${unknown.length ? `; unknown ${unknown.join(", ")}` : ""}`,
    );
  }
}

function readPiRuntimeRoot(db, context, { allowAbsent = true } = {}) {
  if (!tableExists(db, PI_TABLE)) {
    if (allowAbsent) return null;
    piAbort(`${context} lacks ${PI_TABLE}`);
  }
  const rows = allRows(db, PI_TABLE);
  if (!rows.length) {
    if (allowAbsent) return null;
    piAbort(`${context} ${PI_TABLE} is empty`);
  }
  const root = Object.fromEntries(PI_GROUPS.map((group) => [group, {}]));
  const seen = new Set();
  for (const row of rows) {
    const key = String(row.key);
    if (seen.has(key)) piAbort(`${context} has duplicate physical row ${key}`);
    seen.add(key);
    const separator = key.indexOf(US);
    if (separator >= 0) {
      const group = key.slice(0, separator);
      const entityKey = key.slice(separator + 1);
      if (!PI_GROUPS.includes(group) || !entityKey || entityKey.includes(US)) {
        piAbort(`${context} has unknown physical row ${key}`);
      }
      if (!isRecord(row.value)) piAbort(`${context} row ${key} must be an object`);
      root[group][entityKey] = clone(row.value);
      continue;
    }
    if (PI_GROUPS.includes(key)) {
      if (!isRecord(row.value) || Object.keys(row.value).length !== 0) {
        piAbort(`${context} group skeleton ${key} is malformed`);
      }
      continue;
    }
    if (!PI_FLAT_KEYS.includes(key)) piAbort(`${context} has unknown physical row ${key}`);
    root[key] = clone(row.value);
  }
  const required = [...PI_GROUPS, ...PI_FLAT_KEYS];
  const missing = required.filter((key) => !seen.has(key));
  if (missing.length) piAbort(`${context} root is missing physical rows: ${missing.join(", ")}`);
  if (root.schemaVersion !== PI_SCHEMA_VERSION) {
    piAbort(`${context} schema version ${root.schemaVersion} is incompatible`);
  }
  if (!isRecord(root.customsOperationReceipts)) {
    piAbort(`${context} customsOperationReceipts must be an object`);
  }
  assertExactKeys(root.nextIDs, ["pinID", "routeID", "launchID"], `${context}.nextIDs`);
  for (const key of ["pinID", "routeID", "launchID"]) {
    if (!Number.isSafeInteger(root.nextIDs[key]) || root.nextIDs[key] <= 0) {
      piAbort(`${context}.nextIDs.${key} is invalid`);
    }
  }
  return root;
}

function emptyPiRuntimeRoot() {
  return {
    schemaVersion: PI_SCHEMA_VERSION,
    resourcesByPlanetID: {},
    coloniesByKey: {},
    launchesByID: {},
    acceptedNetworkEditsByKey: {},
    networkEditReceiptsByKey: {},
    customsOperationReceipts: {},
    nextIDs: clone(PI_DEFAULT_NEXT_IDS),
  };
}

function assertPiContents(contents, label, referencedTypeIDs) {
  if (!isRecord(contents)) piAbort(`${label} must be an object`);
  for (const [typeKey, quantity] of Object.entries(contents)) {
    if (!isCanonicalPositiveID(typeKey) || !Number.isSafeInteger(quantity) || quantity <= 0) {
      piAbort(`${label} contains invalid commodity ${typeKey}`);
    }
    referencedTypeIDs.add(Number(typeKey));
  }
}

function validatePiColony(colony, colonyKey, context) {
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(String(colonyKey));
  if (!match || !isRecord(colony)) piAbort(`${context} colony ${colonyKey} is malformed`);
  const planetID = Number(match[1]);
  const ownerID = Number(match[2]);
  if (!Number.isSafeInteger(planetID) || !Number.isSafeInteger(ownerID) ||
      colony.planetID !== planetID || colony.ownerID !== ownerID) {
    piAbort(`${context} colony key/value ownership mismatch for ${colonyKey}`);
  }
  if (!Number.isSafeInteger(colony.solarSystemID) || colony.solarSystemID <= 0 ||
      !Number.isSafeInteger(colony.planetTypeID) || colony.planetTypeID <= 0 ||
      colony.typeID !== colony.planetTypeID ||
      !Number.isFinite(colony.planetRadius) || colony.planetRadius <= 0 ||
      !Number.isSafeInteger(colony.level) || colony.level < 0 || colony.level > 5 ||
      colony.commandCenterLevel !== colony.level ||
      !Number.isSafeInteger(colony.networkRevision) || colony.networkRevision < 0 ||
      typeof colony.currentSimTime !== "string" || !/^\d+$/.test(colony.currentSimTime) ||
      !Array.isArray(colony.pins) || !Array.isArray(colony.links) || !Array.isArray(colony.routes)) {
    piAbort(`${context} colony ${colonyKey} has an invalid persisted shape`);
  }

  const pinIDs = new Set();
  const routeIDs = new Set();
  const referencedTypeIDs = new Set();
  let commandPins = 0;
  for (const pin of colony.pins) {
    if (!isRecord(pin) || !Number.isSafeInteger(pin.pinID) || pin.pinID <= 0 ||
        pin.id !== pin.pinID || pin.ownerID !== ownerID ||
        !Number.isSafeInteger(pin.typeID) || pin.typeID <= 0 || pinIDs.has(pin.pinID) ||
        !Number.isFinite(pin.latitude) || !Number.isFinite(pin.longitude) ||
        !Number.isSafeInteger(pin.state) || pin.state < 0 ||
        typeof pin.lastRunTime !== "string" || !/^\d+$/.test(pin.lastRunTime)) {
      piAbort(`${context} colony ${colonyKey} has a malformed, duplicate, or foreign-owned pin`);
    }
    pinIDs.add(pin.pinID);
    referencedTypeIDs.add(pin.typeID);
    assertPiContents(pin.contents, `${context} colony ${colonyKey} pin ${pin.pinID}.contents`, referencedTypeIDs);
  }

  const linkPairs = new Set();
  for (const link of colony.links) {
    if (!isRecord(link) || !Number.isSafeInteger(link.typeID) || link.typeID <= 0 ||
        !Number.isSafeInteger(link.endpoint1) || !Number.isSafeInteger(link.endpoint2) ||
        !Number.isSafeInteger(link.level) || link.level < 0 ||
        link.endpoint1 >= link.endpoint2 || !pinIDs.has(link.endpoint1) || !pinIDs.has(link.endpoint2)) {
      piAbort(`${context} colony ${colonyKey} has a malformed link or missing pin reference`);
    }
    const pair = `${link.endpoint1}:${link.endpoint2}`;
    if (linkPairs.has(pair)) piAbort(`${context} colony ${colonyKey} has duplicate link ${pair}`);
    linkPairs.add(pair);
    referencedTypeIDs.add(link.typeID);
  }

  for (const route of colony.routes) {
    if (!isRecord(route) || !Number.isSafeInteger(route.routeID) || route.routeID <= 0 ||
        routeIDs.has(route.routeID) || route.charID !== ownerID ||
        !Array.isArray(route.path) || route.path.length < 2 ||
        !Number.isSafeInteger(route.commodityTypeID) || route.commodityTypeID <= 0 ||
        !Number.isSafeInteger(route.commodityQuantity) || route.commodityQuantity <= 0) {
      piAbort(`${context} colony ${colonyKey} has a malformed, duplicate, or foreign-owned route`);
    }
    routeIDs.add(route.routeID);
    referencedTypeIDs.add(route.commodityTypeID);
    for (const pinID of route.path) {
      if (!Number.isSafeInteger(pinID) || !pinIDs.has(pinID)) {
        piAbort(`${context} colony ${colonyKey} route ${route.routeID} references a missing pin`);
      }
    }
    for (let index = 1; index < route.path.length; index += 1) {
      const pair = [route.path[index - 1], route.path[index]].sort((a, b) => a - b).join(":");
      if (!linkPairs.has(pair)) {
        piAbort(`${context} colony ${colonyKey} route ${route.routeID} references a missing link`);
      }
    }
  }
  return { planetID, ownerID, pinIDs, routeIDs, referencedTypeIDs, commandPins };
}

function readPiCompatibility(runtimeRoot, context) {
  const runtimeStorePath = path.join(
    path.resolve(runtimeRoot), "server", "src", "services", "planet", "planetRuntimeStore.js",
  );
  if (!fs.existsSync(runtimeStorePath)) {
    piAbort(`${context} lacks native PI runtime authority at ${runtimeStorePath}`);
  }
  const source = fs.readFileSync(runtimeStorePath, "utf8");
  if (!/const\s+TABLE_NAME\s*=\s*["']planetRuntimeState["']\s*;/.test(source) ||
      !/const\s+SCHEMA_VERSION\s*=\s*2\s*;/.test(source)) {
    piAbort(`${context} native PI schema authority is incompatible`);
  }

  // Processor output is computed from target config when a cycle runs, not
  // persisted as precomputed future output. It is not a transfer compatibility gate.
  return { runtimeSchemaVersion: PI_SCHEMA_VERSION };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function normalizePiSchematic(row = {}) {
  const localName = row.name && typeof row.name === "object" ? row.name.en : row.name;
  const normalizeEntries = (entries) => (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      typeID: positive(entry && (entry.typeID ?? entry._key), 0),
      quantity: positive(entry && entry.quantity, 0),
    }))
    .filter((entry) => entry.typeID && entry.quantity)
    .sort((left, right) => left.typeID - right.typeID);
  return {
    schematicID: positive(row.schematicID ?? row._key, 0),
    name: String(localName || ""),
    cycleTime: positive(row.cycleTime, 0),
    pinTypeIDs: [...new Set(
      (Array.isArray(row.pinTypeIDs) ? row.pinTypeIDs : row.pins || [])
        .map((typeID) => positive(typeID, 0)).filter(Boolean),
    )].sort((a, b) => a - b),
    inputs: normalizeEntries(row.inputs),
    outputs: normalizeEntries(row.outputs),
  };
}

function piReferencedAuthority(coloniesByKey, runtimeRoot, context) {
  const celestialRows = staticRows(runtimeRoot, "celestials", "celestials");
  const schematicRows = staticRows(runtimeRoot, "planetSchematics", "schematics");
  const itemTypeRows = staticRows(runtimeRoot, "itemTypes", "types");
  const typeDogmaPayload = readStaticPayload(runtimeRoot, "typeDogma").payload;
  const planetByID = new Map();
  for (const row of celestialRows) {
    if (!row || (row.kind !== "planet" && row.groupName !== "Planet")) continue;
    const planetID = positive(row.itemID, 0);
    if (planetID) {
      planetByID.set(planetID, {
        planetID,
        solarSystemID: positive(row.solarSystemID, 0),
        typeID: positive(row.typeID, 0),
        radius: Number(row.radius) || 0,
      });
    }
  }
  const schematicByID = new Map();
  for (const row of schematicRows) {
    const normalized = normalizePiSchematic(row);
    if (normalized.schematicID) schematicByID.set(normalized.schematicID, normalized);
  }
  const typeByID = new Map();
  for (const row of itemTypeRows) {
    const typeID = positive(row && (row.typeID ?? row._key), 0);
    if (typeID) typeByID.set(typeID, row);
  }
  const dogmaByID = isRecord(typeDogmaPayload.typesByTypeID)
    ? typeDogmaPayload.typesByTypeID
    : {};

  const planets = {};
  const schematics = {};
  const types = {};
  const dogma = {};
  for (const [colonyKey, colony] of Object.entries(coloniesByKey).sort(([a], [b]) => a.localeCompare(b))) {
    const validated = validatePiColony(colony, colonyKey, context);
    const planet = planetByID.get(validated.planetID);
    if (!planet || planet.solarSystemID !== colony.solarSystemID ||
        planet.typeID !== colony.planetTypeID || planet.radius !== colony.planetRadius) {
      piAbort(`${context} colony ${colonyKey} does not match static planet authority`);
    }
    planets[String(validated.planetID)] = planet;

    let commandPins = 0;
    for (const pin of colony.pins) {
      const type = typeByID.get(pin.typeID);
      const groupID = positive(type && (type.groupID ?? type.groupId), 0);
      if (!type || !PI_PIN_GROUP_IDS.has(groupID)) {
        piAbort(`${context} colony ${colonyKey} pin ${pin.pinID} has incompatible static type ${pin.typeID}`);
      }
      if (groupID === PI_COMMAND_PIN_GROUP_ID) commandPins += 1;
      if ((groupID === PI_COMMAND_PIN_GROUP_ID || groupID === PI_SPACEPORT_PIN_GROUP_ID) &&
          (typeof pin.lastLaunchTime !== "string" || !/^\d+$/.test(pin.lastLaunchTime))) {
        piAbort(`${context} colony ${colonyKey} pin ${pin.pinID} has malformed launch timing state`);
      }
      if (groupID === PI_PROCESS_PIN_GROUP_ID) {
        if (typeof pin.hasReceivedInputs !== "boolean" ||
            typeof pin.receivedInputsLastCycle !== "boolean") {
          piAbort(`${context} colony ${colonyKey} pin ${pin.pinID} has malformed processor state`);
        }
        if (pin.schematicID !== null && pin.schematicID !== undefined) {
          if (!Number.isSafeInteger(pin.schematicID) || pin.schematicID <= 0 ||
              !schematicByID.has(pin.schematicID)) {
            piAbort(`${context} colony ${colonyKey} pin ${pin.pinID} has missing schematic authority`);
          }
          schematics[String(pin.schematicID)] = schematicByID.get(pin.schematicID);
        }
      }
      if (groupID === PI_ECU_PIN_GROUP_ID) {
        const validFiletime = (value) => value === null ||
          (typeof value === "string" && /^\d+$/.test(value));
        if (!Number.isSafeInteger(pin.cycleTime) || pin.cycleTime < 0 ||
            !Number.isSafeInteger(pin.qtyPerCycle) || pin.qtyPerCycle < 0 ||
            !validFiletime(pin.expiryTime) || !validFiletime(pin.installTime) ||
            !Number.isFinite(pin.headRadius) || pin.headRadius <= 0 ||
            !Array.isArray(pin.heads)) {
          piAbort(`${context} colony ${colonyKey} pin ${pin.pinID} has malformed ECU state`);
        }
        const headIDs = new Set();
        for (const head of pin.heads) {
          if (!Array.isArray(head) || head.length !== 3 ||
              !Number.isSafeInteger(head[0]) || head[0] < 0 || headIDs.has(head[0]) ||
              !Number.isFinite(head[1]) || !Number.isFinite(head[2])) {
            piAbort(`${context} colony ${colonyKey} pin ${pin.pinID} has malformed ECU head state`);
          }
          headIDs.add(head[0]);
        }
      }
      if (pin.programType !== null && pin.programType !== undefined) {
        if (!Number.isSafeInteger(pin.programType) || pin.programType <= 0) {
          piAbort(`${context} colony ${colonyKey} pin ${pin.pinID} has invalid ECU programType`);
        }
        validated.referencedTypeIDs.add(pin.programType);
      }
    }
    if (commandPins !== 1) {
      piAbort(`${context} colony ${colonyKey} must have exactly one command-center pin`);
    }
    for (const link of colony.links) {
      const type = typeByID.get(link.typeID);
      if (positive(type && (type.groupID ?? type.groupId), 0) !== PI_LINK_GROUP_ID) {
        piAbort(`${context} colony ${colonyKey} link has incompatible static type ${link.typeID}`);
      }
    }
    for (const typeID of [...validated.referencedTypeIDs].sort((a, b) => a - b)) {
      const type = typeByID.get(typeID);
      if (!type) piAbort(`${context} colony ${colonyKey} references missing static type ${typeID}`);
      types[String(typeID)] = stableValue(type);
      const dogmaRow = dogmaByID[String(typeID)];
      dogma[String(typeID)] = dogmaRow === undefined ? null : stableValue(dogmaRow);
    }
  }
  return {
    schemaVersion: 1,
    planets: stableValue(planets),
    schematics: stableValue(schematics),
    types: stableValue(types),
    dogma: stableValue(dogma),
  };
}

function readCustomsSettlementRoot(db, context) {
  if (!tableExists(db, "planetaryCustomsSettlements")) return null;
  const rows = readFlatRoot(db, "planetaryCustomsSettlements");
  assertExactKeys(
    rows,
    ["version", "nextOperationID", "byCharacter"],
    `${context} planetaryCustomsSettlements`,
  );
  if (rows.version !== 1 || !Number.isSafeInteger(rows.nextOperationID) ||
      rows.nextOperationID <= 0 || !isRecord(rows.byCharacter)) {
    piAbort(`${context} planetaryCustomsSettlements root is malformed`);
  }
  for (const [ownerKey, settlement] of Object.entries(rows.byCharacter)) {
    if (!isCanonicalPositiveID(ownerKey) || !isRecord(settlement) ||
        settlement.characterID !== Number(ownerKey)) {
      piAbort(`${context} planetary customs settlement ownership is malformed for ${ownerKey}`);
    }
  }
  return rows;
}

function assertPiQuiescent(db, root, selectedCharacterIDs, context) {
  const nowFileTime = (BigInt(Date.now()) * 10_000n) + FILETIME_UNIX_EPOCH_OFFSET;
  for (const [launchKey, launch] of Object.entries(root && root.launchesByID || {})) {
    if (!isCanonicalPositiveID(launchKey) || !isRecord(launch) ||
        launch.launchID !== Number(launchKey) ||
        !Number.isSafeInteger(launch.ownerID) || launch.ownerID <= 0 ||
        typeof launch.deleted !== "boolean" ||
        typeof launch.launchTime !== "string" || !/^\d+$/.test(launch.launchTime)) {
      piAbort(`${context} launch ${launchKey} is malformed`);
    }
    const ownerID = positive(launch.ownerID, 0);
    const launchTime = BigInt(launch.launchTime);
    const expired = nowFileTime >= launchTime &&
      nowFileTime - launchTime >= PI_LAUNCH_ORBIT_DECAY_TICKS;
    if (selectedCharacterIDs.has(ownerID) &&
        ((!launch.deleted && !expired) || positive(launch.physicalContainerID, 0))) {
      piAbort(`${context} character ${ownerID} has a live planetary launch/container`);
    }
  }
  const customsRoot = readCustomsSettlementRoot(db, context);
  for (const characterID of selectedCharacterIDs) {
    if (customsRoot &&
        Object.prototype.hasOwnProperty.call(customsRoot.byCharacter, String(characterID)) &&
        customsRoot.byCharacter[String(characterID)] != null) {
      piAbort(`${context} character ${characterID} has a pending planetary customs settlement/escrow`);
    }
  }
  const lastAllocatedEscrowLocation = customsRoot && customsRoot.nextOperationID > 1
    ? PI_CUSTOMS_ESCROW_LOCATION_BASE + ((customsRoot.nextOperationID - 1) * 2) + 1
    : 0;
  if (lastAllocatedEscrowLocation && !Number.isSafeInteger(lastAllocatedEscrowLocation)) {
    piAbort(`${context} planetary customs escrow allocator is unsafe`);
  }
  for (const row of allRows(db, "items")) {
    if (String(row.key).includes(US)) continue;
    const item = row.value || {};
    if (!selectedCharacterIDs.has(positive(item.ownerID, 0))) continue;
    let launchMarker = false;
    if (typeof item.customInfo === "string" && item.customInfo.trim()) {
      try {
        const customInfo = JSON.parse(item.customInfo);
        launchMarker = Boolean(customInfo && customInfo.evejsPiLaunch);
      } catch (_) {
        // A type-2263 item is independently sufficient to block; unrelated
        // malformed customInfo is not interpreted or normalized here.
      }
    }
    if (positive(item.typeID, 0) === PI_LAUNCH_CONTAINER_TYPE_ID || launchMarker) {
      piAbort(`${context} character ${item.ownerID} retains a physical planetary launch container`);
    }
    const locationID = positive(item.locationID, 0);
    if (lastAllocatedEscrowLocation &&
        locationID >= PI_CUSTOMS_ESCROW_LOCATION_BASE + 2 &&
        locationID <= lastAllocatedEscrowLocation) {
      piAbort(`${context} character ${item.ownerID} retains planetary customs escrow inventory`);
    }
  }
  for (const row of allRows(db, "scheduledJobs")) {
    const job = row.value || {};
    const keyMatch = new RegExp(`^${PI_CUSTOMS_JOB_PREFIX}(\\d+)$`).exec(String(row.key));
    const jobOwner = positive(job.payload && job.payload.characterID, keyMatch ? keyMatch[1] : 0);
    if (selectedCharacterIDs.has(jobOwner) &&
        (String(row.key).startsWith(PI_CUSTOMS_JOB_PREFIX) || job.type === PI_CUSTOMS_JOB_TYPE)) {
      piAbort(`${context} character ${jobOwner} has a planetary customs recovery/scheduled job`);
    }
  }
}

function collectPlanetaryInteractionTransfer(db, runtimeRoot, selectedCharacterIDs) {
  const root = readPiRuntimeRoot(db, "source", { allowAbsent: true });
  if (!root) {
    assertPiQuiescent(db, emptyPiRuntimeRoot(), selectedCharacterIDs, "source");
    return null;
  }
  const allValidated = new Map();
  const coloniesByKey = {};
  for (const [colonyKey, colony] of Object.entries(root.coloniesByKey)) {
    const validated = validatePiColony(colony, colonyKey, "source");
    allValidated.set(colonyKey, validated);
    if (selectedCharacterIDs.has(validated.ownerID)) coloniesByKey[colonyKey] = clone(colony);
  }
  assertPiQuiescent(db, root, selectedCharacterIDs, "source");
  if (!Object.keys(coloniesByKey).length) return null;
  const compatibility = readPiCompatibility(runtimeRoot, "source");
  const staticAuthority = piReferencedAuthority(coloniesByKey, runtimeRoot, "source");
  const seenPins = new Set();
  const seenRoutes = new Set();
  let maxPinID = 0;
  let maxRouteID = 0;
  for (const [colonyKey, colony] of Object.entries(coloniesByKey)) {
    const validated = allValidated.get(colonyKey);
    for (const pinID of validated.pinIDs) {
      if (seenPins.has(pinID)) piAbort(`source selected colonies duplicate pin ID ${pinID}`);
      seenPins.add(pinID);
      maxPinID = Math.max(maxPinID, pinID);
    }
    for (const routeID of validated.routeIDs) {
      if (seenRoutes.has(routeID)) piAbort(`source selected colonies duplicate route ID ${routeID}`);
      seenRoutes.add(routeID);
      maxRouteID = Math.max(maxRouteID, routeID);
    }
    void colony;
  }
  return {
    schemaVersion: PI_TRANSFER_SCHEMA_VERSION,
    runtimeSchemaVersion: compatibility.runtimeSchemaVersion,
    coloniesByKey,
    allocatorRequirements: { maxPinID, maxRouteID },
    staticAuthority,
  };
}

function readVersion(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(serverRoot(root), "package.json"), "utf8"));
    return String(pkg.version || "unknown");
  } catch (_) {
    return "unknown";
  }
}

function integrity(db) {
  const rows = db.pragma("integrity_check");
  const ok = Array.isArray(rows) && rows.length === 1 && rows[0].integrity_check === "ok";
  return { ok, rows };
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();
}

function fingerprintTable(db, table) {
  if (!tableExists(db, table)) return "MISSING";
  const rows = db.prepare(`SELECT key,json FROM ${q(table)} ORDER BY key`).all();
  const h = crypto.createHash("sha256");
  for (const row of rows) {
    h.update(String(row.key));
    h.update("\0");
    h.update(String(row.json));
    h.update("\n");
  }
  return `${rows.length}:${h.digest("hex").toUpperCase()}`;
}

function fingerprintWorld(db) {
  const out = {};
  for (const table of FORBIDDEN_WORLD_TABLES) {
    // Personal PI colonies are the sole intentionally mutable slice of this
    // otherwise forbidden table. Its world-owned slices have a dedicated
    // logical fingerprint below.
    if (table === PI_TABLE) continue;
    out[table] = fingerprintTable(db, table);
  }
  return out;
}

function snapshotProtectedPiState(db, bundle) {
  if (!bundle || !bundle.planetaryInteraction) {
    return { fullTableFingerprint: fingerprintTable(db, PI_TABLE) };
  }
  const importedKeys = new Set(Object.keys(bundle && bundle.planetaryInteraction &&
    bundle.planetaryInteraction.coloniesByKey || {}));
  const root = readPiRuntimeRoot(db, "target", { allowAbsent: true }) || emptyPiRuntimeRoot();
  const unrelatedColonies = {};
  for (const [key, colony] of Object.entries(root.coloniesByKey)) {
    if (!importedKeys.has(key)) unrelatedColonies[key] = clone(colony);
  }
  return stableValue({
    schemaVersion: root.schemaVersion,
    resourcesByPlanetID: root.resourcesByPlanetID,
    unrelatedColonies,
    launchesByID: root.launchesByID,
    acceptedNetworkEditsByKey: root.acceptedNetworkEditsByKey,
    networkEditReceiptsByKey: root.networkEditReceiptsByKey,
    customsOperationReceipts: root.customsOperationReceipts,
    launchAllocator: root.nextIDs.launchID,
  });
}

function summarizeBundle(bundle) {
  const rows = bundle.rows || {};
  const blueprintSummary = bundle.blueprintSummary || {};
  const achievementCharacters = bundle.achievements && bundle.achievements.characters || {};
  const piColonies = bundle.planetaryInteraction && bundle.planetaryInteraction.coloniesByKey || {};
  return {
    sourceVersion: bundle.source && bundle.source.version,
    accounts: (rows.accounts || []).length,
    characters: (rows.characters || []).length,
    corporations: (bundle.corporations || []).length,
    alliances: (bundle.alliances || []).length,
    items: (rows.items || []).length,
    mailMessages: (rows.mail || []).filter((r) => r.key.startsWith(`messages${US}`)).length,
    walletAuthorityCharacters: (rows.walletAuthorityState || []).length,
    blueprintStateRows: (rows.industryBlueprintState || []).length,
    researchedBlueprints: positive(blueprintSummary.researchedBlueprints, 0),
    blueprintCopies: positive(blueprintSummary.blueprintCopies, 0),
    synthesizedOriginalDefaults: positive(blueprintSummary.synthesizedOriginalDefaults, 0),
    achievementCharacters: Object.keys(achievementCharacters).length,
    planetaryColonies: Object.keys(piColonies).length,
    deferredBlueprintStateRows: ((bundle.deferred || {}).blueprintStateRows || []).length,
    blockedBlueprintStateRows: positive(blueprintSummary.blockedBlueprintStateRows, 0),
    worldTablesIncluded: Object.keys(rows).filter((name) => FORBIDDEN_WORLD_TABLES.includes(name)),
    deferredStructures: ((bundle.deferred || {}).playerStructures || []).length,
    deferredOffices: ((bundle.deferred || {}).corporationOffices || []).length,
    deferredItems: ((bundle.deferred || {}).items || []).length,
    warnings: (bundle.warnings || []).length,
  };
}

function writeBundle(bundle, outPath) {
  const serialized = JSON.stringify(bundle, null, 2);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serialized);
  const sha = hashText(serialized);
  fs.writeFileSync(`${outPath}.sha256`, `${sha}  ${path.basename(outPath)}\n`);
  return sha;
}

function selectAccountAndCharacters(db, opts) {
  const accounts = allRows(db, "accounts");
  const chars = allRows(db, "characters");
  const include = opts.includeUsers
    ? new Set(opts.includeUsers.map((x) => x.toLowerCase()))
    : null;
  const exclude = new Set((opts.excludeUsers || []).map((x) => x.toLowerCase()));

  const selectedAccounts = [];
  const accountIDs = new Set();
  for (const row of accounts) {
    const username = String(row.key);
    const low = username.toLowerCase();
    if (include && !include.has(low)) continue;
    if (exclude.has(low)) continue;
    const id = positive(row.value && row.value.id, 0);
    if (!id) continue;
    selectedAccounts.push(row);
    accountIDs.add(id);
  }

  const selectedChars = [];
  for (const row of chars) {
    const charID = positive(row.key, 0);
    const accountId = positive(row.value && row.value.accountId, 0);
    if (accountIDs.has(accountId)) {
      selectedChars.push(row);
      continue;
    }
    if (opts.includeOrphans && charID >= CHARACTER_ID_FLOOR && accountId === 0) {
      selectedChars.push(row);
    }
  }

  const selectedAccountIDs = new Set(
    selectedAccounts.map((row) => positive(row.value && row.value.id, 0)).filter(Boolean),
  );
  const charIDs = new Set(selectedChars.map((row) => positive(row.key, 0)).filter(Boolean));
  return { selectedAccounts, selectedChars, selectedAccountIDs, charIDs };
}

function readCorporationRecords(db) {
  const row = getRow(db, "corporations", "records");
  return row && row.value && typeof row.value === "object" ? row.value : {};
}

function readCorporationMeta(db) {
  const row = getRow(db, "corporations", "_meta");
  return row && row.value && typeof row.value === "object" ? row.value : {};
}

function readFlatRoot(db, table) {
  const out = {};
  for (const row of allRows(db, table)) out[String(row.key)] = clone(row.value);
  return out;
}

function mergeNumericMetaFloor(targetMeta, sourceMeta) {
  const out = targetMeta && typeof targetMeta === "object" ? clone(targetMeta) : {};
  for (const [key, value] of Object.entries(sourceMeta || {})) {
    const sourceNumber = positive(value, 0);
    if (sourceNumber > 0 && (/^next/i.test(key) || key === "version")) {
      out[key] = Math.max(positive(out[key], 0), sourceNumber);
    }
  }
  return out;
}

function collectCorporations(db, selectedChars) {
  const records = readCorporationRecords(db);
  const corpIDs = new Set();
  for (const row of selectedChars) {
    const id = positive(row.value && row.value.corporationID, 0);
    if (id >= PLAYER_CORP_FLOOR) corpIDs.add(id);
  }
  const corporations = [];
  for (const id of [...corpIDs].sort((a, b) => a - b)) {
    const rec = records[String(id)];
    if (!rec) {
      throw new Error(`Selected character references player corporation ${id}, but corporations.records has no such record.`);
    }
    corporations.push({ corporationID: id, record: clone(rec) });
  }
  return { corpIDs, corporations };
}

function collectAlliances(db, selectedChars, corporations) {
  const ids = new Set();
  for (const row of selectedChars) {
    const id = positive(row.value && row.value.allianceID, 0);
    if (id >= PLAYER_ALLIANCE_FLOOR) ids.add(id);
  }
  for (const corp of corporations) {
    const id = positive(corp.record && corp.record.allianceID, 0);
    if (id >= PLAYER_ALLIANCE_FLOOR) ids.add(id);
  }
  const alliances = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const row = getRow(db, "alliances", exploded("records", id));
    if (!row) {
      throw new Error(`Selected state references player alliance ${id}, but alliances has no record row.`);
    }
    alliances.push({ allianceID: id, record: clone(row.value) });
  }
  return { allianceIDs: ids, alliances };
}

function staticDataCandidates(root, table) {
  const resolved = path.resolve(root);
  return [
    path.join(resolved, "_local", "gameStore", "data", table, "data.json"),
    path.join(resolved, "server", "src", "gameStore", "data", table, "data.json"),
  ];
}

function readStaticPayload(root, table) {
  const tried = [];
  for (const filePath of staticDataCandidates(root, table)) {
    tried.push(filePath);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!String(raw).trim()) {
      throw new Error(`Static table ${table} is blank: ${filePath}`);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Static table ${table} is invalid JSON at ${filePath}: ${error.message}`);
    }
    if (!payload || typeof payload !== "object") {
      throw new Error(`Static table ${table} has invalid payload shape: ${filePath}`);
    }
    return { payload, filePath };
  }
  throw new Error(
    `Static table ${table} not found. Tried:\n${tried.map((x) => `  - ${x}`).join("\n")}`,
  );
}

function staticRows(root, table, rowKey) {
  const { payload, filePath } = readStaticPayload(root, table);
  const rows = payload[rowKey];
  if (Array.isArray(rows)) return rows;
  if (rows && typeof rows === "object") return Object.values(rows);
  throw new Error(`Static table ${table} at ${filePath} has no ${rowKey} rows.`);
}

function staticStationIDs(root) {
  const ids = new Set();
  for (const station of staticRows(root, "stations", "stations")) {
    const id = positive(station && (station.stationID || station.id), 0);
    if (id) ids.add(id);
  }
  if (!ids.size) throw new Error("Static station authority resolved to zero stations.");
  return ids;
}

function staticSolarSystemIDs(root) {
  const ids = new Set();
  for (const system of staticRows(root, "solarSystems", "solarSystems")) {
    const id = positive(system && (system.solarSystemID || system.id), 0);
    if (id) ids.add(id);
  }
  if (!ids.size) throw new Error("Static solar-system authority resolved to zero systems.");
  return ids;
}

function itemCategoryMap(root) {
  const map = new Map();
  for (const record of staticRows(root, "itemTypes", "types")) {
    const typeID = positive(record && record.typeID, 0);
    if (!typeID) continue;
    const categoryID = positive(
      record && (record.categoryID || record.categoryId),
      0,
    );
    if (categoryID) map.set(typeID, categoryID);
  }
  if (!map.size) throw new Error("Static item-type category authority resolved to zero types.");
  return map;
}

function itemLooksBlockedCorpWorldObject(item, categoryByType) {
  const category = positive(
    item && (item.categoryID || item.categoryId),
    categoryByType.get(positive(item && item.typeID, 0)) || 0,
  );
  return BLOCKED_CORP_ITEM_CATEGORIES.has(category);
}

function collectItems(db, charIDs, corpIDs, warnings, staticRoot, deferredRoots = {}) {
  const rows = allRows(db, "items").filter((row) => !row.key.includes(US));
  const byID = new Map();
  for (const row of rows) {
    const itemID = positive(row.value && row.value.itemID, positive(row.key, 0));
    if (itemID) byID.set(itemID, row);
  }
  const categoryByType = itemCategoryMap(staticRoot);
  const relevant = new Set();
  const structureLocationIDs = deferredRoots.structureLocationIDs || new Set();
  const structureOfficeLocationIDs = deferredRoots.structureOfficeLocationIDs || new Set();

  // Start from all identity-owned assets. World-object categories are not dropped
  // here; they are classified into the deferred structure/world domain below so
  // descendants can be deferred with their parent instead of becoming orphans.
  for (const [itemID, row] of byID) {
    const ownerID = positive(row.value && row.value.ownerID, 0);
    if (charIDs.has(ownerID) || corpIDs.has(ownerID)) relevant.add(itemID);
  }

  // Close inventory ancestry in both directions. This catches nested cargo whose
  // owner metadata differs and parent containers required by selected children.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [itemID, row] of byID) {
      const value = row.value || {};
      const locationID = positive(value.locationID, 0);
      const shipID = positive(value.shipID, 0);
      if (!relevant.has(itemID) && (relevant.has(locationID) || relevant.has(shipID))) {
        relevant.add(itemID);
        changed = true;
      }
      if (relevant.has(itemID)) {
        for (const parentID of [locationID, shipID]) {
          if (byID.has(parentID) && !relevant.has(parentID)) {
            relevant.add(parentID);
            changed = true;
          }
        }
      }
    }
  }

  const deferred = new Set();
  const reasonByID = new Map();
  const defer = (itemID, reason) => {
    if (!deferred.has(itemID)) {
      deferred.add(itemID);
      reasonByID.set(itemID, reason);
      return true;
    }
    return false;
  };

  for (const itemID of relevant) {
    const row = byID.get(itemID);
    if (!row) continue;
    const value = row.value || {};
    const ownerID = positive(value.ownerID, 0);
    const locationID = positive(value.locationID, 0);
    const shipID = positive(value.shipID, 0);
    if (corpIDs.has(ownerID) && itemLooksBlockedCorpWorldObject(value, categoryByType)) {
      defer(itemID, "player-world-object");
      continue;
    }
    if (structureLocationIDs.has(locationID) || structureLocationIDs.has(shipID)) {
      defer(itemID, "inside-player-structure");
      continue;
    }
    if (structureOfficeLocationIDs.has(locationID) || structureOfficeLocationIDs.has(shipID)) {
      defer(itemID, "inside-player-structure-office");
    }
  }

  // The complete nested subtree follows a deferred parent. This is the key r1.7
  // policy: classic transfer never spills a citadel's ships/cargo onto NPC space.
  changed = true;
  while (changed) {
    changed = false;
    for (const itemID of relevant) {
      if (deferred.has(itemID)) continue;
      const row = byID.get(itemID);
      if (!row) continue;
      const value = row.value || {};
      const locationID = positive(value.locationID, 0);
      const shipID = positive(value.shipID, 0);
      if (deferred.has(locationID) || deferred.has(shipID)) {
        if (defer(itemID, "nested-under-deferred-item")) changed = true;
      }
    }
  }

  const importedIDs = new Set([...relevant].filter((id) => !deferred.has(id)));
  const selected = [...importedIDs]
    .sort((a, b) => a - b)
    .map((id) => byID.get(id))
    .filter(Boolean)
    .map((row) => ({ key: row.key, value: clone(row.value) }));

  const deferredItems = [...deferred]
    .sort((a, b) => a - b)
    .map((itemID) => {
      const row = byID.get(itemID);
      const value = (row && row.value) || {};
      return {
        itemID,
        typeID: positive(value.typeID, 0),
        ownerID: positive(value.ownerID, 0),
        locationID: positive(value.locationID, 0),
        shipID: positive(value.shipID, 0),
        reason: reasonByID.get(itemID) || "deferred",
      };
    });

  return { itemIDs: importedIDs, rows: selected, deferredItems };
}

function blueprintStateKey(itemID) {
  return exploded("records", itemID);
}

function blueprintStateItemIDFromKey(key) {
  const prefix = `records${US}`;
  const text = String(key || "");
  if (!text.startsWith(prefix)) return 0;
  const suffix = text.slice(prefix.length);
  return /^\d+$/.test(suffix) ? positive(suffix, 0) : 0;
}

function blueprintCategoryID(item, categoryByType) {
  return positive(item && (item.categoryID || item.categoryId), 0) ||
    categoryByType.get(positive(item && item.typeID, 0)) || 0;
}

function addBlueprintBlocker(warnings, code, item, message, details = {}) {
  warnings.push({
    code,
    severity: "blocking",
    itemID: positive(item && item.itemID, 0),
    typeID: positive(item && item.typeID, 0),
    ownerID: positive(item && item.ownerID, 0),
    locationID: positive(item && item.locationID, 0),
    message,
    ...details,
  });
}

function validateAndNormalizeBlueprintState(item, row, warnings) {
  const itemID = positive(item && item.itemID, 0);
  const typeID = positive(item && item.typeID, 0);
  const expectedKey = blueprintStateKey(itemID);
  const value = (row && row.value) || {};
  const fail = (code, message, details = {}) => {
    addBlueprintBlocker(warnings, code, item, message, details);
    return null;
  };

  if (String(row && row.key) !== expectedKey || positive(value.itemID, 0) !== itemID) {
    return fail(
      "BLUEPRINT_STATE_KEY_ITEMID_MISMATCH",
      "Blueprint state is inconsistent with item identity.",
      { stateKey: row && row.key, stateItemID: value.itemID },
    );
  }
  if (positive(value.typeID, 0) !== typeID) {
    return fail(
      "BLUEPRINT_STATE_TYPE_MISMATCH",
      "Blueprint state type does not match its inventory item.",
      { stateTypeID: value.typeID },
    );
  }
  const singleton = toInt(item.singleton, 0);
  if (singleton !== 1 && singleton !== 2) {
    return fail(
      "BLUEPRINT_STATE_SINGLETON_INVALID",
      "Persistent blueprint state exists for an item that is not a blueprint instance.",
      { singleton },
    );
  }
  const expectedOriginal = singleton === 1;
  if (typeof value.original !== "boolean" || value.original !== expectedOriginal) {
    return fail(
      "BLUEPRINT_STATE_SINGLETON_ORIGINAL_MISMATCH",
      "Blueprint original/copy state disagrees with the inventory singleton marker.",
      { singleton, stateOriginal: value.original },
    );
  }
  const materialEfficiency = Number(value.materialEfficiency);
  if (
    !Number.isSafeInteger(materialEfficiency) ||
    materialEfficiency < 0 ||
    materialEfficiency > MAX_MATERIAL_EFFICIENCY
  ) {
    return fail(
      "BLUEPRINT_STATE_MATERIAL_EFFICIENCY_INVALID",
      "Blueprint material efficiency is outside EveJS limits.",
      { materialEfficiency: value.materialEfficiency },
    );
  }
  const timeEfficiency = Number(value.timeEfficiency);
  if (
    !Number.isSafeInteger(timeEfficiency) ||
    timeEfficiency < 0 ||
    timeEfficiency > MAX_TIME_EFFICIENCY
  ) {
    return fail(
      "BLUEPRINT_STATE_TIME_EFFICIENCY_INVALID",
      "Blueprint time efficiency is outside EveJS limits.",
      { timeEfficiency: value.timeEfficiency },
    );
  }
  const runsRemaining = Number(value.runsRemaining);
  if (
    expectedOriginal
      ? runsRemaining !== -1
      : !Number.isSafeInteger(runsRemaining) || runsRemaining <= 0
  ) {
    return fail(
      "BLUEPRINT_STATE_RUNS_INVALID",
      expectedOriginal
        ? "Blueprint original does not use unlimited-run semantics."
        : "Blueprint copy does not have a valid finite remaining-run count.",
      { runsRemaining: value.runsRemaining },
    );
  }
  const jobID = value.jobID;
  if (jobID !== null && jobID !== undefined && Number(jobID) !== 0) {
    return fail(
      "BLUEPRINT_ACTIVE_INDUSTRY_JOB",
      "Active industry job must be completed or cancelled before transfer.",
      { jobID },
    );
  }
  if (positive(item.locationID, 0) === INDUSTRY_INSTALLED_LOCATION_ID) {
    return fail(
      "BLUEPRINT_INSTALLED_LOCATION_ACTIVE",
      "Blueprint is still held in the active industry installation location.",
    );
  }

  const normalized = {
    itemID,
    typeID,
    materialEfficiency,
    timeEfficiency,
    original: expectedOriginal,
    runsRemaining,
    jobID: null,
  };
  const updatedAt = Number(value.updatedAt);
  if (Number.isSafeInteger(updatedAt) && updatedAt >= 0) normalized.updatedAt = updatedAt;
  return { key: expectedKey, value: normalized };
}

function collectBlueprintState(db, itemSelection, staticRoot, warnings) {
  const categoryByType = itemCategoryMap(staticRoot);
  const selectedItems = (itemSelection.rows || []).map((row) => row.value || {});
  const selectedIDs = new Set(selectedItems.map((item) => positive(item.itemID, 0)).filter(Boolean));
  const allItemRows = allRows(db, "items").filter((row) => !row.key.includes(US));
  const allItemsByID = new Map(
    allItemRows.map((row) => [positive(row.value && row.value.itemID, positive(row.key, 0)), row.value || {}]),
  );
  const stateRows = allRows(db, "industryBlueprintState")
    .filter((row) => String(row.key).startsWith(`records${US}`));
  const byKeyItemID = new Map();
  const byValueItemID = new Map();
  for (const row of stateRows) {
    const keyItemID = blueprintStateItemIDFromKey(row.key);
    if (keyItemID) byKeyItemID.set(keyItemID, row);
    const valueItemID = positive(row.value && row.value.itemID, 0);
    if (valueItemID) {
      if (!byValueItemID.has(valueItemID)) byValueItemID.set(valueItemID, []);
      byValueItemID.get(valueItemID).push(row);
    }
  }

  const rows = [];
  let researchedBlueprints = 0;
  let blueprintCopies = 0;
  let synthesizedOriginalDefaults = 0;
  const blockedItemIDs = new Set();
  for (const item of selectedItems) {
    const itemID = positive(item.itemID, 0);
    const expectedRow = byKeyItemID.get(itemID) || null;
    const aliasRows = (byValueItemID.get(itemID) || [])
      .filter((row) => blueprintStateItemIDFromKey(row.key) !== itemID);
    const categoryID = blueprintCategoryID(item, categoryByType);
    if (categoryID !== BLUEPRINT_CATEGORY_ID) {
      if (expectedRow || aliasRows.length) {
        addBlueprintBlocker(
          warnings,
          "BLUEPRINT_STATE_ITEM_NOT_BLUEPRINT",
          item,
          "Blueprint state points to an inventory item that is not category 9.",
          { categoryID },
        );
        blockedItemIDs.add(itemID);
      }
      continue;
    }

    const singleton = toInt(item.singleton, 0);
    if (singleton === 2) blueprintCopies += 1;
    if (positive(item.locationID, 0) === INDUSTRY_INSTALLED_LOCATION_ID) {
      addBlueprintBlocker(
        warnings,
        "BLUEPRINT_INSTALLED_LOCATION_ACTIVE",
        item,
        "Blueprint is still held in the active industry installation location.",
      );
      blockedItemIDs.add(itemID);
      continue;
    }
    if (aliasRows.length) {
      addBlueprintBlocker(
        warnings,
        "BLUEPRINT_STATE_KEY_ITEMID_MISMATCH",
        item,
        "Blueprint state is stored under a key for a different item.",
        { stateKeys: aliasRows.map((row) => row.key) },
      );
      blockedItemIDs.add(itemID);
      continue;
    }
    if (!expectedRow) {
      if (singleton === 1) {
        rows.push({
          key: blueprintStateKey(itemID),
          value: {
            itemID,
            typeID: positive(item.typeID, 0),
            materialEfficiency: 0,
            timeEfficiency: 0,
            original: true,
            runsRemaining: -1,
            jobID: null,
          },
        });
        synthesizedOriginalDefaults += 1;
      } else if (singleton === 2) {
        addBlueprintBlocker(
          warnings,
          "BLUEPRINT_COPY_STATE_MISSING",
          item,
          "Blueprint copy is missing persistent blueprint state; remaining runs cannot be reconstructed safely.",
        );
        blockedItemIDs.add(itemID);
      } else if (singleton !== 0) {
        addBlueprintBlocker(
          warnings,
          "BLUEPRINT_STATE_SINGLETON_INVALID",
          item,
          "Blueprint item has an unsupported singleton marker.",
          { singleton },
        );
        blockedItemIDs.add(itemID);
      }
      continue;
    }

    const normalized = validateAndNormalizeBlueprintState(item, expectedRow, warnings);
    if (!normalized) {
      blockedItemIDs.add(itemID);
      continue;
    }
    rows.push(normalized);
    if (
      normalized.value.materialEfficiency > 0 ||
      normalized.value.timeEfficiency > 0
    ) researchedBlueprints += 1;
  }

  const deferredRows = [];
  for (const deferred of itemSelection.deferredItems || []) {
    const itemID = positive(deferred && deferred.itemID, 0);
    const item = allItemsByID.get(itemID) || deferred || {};
    if (
      blueprintCategoryID(item, categoryByType) === BLUEPRINT_CATEGORY_ID &&
      byKeyItemID.has(itemID)
    ) {
      deferredRows.push({
        itemID,
        typeID: positive(item.typeID, 0),
        reason: deferred.reason || "deferred",
      });
    }
  }

  return {
    rows,
    deferredRows,
    summary: {
      blueprintStateRows: rows.length,
      researchedBlueprints,
      blueprintCopies,
      synthesizedOriginalDefaults,
      deferredBlueprintStateRows: deferredRows.length,
      blockedBlueprintStateRows: blockedItemIDs.size,
    },
    selectedIDs,
  };
}

function selectSimpleRows(db, ids, specs) {
  const out = [];
  for (const spec of specs) {
    for (const id of ids) {
      const row = getRow(db, spec.table, spec.key(id));
      if (row) out.push({ table: spec.table, key: row.key, value: clone(row.value) });
    }
  }
  return out;
}

function collectMail(db, charIDs) {
  const out = [];
  for (const id of charIDs) {
    const box = getRow(db, "mail", exploded("mailboxes", id));
    if (box) out.push({ key: box.key, value: clone(box.value) });
  }
  for (const row of allRows(db, "mail")) {
    if (!row.key.startsWith(`messages${US}`)) continue;
    const v = row.value || {};
    const sender = positive(v.senderID, 0);
    const recipients = Array.isArray(v.toCharacterIDs) ? v.toCharacterIDs.map((x) => positive(x, 0)) : [];
    if (charIDs.has(sender) || recipients.some((id) => charIDs.has(id))) {
      out.push({ key: row.key, value: clone(v) });
    }
  }
  return dedupeRows(out);
}

function rowMentionsSelectedBookmarkOwner(value, charIDs, corpIDs) {
  if (!value || typeof value !== "object") return false;
  const ids = [
    value.creatorID,
    value.characterID,
    value.ownerID,
    value.corporationID,
  ].map((x) => positive(x, 0));
  if (ids.some((id) => charIDs.has(id) || corpIDs.has(id))) return true;
  for (const field of ["members", "admins", "sharedWithCharacterIDs"]) {
    if (Array.isArray(value[field]) && value[field].some((x) => charIDs.has(positive(x, 0)))) return true;
  }
  return false;
}

function collectBookmarkRows(db, charIDs, corpIDs) {
  const out = {};
  for (const table of ["bookmarkFolders", "bookmarkSubfolders", "bookmarkGroups", "bookmarks"]) {
    const rows = allRows(db, table).filter((row) => rowMentionsSelectedBookmarkOwner(row.value, charIDs, corpIDs));
    if (rows.length) out[table] = rows.map((r) => ({ key: r.key, value: clone(r.value) }));
  }
  return out;
}

function collectShipScopedRows(db, itemIDs) {
  const out = {};
  for (const spec of SHIP_SCOPED_TABLES) {
    const rows = [];
    for (const id of itemIDs) {
      const row = getRow(db, spec.table, exploded(spec.group, id));
      if (row) rows.push({ key: row.key, value: clone(row.value) });
    }
    if (rows.length) out[spec.table] = rows;
  }
  return out;
}

function playerStructureRecords(db) {
  const row = getRow(db, "structures", "structures");
  const records = row && Array.isArray(row.value) ? row.value : [];
  return records
    .map((record) => ({
      structureID: positive(record && record.structureID, 0),
      typeID: positive(record && record.typeID, 0),
      name: String((record && (record.name || record.itemName)) || ""),
      ownerCorpID: positive(record && (record.ownerCorpID || record.ownerID), 0),
      solarSystemID: positive(record && record.solarSystemID, 0),
    }))
    .filter((record) => record.structureID > 0);
}

function discoverPlayerStructureOfficeContext(db, corpIDs, staticStations, structureIDs) {
  const structureOfficeLocationIDs = new Set();
  const offices = [];
  for (const corporationID of corpIDs) {
    const row = getRow(db, "corporationRuntime", exploded("corporations", corporationID));
    if (!row) continue;
    for (const [key, office] of Object.entries((row.value && row.value.offices) || {})) {
      const stationID = positive(office && office.stationID, 0);
      if (!stationID || !structureIDs.has(stationID) || staticStations.has(stationID)) continue;
      const officeID = positive(office && office.officeID, positive(key, 0));
      const locationIDs = [];
      for (const field of ["officeID", "officeFolderID", "itemID"]) {
        const id = positive(office && office[field], 0);
        if (id) {
          structureOfficeLocationIDs.add(id);
          locationIDs.push(id);
        }
      }
      offices.push({ corporationID, stationID, officeID, locationIDs });
    }
  }
  return { structureOfficeLocationIDs, offices };
}

function sanitizeCorporationRuntime(value, staticStations, structureIDs, warnings, corporationID) {
  const out = clone(value || {});
  for (const key of [
    "impoundReleaseSettlements",
    "officeRentalSettlements",
    "dividendSettlements",
    "memberActionSettlements",
    "pendingAutoKicks",
    "allianceApplications",
  ]) {
    if (Array.isArray(out[key])) out[key] = [];
    else if (out[key] && typeof out[key] === "object") out[key] = {};
  }
  if (out.fw && typeof out.fw === "object") {
    out.fw.directEnlistment = null;
  }
  // Locks are transient operational state; the items themselves are preserved.
  if (out.lockedItemsByLocation && typeof out.lockedItemsByLocation === "object") {
    out.lockedItemsByLocation = {};
  }
  if (out.offices && typeof out.offices === "object") {
    const filtered = {};
    for (const [key, office] of Object.entries(out.offices)) {
      const stationID = positive(office && office.stationID, 0);
      if (stationID && staticStations.has(stationID)) {
        filtered[key] = office;
      } else if (stationID && structureIDs.has(stationID)) {
        // Known player-structure office: defer it silently to the optional
        // structure pass. Its inventory roots are discovered separately before
        // item classification so the complete office subtree is deferred too.
        continue;
      } else {
        warnings.push({
          code: "NON_STATIC_CORP_OFFICE_SKIPPED",
          severity: "blocking",
          corporationID,
          officeID: positive(office && office.officeID, positive(key, 0)),
          stationID,
          note: "r1.7 defers known player-structure offices; unknown non-static office locations remain blocking.",
        });
      }
    }
    out.offices = filtered;
  }
  return out;
}

function collectCorporationRuntime(db, corpIDs, staticStations, structureIDs, warnings) {
  const rows = [];
  for (const id of corpIDs) {
    const row = getRow(db, "corporationRuntime", exploded("corporations", id));
    if (!row) continue;
    rows.push({
      key: row.key,
      value: sanitizeCorporationRuntime(row.value, staticStations, structureIDs, warnings, id),
    });
  }
  return rows;
}

function sanitizeAllianceRuntime(value) {
  const out = clone(value || {});
  // Applications/bills are active process state whose scheduler/settlement rows
  // are intentionally not transferred by r1. Governance and historical identity
  // settings are retained.
  if (out.applications && typeof out.applications === "object") out.applications = {};
  if (Array.isArray(out.bills)) out.bills = [];
  out.billBalance = Number(out.billBalance || 0);
  return out;
}

function collectAllianceRuntime(db, allianceIDs) {
  const rows = [];
  for (const id of allianceIDs) {
    const row = getRow(db, "corporationRuntime", exploded("alliances", id));
    if (!row) continue;
    rows.push({ key: row.key, value: sanitizeAllianceRuntime(row.value) });
  }
  return rows;
}

function collectOfficeLocationIDs(corporationRuntimeRows) {
  const ids = new Set();
  for (const row of corporationRuntimeRows || []) {
    if (!String(row.key).startsWith(`corporations${US}`)) continue;
    for (const office of Object.values((row.value && row.value.offices) || {})) {
      for (const field of ["officeID", "officeFolderID", "itemID"]) {
        const id = positive(office && office[field], 0);
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}

function validateExternalLocations({
  selectedChars, corporations, itemRows, itemIDs, charIDs, corpIDs,
  stationIDs, solarSystemIDs, corporationRuntimeRows, deferredItemIDs, warnings,
}) {
  const officeIDs = collectOfficeLocationIDs(corporationRuntimeRows);
  const allowed = new Set([
    ...itemIDs, ...charIDs, ...corpIDs, ...stationIDs, ...solarSystemIDs, ...officeIDs,
  ]);

  for (const row of selectedChars) {
    const rec = row.value || {};
    const charID = positive(row.key, 0);
    const structureID = positive(rec.structureID, 0);
    const stationID = positive(rec.stationID, 0);
    const shipID = positive(rec.shipID, 0);
    if (deferredItemIDs && deferredItemIDs.has(shipID)) {
      warnings.push({
        code: "CHARACTER_ACTIVE_SHIP_DEFERRED", severity: "blocking",
        characterID: charID, shipID,
        note: "Character record points at an active ship that belongs to the deferred player-structure/world-object domain. Move/log out the character at a normal NPC-station ship before classic transfer.",
      });
    }
    if (structureID && !stationIDs.has(structureID)) {
      warnings.push({
        code: "CHARACTER_IN_PLAYER_STRUCTURE", severity: "blocking",
        characterID: charID, structureID,
        note: "r1.7 classic transfer does not move a character session out of a player structure automatically; dock/log out at a static NPC station or handle the structure in the optional pass.",
      });
    }
    if (stationID && !stationIDs.has(stationID) && !solarSystemIDs.has(stationID)) {
      warnings.push({
        code: "CHARACTER_NON_STATIC_STATION", severity: "blocking",
        characterID: charID, stationID,
        note: "Character station/location is not present in the fresh static station authority.",
      });
    }
  }

  for (const corp of corporations || []) {
    const stationID = positive(corp.record && corp.record.stationID, 0);
    if (stationID && !stationIDs.has(stationID)) {
      warnings.push({
        code: "CORPORATION_HQ_NON_STATIC", severity: "blocking",
        corporationID: corp.corporationID, stationID,
        note: "r1.7 classic transfer cannot preserve a corporation HQ/base hosted by a player structure; move HQ/base to a static NPC station or use the optional structure pass.",
      });
    }
  }

  const external = [];
  for (const row of itemRows || []) {
    const itemID = positive(row.value && row.value.itemID, positive(row.key, 0));
    const locationID = positive(row.value && row.value.locationID, 0);
    if (locationID && !allowed.has(locationID)) {
      external.push({ itemID, ownerID: positive(row.value && row.value.ownerID, 0), locationID, typeID: positive(row.value && row.value.typeID, 0) });
    }
  }
  if (external.length) {
    warnings.push({
      code: "EXTERNAL_ITEM_LOCATIONS", severity: "blocking", count: external.length,
      examples: external.slice(0, 30),
      note: "Some imported assets reference an unresolved dynamic location that is neither transferred/static nor part of a known deferred player-structure domain. r1.7 refuses apply until the dependency is resolved.",
    });
  }
}

function dedupeRows(rows) {
  const map = new Map();
  for (const row of rows) map.set(String(row.key), row);
  return [...map.values()];
}

function bucketSimpleRows(rows) {
  const out = {};
  for (const row of rows) {
    if (!out[row.table]) out[row.table] = [];
    out[row.table].push({ key: row.key, value: row.value });
  }
  return out;
}

async function commandExport(opts) {
  if (!opts.sourceRoot && !opts.sourceSqlite) {
    throw new Error("export requires --source-root or --source-sqlite");
  }
  if (!opts.out) throw new Error("export requires --out <bundle.json>");
  const sourceRoot = opts.sourceRoot ? path.resolve(opts.sourceRoot) : null;
  if (!sourceRoot) throw new Error("r1.7 requires --source-root so it can resolve EveJS dependencies/version.");
  const sqlitePath = path.resolve(opts.sourceSqlite || runtimeSqlite(sourceRoot));
  if (!fs.existsSync(sqlitePath)) throw new Error(`Source SQLite not found: ${sqlitePath}`);
  const Database = loadBetterSqlite(sourceRoot);
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const check = integrity(db);
    if (!check.ok) throw new Error(`Source integrity_check failed: ${JSON.stringify(check.rows)}`);
    const warnings = [];
    const selected = selectAccountAndCharacters(db, opts);
    if (!selected.selectedChars.length) throw new Error("No characters selected for export.");
    const corp = collectCorporations(db, selected.selectedChars);
    const alliances = collectAlliances(db, selected.selectedChars, corp.corporations);
    const stations = staticStationIDs(sourceRoot);
    const solarSystems = staticSolarSystemIDs(sourceRoot);
    const allStructureRecords = playerStructureRecords(db);
    const structureIDs = new Set(allStructureRecords.map((record) => record.structureID));
    const structureOfficeContext = discoverPlayerStructureOfficeContext(
      db, corp.corpIDs, stations, structureIDs,
    );
    const itemSelection = collectItems(
      db,
      selected.charIDs,
      corp.corpIDs,
      warnings,
      sourceRoot,
      {
        structureLocationIDs: structureIDs,
        structureOfficeLocationIDs: structureOfficeContext.structureOfficeLocationIDs,
      },
    );
    const blueprintState = collectBlueprintState(
      db,
      itemSelection,
      sourceRoot,
      warnings,
    );
    const achievements = collectAchievementTransfer(db, sourceRoot, selected.charIDs);
    const planetaryInteraction = collectPlanetaryInteractionTransfer(
      db, sourceRoot, selected.charIDs,
    );

    const simple = bucketSimpleRows([
      ...selectSimpleRows(db, selected.charIDs, SIMPLE_CHARACTER_TABLES),
      ...selectSimpleRows(db, corp.corpIDs, SIMPLE_CORPORATION_TABLES),
    ]);
    const bookmarks = collectBookmarkRows(db, selected.charIDs, corp.corpIDs);
    const shipScoped = collectShipScopedRows(db, itemSelection.itemIDs);
    const corporationRuntime = [
      ...collectCorporationRuntime(db, corp.corpIDs, stations, structureIDs, warnings),
      ...collectAllianceRuntime(db, alliances.allianceIDs),
    ];
    validateExternalLocations({
      selectedChars: selected.selectedChars,
      corporations: corp.corporations,
      itemRows: itemSelection.rows,
      itemIDs: itemSelection.itemIDs,
      charIDs: selected.charIDs,
      corpIDs: corp.corpIDs,
      stationIDs: stations,
      solarSystemIDs: solarSystems,
      corporationRuntimeRows: corporationRuntime,
      deferredItemIDs: new Set(itemSelection.deferredItems.map((item) => item.itemID)),
      warnings,
    });

    const rows = {
      accounts: selected.selectedAccounts.map((r) => ({ key: r.key, value: clone(r.value) })),
      characters: selected.selectedChars.map((r) => ({ key: r.key, value: clone(r.value) })),
      items: itemSelection.rows,
      industryBlueprintState: blueprintState.rows,
      mail: collectMail(db, selected.charIDs),
      corporationRuntime,
      ...simple,
      ...bookmarks,
      ...shipScoped,
    };
    for (const key of Object.keys(rows)) rows[key] = dedupeRows(rows[key]);

    const deferredStructureIDs = new Set();
    for (const item of itemSelection.deferredItems) {
      if (structureIDs.has(item.locationID)) deferredStructureIDs.add(item.locationID);
      if (structureIDs.has(item.shipID)) deferredStructureIDs.add(item.shipID);
    }
    for (const office of structureOfficeContext.offices) deferredStructureIDs.add(office.stationID);
    for (const record of allStructureRecords) {
      if (corp.corpIDs.has(record.ownerCorpID)) deferredStructureIDs.add(record.structureID);
    }
    const deferredPlayerStructures = allStructureRecords
      .filter((record) => deferredStructureIDs.has(record.structureID))
      .sort((a, b) => a.structureID - b.structureID);

    const bundle = {
      tool: TOOL_NAME,
      toolVersion: TOOL_VERSION,
      bundleVersion: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      source: {
        root: sourceRoot,
        sqlitePath,
        version: readVersion(sourceRoot),
      },
      policy: {
        preserveIDs: true,
        playerStructures: "deferred to optional structure transfer",
        playerStructureInventory: "deferred with structure; no automatic re-home",
        worldRuntime: "excluded",
        corporationRuntimeSettlements: "cleared",
        corporationOffices: "NPC/static stations transferred; player-structure offices deferred",
        walletAuthority: "selected character authority rows transferred exactly (ISK/AUR/PLEX + walletJournal)",
        blueprintState: "inactive transferred blueprint instances preserve ME/TE, original/copy, and remaining runs; active jobs block",
        blueprintJobHistory: "jobID and settlement replay markers are normalized away; industryJobs are not transferred",
        achievements: "selected native character subtrees replace as exact persisted state; reward fulfillment is never executed",
        planetaryInteraction: "selected personal colony subtrees replace atomically; world resources, launches, orbitals, receipts, and source allocators are excluded",
      },
      selected: {
        accountIDs: [...selected.selectedAccountIDs].sort((a, b) => a - b),
        characterIDs: [...selected.charIDs].sort((a, b) => a - b),
        corporationIDs: [...corp.corpIDs].sort((a, b) => a - b),
        allianceIDs: [...alliances.allianceIDs].sort((a, b) => a - b),
        itemIDs: [...itemSelection.itemIDs].sort((a, b) => a - b),
      },
      corporations: corp.corporations,
      alliances: alliances.alliances,
      allocatorFloors: readFlatRoot(db, "identityState"),
      metaFloors: {
        corporations: readCorporationMeta(db),
        alliances: (getRow(db, "alliances", "_meta") || {}).value || {},
        corporationRuntime: (getRow(db, "corporationRuntime", "_meta") || {}).value || {},
      },
      blueprintSummary: blueprintState.summary,
      achievements,
      planetaryInteraction,
      rows,
      deferred: {
        playerStructures: deferredPlayerStructures,
        corporationOffices: structureOfficeContext.offices,
        items: itemSelection.deferredItems,
        blueprintStateRows: blueprintState.deferredRows,
      },
      forbiddenWorldTables: FORBIDDEN_WORLD_TABLES,
      warnings,
    };

    const outPath = path.resolve(opts.out);
    const sha = writeBundle(bundle, outPath);
    console.log("\nEXPORT_OK");
    console.log(JSON.stringify(summarizeBundle(bundle), null, 2));
    console.log(`Bundle: ${outPath}`);
    console.log(`SHA256: ${sha}`);
    if (warnings.length) console.log(`Warnings: ${warnings.length} (inspect bundle/summary before import)`);
  } finally {
    db.close();
  }
}

function bundleIDs(bundle) {
  const selected = bundle.selected || {};
  return {
    accountIDs: new Set((selected.accountIDs || []).map((x) => positive(x, 0)).filter(Boolean)),
    charIDs: new Set((selected.characterIDs || []).map((x) => positive(x, 0)).filter(Boolean)),
    corpIDs: new Set((selected.corporationIDs || []).map((x) => positive(x, 0)).filter(Boolean)),
    allianceIDs: new Set((selected.allianceIDs || []).map((x) => positive(x, 0)).filter(Boolean)),
    itemIDs: new Set((selected.itemIDs || []).map((x) => positive(x, 0)).filter(Boolean)),
  };
}

const BLUEPRINT_SEMANTIC_FIELDS = Object.freeze([
  "itemID",
  "typeID",
  "materialEfficiency",
  "timeEfficiency",
  "original",
  "runsRemaining",
]);

function blueprintSemanticState(value) {
  const source = value || {};
  return Object.fromEntries(
    BLUEPRINT_SEMANTIC_FIELDS.map((field) => [field, source[field]]),
  );
}

function validateBundledBlueprintState(bundle, ids) {
  const itemRows = ((bundle.rows || {}).items || []);
  const itemsByID = new Map(
    itemRows.map((row) => {
      const item = row.value || {};
      return [positive(item.itemID, positive(row.key, 0)), item];
    }),
  );
  const seen = new Set();
  for (const row of ((bundle.rows || {}).industryBlueprintState || [])) {
    const itemID = blueprintStateItemIDFromKey(row.key);
    const value = row.value || {};
    if (!itemID || seen.has(itemID)) {
      throw new Error(`SAFETY ABORT: invalid or duplicate blueprint-state key: ${row.key}`);
    }
    seen.add(itemID);
    if (!ids.itemIDs.has(itemID) || !itemsByID.has(itemID)) {
      throw new Error(`SAFETY ABORT: blueprint state is not scoped to a transferred item: ${row.key}`);
    }
    const item = itemsByID.get(itemID);
    if (positive(value.itemID, 0) !== itemID) {
      throw new Error(`SAFETY ABORT: blueprint-state key/value itemID mismatch: ${row.key}`);
    }
    if (positive(item.categoryID || item.categoryId, 0) !== BLUEPRINT_CATEGORY_ID) {
      throw new Error(`SAFETY ABORT: blueprint state targets non-blueprint item ${itemID}`);
    }
    if (positive(value.typeID, 0) !== positive(item.typeID, 0)) {
      throw new Error(`SAFETY ABORT: blueprint-state typeID mismatch for item ${itemID}`);
    }
    const singleton = toInt(item.singleton, 0);
    if (
      (singleton !== 1 && singleton !== 2) ||
      typeof value.original !== "boolean" ||
      value.original !== (singleton === 1)
    ) {
      throw new Error(`SAFETY ABORT: blueprint-state singleton/original mismatch for item ${itemID}`);
    }
    const materialEfficiency = Number(value.materialEfficiency);
    const timeEfficiency = Number(value.timeEfficiency);
    const runsRemaining = Number(value.runsRemaining);
    if (
      !Number.isSafeInteger(materialEfficiency) ||
      materialEfficiency < 0 ||
      materialEfficiency > MAX_MATERIAL_EFFICIENCY ||
      !Number.isSafeInteger(timeEfficiency) ||
      timeEfficiency < 0 ||
      timeEfficiency > MAX_TIME_EFFICIENCY
    ) {
      throw new Error(`SAFETY ABORT: blueprint-state ME/TE invalid for item ${itemID}`);
    }
    if (
      value.original === true
        ? runsRemaining !== -1
        : !Number.isSafeInteger(runsRemaining) || runsRemaining <= 0
    ) {
      throw new Error(`SAFETY ABORT: blueprint-state runs invalid for item ${itemID}`);
    }
    if (value.jobID !== null && value.jobID !== undefined && Number(value.jobID) !== 0) {
      throw new Error(`SAFETY ABORT: active blueprint job state is not transferable for item ${itemID}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(value, "lastCompletedJobID") ||
      Object.prototype.hasOwnProperty.call(value, "lastCancelledJobID")
    ) {
      throw new Error(`SAFETY ABORT: blueprint job replay history is not transferable for item ${itemID}`);
    }
    if (positive(item.locationID, 0) === INDUSTRY_INSTALLED_LOCATION_ID) {
      throw new Error(`SAFETY ABORT: installed blueprint location is not transferable for item ${itemID}`);
    }
  }
  for (const deferred of ((bundle.deferred || {}).blueprintStateRows || [])) {
    const itemID = positive(deferred && deferred.itemID, 0);
    if (!itemID || ids.itemIDs.has(itemID) || seen.has(itemID)) {
      throw new Error(`SAFETY ABORT: deferred blueprint state overlaps transferred item ${itemID}`);
    }
  }
}

function validateBundledAchievements(bundle, ids) {
  const hasField = Object.prototype.hasOwnProperty.call(bundle, "achievements");
  if (positive(bundle.bundleVersion, 0) === LEGACY_BUNDLE_VERSION) {
    if (hasField && bundle.achievements !== null && bundle.achievements !== undefined) {
      achievementAbort("legacy bundle must not contain native achievement state");
    }
    return;
  }
  if (!hasField) achievementAbort("bundle v6 must declare achievement state or explicit absence");
  if (bundle.achievements === null) return;
  const transfer = bundle.achievements;
  if (!isRecord(transfer) || transfer.schemaVersion !== 1 ||
      transfer.rootVersion !== ACHIEVEMENT_ROOT_VERSION ||
      transfer.definitionsVersion !== ACHIEVEMENT_DEFINITIONS_VERSION ||
      transfer.titlesVersion !== ACHIEVEMENT_TITLES_VERSION ||
      !isRecord(transfer.characters) || Object.keys(transfer.characters).length === 0) {
    achievementAbort("bundle contract/schema/catalog versions are incompatible");
  }
  for (const [ownerKey, state] of Object.entries(transfer.characters)) {
    const characterID = validateAchievementCharacterState(state, ownerKey, "bundle");
    if (!ids.charIDs.has(characterID)) {
      achievementAbort(`bundle character ${ownerKey} is not selected`);
    }
  }
}

function validateBundledPlanetaryInteraction(bundle, ids) {
  const hasField = Object.prototype.hasOwnProperty.call(bundle, "planetaryInteraction");
  if (positive(bundle.bundleVersion, 0) === LEGACY_BUNDLE_VERSION) {
    if (hasField && bundle.planetaryInteraction !== null && bundle.planetaryInteraction !== undefined) {
      piAbort("legacy bundle must not contain PI state");
    }
    return;
  }
  if (!hasField) piAbort("bundle v6 must declare PI state or explicit absence");
  if (bundle.planetaryInteraction === null) return;
  const transfer = bundle.planetaryInteraction;
  assertExactKeys(
    transfer,
    [
      "schemaVersion", "runtimeSchemaVersion", "coloniesByKey",
      "allocatorRequirements", "staticAuthority",
    ],
    "bundle PI contract",
    ["outputMultiplier"], // Older v6 exports carried this; accept and ignore it.
  );
  if (transfer.schemaVersion !== PI_TRANSFER_SCHEMA_VERSION ||
      transfer.runtimeSchemaVersion !== PI_SCHEMA_VERSION ||
      !isRecord(transfer.coloniesByKey) || !Object.keys(transfer.coloniesByKey).length) {
    piAbort("bundle contract/schema is incompatible");
  }
  assertExactKeys(
    transfer.allocatorRequirements,
    ["maxPinID", "maxRouteID"],
    "bundle PI allocator requirements",
  );
  assertExactKeys(
    transfer.staticAuthority,
    ["schemaVersion", "planets", "schematics", "types", "dogma"],
    "bundle PI static authority",
  );
  if (transfer.staticAuthority.schemaVersion !== 1 ||
      ["planets", "schematics", "types", "dogma"]
        .some((key) => !isRecord(transfer.staticAuthority[key]))) {
    piAbort("bundle static authority is malformed");
  }
  const seenPins = new Set();
  const seenRoutes = new Set();
  let maxPinID = 0;
  let maxRouteID = 0;
  for (const [colonyKey, colony] of Object.entries(transfer.coloniesByKey)) {
    const validated = validatePiColony(colony, colonyKey, "bundle");
    if (!ids.charIDs.has(validated.ownerID)) {
      piAbort(`bundle colony ${colonyKey} is not owned by a selected character`);
    }
    for (const pinID of validated.pinIDs) {
      if (seenPins.has(pinID)) piAbort(`bundle colonies duplicate pin ID ${pinID}`);
      seenPins.add(pinID);
      maxPinID = Math.max(maxPinID, pinID);
    }
    for (const routeID of validated.routeIDs) {
      if (seenRoutes.has(routeID)) piAbort(`bundle colonies duplicate route ID ${routeID}`);
      seenRoutes.add(routeID);
      maxRouteID = Math.max(maxRouteID, routeID);
    }
  }
  if (transfer.allocatorRequirements.maxPinID !== maxPinID ||
      transfer.allocatorRequirements.maxRouteID !== maxRouteID) {
    piAbort("bundle allocator requirements do not match colony IDs");
  }
}

function validateBundle(bundle) {
  if (!bundle || bundle.tool !== TOOL_NAME) throw new Error("Not an EveJS Private Identity Transfer bundle.");
  const bundleVersion = positive(bundle.bundleVersion, 0);
  if (bundleVersion !== BUNDLE_VERSION && bundleVersion !== LEGACY_BUNDLE_VERSION) {
    throw new Error(
      `Bundle version ${bundle.bundleVersion} is unsupported; expected ${LEGACY_BUNDLE_VERSION} or ${BUNDLE_VERSION}`,
    );
  }
  const bad = Object.keys(bundle.rows || {}).filter((name) => FORBIDDEN_WORLD_TABLES.includes(name));
  if (bad.length) throw new Error(`SAFETY ABORT: bundle contains forbidden world tables: ${bad.join(", ")}`);
  const ids = bundleIDs(bundle);
  for (const row of ((bundle.rows || {}).walletAuthorityState || [])) {
    const match = /^character:(\d+)$/.exec(String(row.key));
    const characterID = match ? positive(match[1], 0) : 0;
    if (!characterID || !ids.charIDs.has(characterID)) {
      throw new Error(`SAFETY ABORT: walletAuthorityState row is not scoped to a selected character: ${row.key}`);
    }
    if (positive(row.value && row.value.characterID, 0) !== characterID) {
      throw new Error(`SAFETY ABORT: walletAuthorityState key/value characterID mismatch: ${row.key}`);
    }
  }
  validateBundledBlueprintState(bundle, ids);
  validateBundledAchievements(bundle, ids);
  validateBundledPlanetaryInteraction(bundle, ids);
}

function validateTargetStaticReferences(targetRoot, bundle) {
  const warnings = [];
  const ids = bundleIDs(bundle);
  const stationIDs = staticStationIDs(targetRoot);
  const solarSystemIDs = staticSolarSystemIDs(targetRoot);
  const categoryByType = itemCategoryMap(targetRoot);
  const corporationRuntimeRows = (bundle.rows && bundle.rows.corporationRuntime) || [];
  const deferredItemIDs = new Set(
    ((((bundle.deferred || {}).items) || [])
      .map((item) => positive(item && item.itemID, 0))
      .filter(Boolean)),
  );

  const validOfficeIDs = new Set();
  for (const row of corporationRuntimeRows) {
    if (!String(row.key).startsWith(`corporations${US}`)) continue;
    for (const office of Object.values((row.value && row.value.offices) || {})) {
      const stationID = positive(office && office.stationID, 0);
      if (!stationID || !stationIDs.has(stationID)) {
        warnings.push({
          code: "TARGET_CORP_OFFICE_STATION_MISSING", severity: "blocking",
          officeID: positive(office && office.officeID, 0), stationID,
          note: "Imported NPC-office record references a station absent from target static authority.",
        });
        continue;
      }
      for (const field of ["officeID", "officeFolderID", "itemID"]) {
        const id = positive(office && office[field], 0);
        if (id) validOfficeIDs.add(id);
      }
    }
  }

  for (const row of (bundle.rows && bundle.rows.characters) || []) {
    const rec = row.value || {};
    const characterID = positive(row.key, 0);
    const structureID = positive(rec.structureID, 0);
    const stationID = positive(rec.stationID, 0);
    const shipID = positive(rec.shipID, 0);
    if (deferredItemIDs.has(shipID)) {
      warnings.push({
        code: "TARGET_CHARACTER_ACTIVE_SHIP_DEFERRED", severity: "blocking",
        characterID, shipID,
        note: "Bundle character points at an active ship that is listed in the deferred structure/world-object domain.",
      });
    }
    if (structureID && !stationIDs.has(structureID)) {
      warnings.push({
        code: "TARGET_CHARACTER_IN_PLAYER_STRUCTURE", severity: "blocking",
        characterID, structureID,
        note: "Bundle keeps a character docked in a dynamic structure that r1.7 classic transfer does not import.",
      });
    }
    if (stationID && !stationIDs.has(stationID) && !solarSystemIDs.has(stationID)) {
      warnings.push({
        code: "TARGET_CHARACTER_STATION_MISSING", severity: "blocking",
        characterID, stationID,
        note: "Character station/location is absent from target static authority.",
      });
    }
  }

  for (const corp of bundle.corporations || []) {
    const stationID = positive(corp.record && corp.record.stationID, 0);
    if (stationID && !stationIDs.has(stationID)) {
      warnings.push({
        code: "TARGET_CORPORATION_HQ_STATION_MISSING", severity: "blocking",
        corporationID: positive(corp.corporationID, 0), stationID,
        note: "Corporation HQ/base station is absent from target static authority.",
      });
    }
  }

  const allowedLocations = new Set([
    ...ids.itemIDs, ...ids.charIDs, ...ids.corpIDs,
    ...stationIDs, ...solarSystemIDs, ...validOfficeIDs,
  ]);
  const external = [];
  const blockedCorpWorld = [];
  for (const row of (bundle.rows && bundle.rows.items) || []) {
    const item = row.value || {};
    const itemID = positive(item.itemID, positive(row.key, 0));
    const ownerID = positive(item.ownerID, 0);
    const locationID = positive(item.locationID, 0);
    if (ids.corpIDs.has(ownerID) && itemLooksBlockedCorpWorldObject(item, categoryByType)) {
      blockedCorpWorld.push({ itemID, ownerID, typeID: positive(item.typeID, 0) });
    }
    if (locationID && !allowedLocations.has(locationID)) {
      external.push({ itemID, ownerID, locationID, typeID: positive(item.typeID, 0) });
    }
  }
  if (blockedCorpWorld.length) {
    warnings.push({
      code: "TARGET_CORP_WORLD_ITEM_PRESENT", severity: "blocking",
      count: blockedCorpWorld.length, examples: blockedCorpWorld.slice(0, 20),
      note: "Bundle contains corp-owned structure/deployable/orbital items under target item-type authority.",
    });
  }
  if (external.length) {
    warnings.push({
      code: "TARGET_EXTERNAL_ITEM_LOCATIONS", severity: "blocking",
      count: external.length, examples: external.slice(0, 30),
      note: "Imported assets reference locations that are neither imported nor valid target static locations.",
    });
  }
  return warnings;
}

function preflightTarget(db, bundle, opts) {
  const ids = bundleIDs(bundle);
  const conflicts = [];
  const accountRows = allRows(db, "accounts");
  const existingUsernames = new Map(accountRows.map((r) => [String(r.key), r.value]));
  const usernameByAccountID = new Map();
  for (const row of accountRows) {
    const id = positive(row.value && row.value.id, 0);
    if (id) usernameByAccountID.set(id, String(row.key));
  }
  for (const row of (bundle.rows && bundle.rows.accounts) || []) {
    const username = String(row.key);
    const sourceID = positive(row.value && row.value.id, 0);
    const existingByName = existingUsernames.get(username);
    if (existingByName) {
      const targetID = positive(existingByName.id, 0);
      if (targetID !== sourceID) {
        throw new Error(`SAFETY ABORT: username ${username} exists on target with accountID ${targetID}, but source uses ${sourceID}. r1.7 will not merge/rename accounts.`);
      }
      conflicts.push({ type: "username/accountID", value: `${username}/${sourceID}` });
    }
    const otherUsername = usernameByAccountID.get(sourceID);
    if (sourceID && otherUsername && otherUsername !== username) {
      throw new Error(`SAFETY ABORT: source accountID ${sourceID} belongs to ${username}, but target assigns it to ${otherUsername}.`);
    }
  }
  const existingChars = new Set(allRows(db, "characters").map((r) => positive(r.key, 0)));
  for (const id of ids.charIDs) if (existingChars.has(id)) conflicts.push({ type: "characterID", value: id });
  const corpRecords = readCorporationRecords(db);
  for (const id of ids.corpIDs) if (corpRecords[String(id)]) conflicts.push({ type: "corporationID", value: id });
  for (const id of ids.allianceIDs) {
    if (getRow(db, "alliances", exploded("records", id))) conflicts.push({ type: "allianceID", value: id });
  }
  const existingItems = new Set(allRows(db, "items").filter((r) => !r.key.includes(US)).map((r) => positive(r.key, 0)));
  let itemCollisionCount = 0;
  for (const id of ids.itemIDs) if (existingItems.has(id)) itemCollisionCount += 1;
  if (itemCollisionCount) conflicts.push({ type: "itemID", value: `${itemCollisionCount} collision(s)` });

  if (conflicts.length && !opts.replaceExisting) {
    const sample = conflicts.slice(0, 30).map((x) => `${x.type}=${x.value}`).join(", ");
    throw new Error(
      `SAFETY ABORT: target has ${conflicts.length} collision class/record(s). ` +
      `This is expected on a fresh EveJS target with canonical fixtures, but replacement is destructive. ` +
      `Review the dry-run and rerun with --replace-existing only if the target is disposable/fresh. Sample: ${sample}`,
    );
  }
  return { conflicts };
}

function deleteTargetPersonalState(db, bundle) {
  const ids = bundleIDs(bundle);
  let deletedItems = 0;
  let deletedBlueprintState = 0;
  // Remove old target item graph for the imported owners/IDs. Repeat to catch descendants.
  let changed = true;
  const toDelete = new Set(ids.itemIDs);
  while (changed) {
    changed = false;
    for (const row of allRows(db, "items")) {
      if (row.key.includes(US)) continue;
      const itemID = positive(row.key, positive(row.value && row.value.itemID, 0));
      const ownerID = positive(row.value && row.value.ownerID, 0);
      const locationID = positive(row.value && row.value.locationID, 0);
      const shipID = positive(row.value && row.value.shipID, 0);
      if (
        ids.charIDs.has(ownerID) || ids.corpIDs.has(ownerID) ||
        toDelete.has(itemID) || toDelete.has(locationID) || toDelete.has(shipID)
      ) {
        if (!toDelete.has(itemID)) {
          toDelete.add(itemID);
          changed = true;
        }
      }
    }
  }
  for (const id of toDelete) {
    deletedBlueprintState += deleteRow(db, "industryBlueprintState", blueprintStateKey(id));
    deletedItems += deleteRow(db, "items", String(id));
  }

  for (const row of (bundle.rows.accounts || [])) deleteRow(db, "accounts", row.key);
  for (const id of ids.charIDs) {
    deleteRow(db, "characters", String(id));
    for (const spec of SIMPLE_CHARACTER_TABLES) deleteRow(db, spec.table, spec.key(id));
    deleteRow(db, "mail", exploded("mailboxes", id));
  }
  for (const id of ids.corpIDs) {
    for (const spec of SIMPLE_CORPORATION_TABLES) deleteRow(db, spec.table, spec.key(id));
    deleteRow(db, "corporationRuntime", exploded("corporations", id));
  }
  for (const id of ids.allianceIDs) {
    deleteRow(db, "alliances", exploded("records", id));
    deleteRow(db, "corporationRuntime", exploded("alliances", id));
  }

  // Merge-delete corporation records from the one shared records row.
  const corpRow = getRow(db, "corporations", "records");
  if (corpRow && corpRow.value && typeof corpRow.value === "object") {
    let dirty = false;
    for (const id of ids.corpIDs) {
      if (Object.prototype.hasOwnProperty.call(corpRow.value, String(id))) {
        delete corpRow.value[String(id)];
        dirty = true;
      }
    }
    if (dirty) putRow(db, "corporations", "records", corpRow.value);
  }
  return { deletedItems, deletedBlueprintState };
}

function importRows(db, rowsByTable) {
  const counts = {};
  for (const [table, rows] of Object.entries(rowsByTable || {})) {
    if (FORBIDDEN_WORLD_TABLES.includes(table)) throw new Error(`Forbidden table in bundle: ${table}`);
    counts[table] = 0;
    for (const row of rows || []) {
      putRow(db, table, row.key, row.value);
      counts[table] += 1;
    }
  }
  return counts;
}

function ensureAchievementTable(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS ${q(ACHIEVEMENT_TABLE)} (key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  ).run();
}

function validatePiTargetCompatibility(targetRoot, bundle) {
  if (!bundle.planetaryInteraction) return null;
  const compatibility = readPiCompatibility(targetRoot, "target");
  const expected = bundle.planetaryInteraction;
  if (compatibility.runtimeSchemaVersion !== expected.runtimeSchemaVersion) {
    piAbort("target PI runtime schema does not match the bundle");
  }
  const targetAuthority = piReferencedAuthority(
    expected.coloniesByKey, targetRoot, "target",
  );
  if (JSON.stringify(targetAuthority) !== JSON.stringify(expected.staticAuthority)) {
    piAbort("target static planet/schematic/type authority does not match the source");
  }
  return compatibility;
}

function ensurePiTable(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS ${q(PI_TABLE)} (key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  ).run();
}

function initializePiRows(db) {
  ensurePiTable(db);
  const root = emptyPiRuntimeRoot();
  putRow(db, PI_TABLE, "schemaVersion", root.schemaVersion);
  for (const group of PI_GROUPS) putRow(db, PI_TABLE, group, {});
  putRow(db, PI_TABLE, "customsOperationReceipts", {});
  putRow(db, PI_TABLE, "nextIDs", root.nextIDs);
  return root;
}

function planPlanetaryInteractionImport(db, bundle) {
  const selectedCharacterIDs = bundleIDs(bundle).charIDs;
  const existingRoot = readPiRuntimeRoot(db, "target", { allowAbsent: true });
  if (!bundle.planetaryInteraction) {
    if (existingRoot) assertPiQuiescent(db, existingRoot, selectedCharacterIDs, "target");
    return null;
  }
  const transfer = bundle.planetaryInteraction;
  const root = existingRoot || emptyPiRuntimeRoot();
  assertPiQuiescent(db, root, selectedCharacterIDs, "target");
  const importedKeys = new Set(Object.keys(transfer.coloniesByKey));
  const retained = [];
  for (const [colonyKey, colony] of Object.entries(root.coloniesByKey)) {
    if (!importedKeys.has(colonyKey)) {
      retained.push(validatePiColony(colony, colonyKey, "target"));
    }
  }
  const imported = Object.entries(transfer.coloniesByKey)
    .map(([key, colony]) => validatePiColony(colony, key, "bundle"));
  const pinOwners = new Map();
  const routeOwners = new Map();
  let maxPinID = 0;
  let maxRouteID = 0;
  const register = (validated, label) => {
    for (const pinID of validated.pinIDs) {
      if (pinOwners.has(pinID)) {
        piAbort(`target/import pin ID collision ${pinID} (${pinOwners.get(pinID)} and ${label})`);
      }
      pinOwners.set(pinID, label);
      maxPinID = Math.max(maxPinID, pinID);
    }
    for (const routeID of validated.routeIDs) {
      if (routeOwners.has(routeID)) {
        piAbort(`target/import route ID collision ${routeID} (${routeOwners.get(routeID)} and ${label})`);
      }
      routeOwners.set(routeID, label);
      maxRouteID = Math.max(maxRouteID, routeID);
    }
  };
  retained.forEach((entry) => register(entry, `retained colony ${entry.planetID}:${entry.ownerID}`));
  imported.forEach((entry) => register(entry, `imported colony ${entry.planetID}:${entry.ownerID}`));
  if (maxPinID >= Number.MAX_SAFE_INTEGER || maxRouteID >= Number.MAX_SAFE_INTEGER) {
    piAbort("allocator floor cannot be represented safely");
  }
  const nextIDs = {
    pinID: Math.max(root.nextIDs.pinID, PI_DEFAULT_NEXT_IDS.pinID, maxPinID + 1),
    routeID: Math.max(root.nextIDs.routeID, PI_DEFAULT_NEXT_IDS.routeID, maxRouteID + 1),
    launchID: root.nextIDs.launchID,
  };
  if (nextIDs.pinID <= maxPinID || nextIDs.routeID <= maxRouteID ||
      nextIDs.pinID < root.nextIDs.pinID || nextIDs.routeID < root.nextIDs.routeID) {
    piAbort("target-safe allocator floors cannot be proven");
  }
  return {
    targetInitiallyAbsent: !existingRoot,
    importedKeys,
    nextIDs,
    previousNextIDs: clone(root.nextIDs),
    protectedBefore: snapshotProtectedPiState(db, bundle),
  };
}

function importPlanetaryInteraction(db, bundle, plan) {
  if (!bundle.planetaryInteraction) return 0;
  if (!plan) piAbort("import plan is missing");
  let root = readPiRuntimeRoot(db, "target", { allowAbsent: true });
  if (!root) root = initializePiRows(db);
  for (const [colonyKey, colony] of Object.entries(bundle.planetaryInteraction.coloniesByKey)) {
    putRow(db, PI_TABLE, exploded("coloniesByKey", colonyKey), clone(colony));
  }
  putRow(db, PI_TABLE, "nextIDs", {
    pinID: plan.nextIDs.pinID,
    routeID: plan.nextIDs.routeID,
    launchID: root.nextIDs.launchID,
  });
  return Object.keys(bundle.planetaryInteraction.coloniesByKey).length;
}

function verifyImportedPlanetaryInteraction(db, bundle, plan, problems) {
  if (!bundle.planetaryInteraction) return;
  const root = readPiRuntimeRoot(db, "post-import target", { allowAbsent: false });
  for (const [colonyKey, colony] of Object.entries(bundle.planetaryInteraction.coloniesByKey)) {
    if (JSON.stringify(root.coloniesByKey[colonyKey]) !== JSON.stringify(colony)) {
      problems.push(`PI colony state mismatch ${colonyKey}`);
    }
  }
  if (JSON.stringify(snapshotProtectedPiState(db, bundle)) !== JSON.stringify(plan.protectedBefore)) {
    problems.push("unrelated target colony or world-owned PI state changed");
  }
  if (root.nextIDs.pinID !== plan.nextIDs.pinID ||
      root.nextIDs.routeID !== plan.nextIDs.routeID ||
      root.nextIDs.launchID !== plan.previousNextIDs.launchID ||
      root.nextIDs.pinID < plan.previousNextIDs.pinID ||
      root.nextIDs.routeID < plan.previousNextIDs.routeID) {
    problems.push("PI allocator floors are unsafe or were lowered");
  }
  try {
    const postPlan = planPlanetaryInteractionImport(db, bundle);
    if (postPlan.nextIDs.pinID !== root.nextIDs.pinID || postPlan.nextIDs.routeID !== root.nextIDs.routeID) {
      problems.push("PI allocator post-import recomputation is not stable");
    }
  } catch (error) {
    problems.push(`PI post-import graph/allocator verification failed: ${error.message}`);
  }
}

function snapshotUnrelatedAchievementState(db, bundle) {
  if (!bundle.achievements) return null;
  const selected = new Set(Object.keys(bundle.achievements.characters));
  const root = readAchievementRoot(db, "target");
  const characters = {};
  for (const [ownerKey, state] of Object.entries(root && root.characters || {})) {
    if (!selected.has(ownerKey)) characters[ownerKey] = clone(state);
  }
  return characters;
}

function importAchievements(db, bundle) {
  if (!bundle.achievements) return 0;
  const root = readAchievementRoot(db, "target") || {
    version: ACHIEVEMENT_ROOT_VERSION,
    characters: {},
  };
  for (const [ownerKey, state] of Object.entries(bundle.achievements.characters)) {
    root.characters[ownerKey] = clone(state);
  }
  ensureAchievementTable(db);
  putRow(db, ACHIEVEMENT_TABLE, "version", ACHIEVEMENT_ROOT_VERSION);
  putRow(db, ACHIEVEMENT_TABLE, "characters", root.characters);
  return Object.keys(bundle.achievements.characters).length;
}

function verifyImportedAchievements(db, bundle, unrelatedBefore, problems) {
  if (!bundle.achievements) return;
  const root = readAchievementRoot(db, "post-import target");
  if (!root) {
    problems.push("missing achievement root");
    return;
  }
  for (const [ownerKey, state] of Object.entries(bundle.achievements.characters)) {
    if (JSON.stringify(root.characters[ownerKey]) !== JSON.stringify(state)) {
      problems.push(`achievement state mismatch ${ownerKey}`);
    }
  }
  const selected = new Set(Object.keys(bundle.achievements.characters));
  const unrelatedAfter = {};
  for (const [ownerKey, state] of Object.entries(root.characters)) {
    if (!selected.has(ownerKey)) unrelatedAfter[ownerKey] = state;
  }
  if (JSON.stringify(unrelatedAfter) !== JSON.stringify(unrelatedBefore || {})) {
    problems.push("unrelated target achievement state changed");
  }
}

function importCorporations(db, bundle) {
  const corporations = bundle.corporations || [];
  if (corporations.length) {
    const target = readCorporationRecords(db);
    for (const corp of corporations) target[String(corp.corporationID)] = clone(corp.record);
    putRow(db, "corporations", "records", target);
    let meta = mergeNumericMetaFloor(readCorporationMeta(db), bundle.metaFloors && bundle.metaFloors.corporations);
    const max = corporations.reduce((m, c) => Math.max(m, positive(c.corporationID, 0)), 0);
    meta.nextCustomCorporationID = Math.max(positive(meta.nextCustomCorporationID, PLAYER_CORP_FLOOR), max + 1);
    putRow(db, "corporations", "_meta", meta);
  }
  for (const alliance of bundle.alliances || []) {
    putRow(db, "alliances", exploded("records", alliance.allianceID), alliance.record);
  }
  if ((bundle.alliances || []).length) {
    const row = getRow(db, "alliances", "_meta");
    let meta = mergeNumericMetaFloor(
      row && row.value && typeof row.value === "object" ? row.value : {},
      bundle.metaFloors && bundle.metaFloors.alliances,
    );
    const max = bundle.alliances.reduce((m, a) => Math.max(m, positive(a.allianceID, 0)), 0);
    meta.nextCustomAllianceID = Math.max(positive(meta.nextCustomAllianceID, PLAYER_ALLIANCE_FLOOR), max + 1);
    putRow(db, "alliances", "_meta", meta);
  }

  if (tableExists(db, "corporationRuntime")) {
    const row = getRow(db, "corporationRuntime", "_meta");
    const merged = mergeNumericMetaFloor(
      row && row.value && typeof row.value === "object" ? row.value : {},
      bundle.metaFloors && bundle.metaFloors.corporationRuntime,
    );
    putRow(db, "corporationRuntime", "_meta", merged);
  }
}

function maxSet(values, fallback = 0) {
  let max = fallback;
  for (const value of values) {
    const numeric = positive(value, 0);
    if (numeric > max) max = numeric;
  }
  return max;
}

function updateIdentityHighWater(db, bundle) {
  if (!tableExists(db, "identityState")) return;
  const ids = bundleIDs(bundle);
  const maxAccount = maxSet(ids.accountIDs, 0);
  const maxChar = maxSet(ids.charIDs, CHARACTER_ID_FLOOR - 1);
  const maxItem = maxSet(ids.itemIDs, ITEM_ID_FLOOR - 1);
  const sourceFloors = bundle.allocatorFloors || {};
  const keys = [
    ["version", Math.max(1, positive(sourceFloors.version, 1))],
    ["nextAccountID", Math.max(maxAccount + 1, positive(sourceFloors.nextAccountID, 0))],
    ["nextCharacterID", Math.max(maxChar + 1, positive(sourceFloors.nextCharacterID, 0))],
    ["nextItemID", Math.max(maxItem + 1, positive(sourceFloors.nextItemID, 0))],
  ];
  for (const [key, minimum] of keys) {
    const row = getRow(db, "identityState", key);
    const existing = row ? positive(row.value, 0) : 0;
    putRow(db, "identityState", key, key === "version" ? Math.max(existing, minimum) : Math.max(existing, minimum));
  }
}

function verifyImported(db, bundle, unrelatedAchievementsBefore = null, piPlan = null) {
  const ids = bundleIDs(bundle);
  const problems = [];
  for (const row of bundle.rows.accounts || []) {
    const target = getRow(db, "accounts", row.key);
    if (!target) problems.push(`missing account ${row.key}`);
  }
  for (const id of ids.charIDs) {
    if (!getRow(db, "characters", String(id))) problems.push(`missing character ${id}`);
  }
  for (const id of ids.corpIDs) {
    if (!readCorporationRecords(db)[String(id)]) problems.push(`missing corporation ${id}`);
  }
  for (const id of ids.itemIDs) {
    if (!getRow(db, "items", String(id))) problems.push(`missing item ${id}`);
  }
  for (const row of ((bundle.rows || {}).walletAuthorityState || [])) {
    const target = getRow(db, "walletAuthorityState", row.key);
    if (!target) {
      problems.push(`missing walletAuthorityState ${row.key}`);
      continue;
    }
    if (JSON.stringify(target.value) !== JSON.stringify(row.value)) {
      problems.push(`walletAuthorityState mismatch ${row.key}`);
    }
  }
  for (const row of ((bundle.rows || {}).industryBlueprintState || [])) {
    const target = getRow(db, "industryBlueprintState", row.key);
    if (!target) {
      problems.push(`missing industryBlueprintState ${row.key}`);
      continue;
    }
    if (
      JSON.stringify(blueprintSemanticState(target.value)) !==
      JSON.stringify(blueprintSemanticState(row.value))
    ) {
      problems.push(`industryBlueprintState semantic mismatch ${row.key}`);
    }
    if (
      target.value.jobID !== null ||
      Object.prototype.hasOwnProperty.call(target.value, "lastCompletedJobID") ||
      Object.prototype.hasOwnProperty.call(target.value, "lastCancelledJobID")
    ) {
      problems.push(`industryBlueprintState retained active/history linkage ${row.key}`);
    }
  }
  for (const deferred of ((bundle.deferred || {}).blueprintStateRows || [])) {
    const key = blueprintStateKey(positive(deferred && deferred.itemID, 0));
    if (getRow(db, "industryBlueprintState", key)) {
      problems.push(`deferred industryBlueprintState unexpectedly present ${key}`);
    }
  }
  verifyImportedAchievements(db, bundle, unrelatedAchievementsBefore, problems);
  verifyImportedPlanetaryInteraction(db, bundle, piPlan, problems);
  const itemRows = allRows(db, "items").filter((r) => ids.itemIDs.has(positive(r.key, 0)));
  for (const row of itemRows) {
    const v = row.value || {};
    const owner = positive(v.ownerID, 0);
    const loc = positive(v.locationID, 0);
    if (owner >= CHARACTER_ID_FLOOR && !ids.charIDs.has(owner) && !ids.corpIDs.has(owner)) {
      // Foreign owner can occur only via ancestry closure; surface it rather than fail.
      continue;
    }
    if (ids.itemIDs.has(loc) && !getRow(db, "items", String(loc))) {
      problems.push(`item ${row.key} references missing imported parent ${loc}`);
    }
  }
  return problems;
}

async function commandImport(opts) {
  if (!opts.targetRoot && !opts.targetSqlite) throw new Error("import requires --target-root or --target-sqlite");
  if (!opts.in) throw new Error("import requires --in <bundle.json>");
  const targetRoot = opts.targetRoot ? path.resolve(opts.targetRoot) : null;
  if (!targetRoot) throw new Error("r1.7 requires --target-root so it can resolve dependencies/static database.");
  const bundlePath = path.resolve(opts.in);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  validateBundle(bundle);
  if (bundle.achievements) readAchievementCompatibility(targetRoot, "target");
  validatePiTargetCompatibility(targetRoot, bundle);
  const blockingWarnings = (bundle.warnings || []).filter((w) => w && w.severity === "blocking");
  if (opts.apply && blockingWarnings.length) {
    throw new Error(
      `SAFETY ABORT: bundle has ${blockingWarnings.length} blocking migration warning(s). ` +
      `Run inspect/dry-run and resolve them before apply. Codes: ${blockingWarnings.map((w) => w.code).join(", ")}`,
    );
  }
  const sqlitePath = path.resolve(opts.targetSqlite || runtimeSqlite(targetRoot));
  if (!fs.existsSync(sqlitePath)) throw new Error(`Target SQLite not found: ${sqlitePath}`);
  const staticMarker = path.join(targetRoot, "_local", "gameStore", "data", "dungeonClientContent", "data.json");
  if (!fs.existsSync(staticMarker)) {
    throw new Error(
      `SAFETY ABORT: target 0.12.7-style static DB marker is missing: ${staticMarker}. ` +
      "Initialize the fresh target database before importing player state.",
    );
  }
  const targetStaticWarnings = validateTargetStaticReferences(targetRoot, bundle);
  const targetBlockingWarnings = targetStaticWarnings.filter((w) => w && w.severity === "blocking");
  if (targetStaticWarnings.length) {
    console.log("Target static compatibility warnings:");
    console.dir(targetStaticWarnings, { depth: 8, maxArrayLength: 100 });
  }
  if (opts.apply && targetBlockingWarnings.length) {
    throw new Error(
      `SAFETY ABORT: target static compatibility produced ${targetBlockingWarnings.length} blocking warning(s). ` +
      `Codes: ${targetBlockingWarnings.map((w) => w.code).join(", ")}`,
    );
  }
  const Database = loadBetterSqlite(targetRoot);
  const db = new Database(sqlitePath, { fileMustExist: true });
  let backupPath = null;
  try {
    const check = integrity(db);
    if (!check.ok) throw new Error(`Target integrity_check failed before import: ${JSON.stringify(check.rows)}`);
    const beforeWorld = fingerprintWorld(db);
    const beforeProtectedPi = snapshotProtectedPiState(db, bundle);
    const unrelatedAchievementsBefore = snapshotUnrelatedAchievementState(db, bundle);
    const piPlan = planPlanetaryInteractionImport(db, bundle);
    const preflight = preflightTarget(db, bundle, opts);
    console.log(`Target version: ${readVersion(targetRoot)}`);
    console.log(`Bundle source version: ${bundle.source && bundle.source.version}`);
    console.log(JSON.stringify(summarizeBundle(bundle), null, 2));
    console.log(`Target collisions: ${preflight.conflicts.length}`);
    console.log(`Target static compatibility warnings: ${targetStaticWarnings.length}`);

    if (!opts.apply) {
      console.log("\nDRY_RUN_OK — no writes performed.");
      if (preflight.conflicts.length && opts.replaceExisting) {
        console.log("Replacement mode would remove same-owner/same-ID target personal state before import.");
      }
      return;
    }

    // Backup via SQLite backup API, so WAL content is captured coherently.
    const backupDir = path.resolve(
      opts.backupDir || path.join(targetRoot, "_local", "migration-backups"),
    );
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(backupDir, `gamestore-before-private-transfer-${stamp}.sqlite`);
    await db.backup(backupPath);
    console.log(`Backup: ${backupPath}`);

    const tx = db.transaction(() => {
      let cleanup = { deletedItems: 0, deletedBlueprintState: 0 };
      if (opts.replaceExisting) cleanup = deleteTargetPersonalState(db, bundle);
      importCorporations(db, bundle);
      const counts = importRows(db, bundle.rows || {});
      if (bundle.achievements) counts.achievements = importAchievements(db, bundle);
      if (bundle.planetaryInteraction) {
        counts.planetaryInteraction = importPlanetaryInteraction(db, bundle, piPlan);
      }
      updateIdentityHighWater(db, bundle);

      // Verify logical safety before COMMIT so a failed assertion rolls the
      // transaction back rather than leaving a half-accepted migration.
      const duringWorld = fingerprintWorld(db);
      const changedWorld = Object.keys(beforeWorld).filter((t) => beforeWorld[t] !== duringWorld[t]);
      if (changedWorld.length) {
        throw new Error(`SAFETY FAILURE: forbidden world table fingerprint changed: ${changedWorld.join(", ")}`);
      }
      if (JSON.stringify(snapshotProtectedPiState(db, bundle)) !== JSON.stringify(beforeProtectedPi)) {
        throw new Error("SAFETY FAILURE: protected PI/world state changed");
      }
      const problems = verifyImported(db, bundle, unrelatedAchievementsBefore, piPlan);
      if (problems.length) {
        throw new Error(`Post-import verification failed:\n${problems.slice(0, 50).join("\n")}`);
      }
      return { cleanup, counts };
    });
    const result = tx();

    const afterCheck = integrity(db);
    if (!afterCheck.ok) throw new Error(`Target integrity_check failed AFTER import: ${JSON.stringify(afterCheck.rows)}`);
    const afterWorld = fingerprintWorld(db);
    const changedWorld = Object.keys(beforeWorld).filter((t) => beforeWorld[t] !== afterWorld[t]);
    if (changedWorld.length) {
      throw new Error(`SAFETY FAILURE after commit: forbidden world table fingerprint changed: ${changedWorld.join(", ")}`);
    }
    if (JSON.stringify(snapshotProtectedPiState(db, bundle)) !== JSON.stringify(beforeProtectedPi)) {
      throw new Error("SAFETY FAILURE after commit: protected PI/world state changed");
    }

    db.pragma("wal_checkpoint(TRUNCATE)");
    console.log("\nIMPORT_OK");
    console.log(`Deleted old target personal items: ${result.cleanup.deletedItems}`);
    console.log(`Deleted stale target blueprint-state rows: ${result.cleanup.deletedBlueprintState}`);
    console.log(`Written tables: ${Object.keys(result.counts).sort().join(", ")}`);
    console.log("SQLite integrity_check: ok");
    console.log("Forbidden world-state and protected PI fingerprints: unchanged");
    console.log(`Backup retained: ${backupPath}`);
  } catch (error) {
    if (backupPath) {
      error.message += `\nBackup retained at: ${backupPath}`;
    }
    throw error;
  } finally {
    db.close();
  }
}

function fileSha256(filePath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex").toUpperCase();
}

function selectedPortraitFiles(sourceDir, charIDs) {
  if (!fs.existsSync(sourceDir)) throw new Error(`Source portrait directory not found: ${sourceDir}`);
  const rows = [];
  const seenCharacters = new Set();
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(\d+)_([^\\/]+)\.(jpg|jpeg|png|webp)$/i.exec(entry.name);
    if (!match) continue;
    const characterID = positive(match[1], 0);
    if (!charIDs.has(characterID)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    rows.push({ characterID, name: entry.name, sourcePath, size: fs.statSync(sourcePath).size });
    seenCharacters.add(characterID);
  }
  rows.sort((a, b) => a.characterID - b.characterID || a.name.localeCompare(b.name));
  return { rows, seenCharacters };
}

function commandPortraits(opts) {
  if (!opts.sourceRoot) throw new Error("portraits requires --source-root");
  if (!opts.targetRoot) throw new Error("portraits requires --target-root");
  if (!opts.in) throw new Error("portraits requires --in <bundle.json>");
  const sourceRoot = path.resolve(opts.sourceRoot);
  const targetRoot = path.resolve(opts.targetRoot);
  const bundle = JSON.parse(fs.readFileSync(path.resolve(opts.in), "utf8"));
  validateBundle(bundle);
  const ids = bundleIDs(bundle);
  const sourceDir = runtimePortraitDir(sourceRoot);
  const targetDir = runtimePortraitDir(targetRoot);
  const selected = selectedPortraitFiles(sourceDir, ids.charIDs);
  const missingCharacterIDs = [...ids.charIDs].filter((id) => !selected.seenCharacters.has(id)).sort((a, b) => a - b);
  let existingTargetFiles = 0;
  for (const row of selected.rows) {
    if (fs.existsSync(path.join(targetDir, row.name))) existingTargetFiles += 1;
  }

  console.log(`Bundle source version: ${bundle.source && bundle.source.version}`);
  console.log(`Selected characters: ${ids.charIDs.size}`);
  console.log(`Characters with portrait media: ${selected.seenCharacters.size}`);
  console.log(`Characters without portrait media: ${missingCharacterIDs.length}`);
  console.log(`Portrait files selected: ${selected.rows.length}`);
  console.log(`Existing target portrait files with same names: ${existingTargetFiles}`);
  if (missingCharacterIDs.length) console.log(`No source portrait media for characterIDs: ${missingCharacterIDs.join(", ")}`);

  if (!opts.apply) {
    console.log("\nPORTRAIT_DRY_RUN_OK — no writes performed.");
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const backupRoot = path.resolve(opts.backupDir || path.join(targetRoot, "_local", "migration-backups"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, `portraits-before-private-transfer-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  let copied = 0;
  let overwritten = 0;
  let backedUp = 0;
  for (const row of selected.rows) {
    const targetPath = path.join(targetDir, row.name);
    if (fs.existsSync(targetPath)) {
      fs.copyFileSync(targetPath, path.join(backupDir, row.name));
      overwritten += 1;
      backedUp += 1;
    }
    fs.copyFileSync(row.sourcePath, targetPath);
    if (fileSha256(row.sourcePath) !== fileSha256(targetPath)) {
      throw new Error(`Portrait copy verification failed: ${row.name}`);
    }
    copied += 1;
  }

  console.log("\nPORTRAITS_OK");
  console.log(`Copied portrait files: ${copied}`);
  console.log(`Overwritten target files: ${overwritten}`);
  console.log(`Backed up target files: ${backedUp}`);
  console.log(`Backup retained: ${backupDir}`);
}

function commandInspect(opts) {
  if (!opts.in) throw new Error("inspect requires --in <bundle.json>");
  const bundle = JSON.parse(fs.readFileSync(path.resolve(opts.in), "utf8"));
  validateBundle(bundle);
  console.log(JSON.stringify(summarizeBundle(bundle), null, 2));
  console.log("\nPolicy:");
  console.dir(bundle.policy, { depth: 5 });
  const deferred = bundle.deferred || {};
  if ((deferred.playerStructures || []).length || (deferred.corporationOffices || []).length || (deferred.items || []).length) {
    console.log("\nDeferred player-structure domain:");
    console.dir(deferred, { depth: 6, maxArrayLength: 100 });
  }
  if (bundle.warnings && bundle.warnings.length) {
    console.log("\nWarnings:");
    console.dir(bundle.warnings, { depth: 8, maxArrayLength: 100 });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "--help" || opts.command === "-h") opts.help = true;
  if (opts.help || !opts.command) {
    printHelp();
    return;
  }
  switch (opts.command) {
    case "export": return commandExport(opts);
    case "import": return commandImport(opts);
    case "inspect": return commandInspect(opts);
    case "portraits": return commandPortraits(opts);
    default:
      printHelp();
      throw new Error(`Unknown command: ${opts.command}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("\nPRIVATE_TRANSFER_FAILED");
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  BUNDLE_VERSION,
  collectAchievementTransfer,
  collectPlanetaryInteractionTransfer,
  importAchievements,
  importPlanetaryInteraction,
  planPlanetaryInteractionImport,
  readAchievementCompatibility,
  readAchievementRoot,
  readPiCompatibility,
  readPiRuntimeRoot,
  snapshotUnrelatedAchievementState,
  snapshotProtectedPiState,
  validateBundle,
  validatePiTargetCompatibility,
  verifyImportedAchievements,
  verifyImportedPlanetaryInteraction,
};
