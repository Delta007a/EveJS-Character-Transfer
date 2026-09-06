#!/usr/bin/env node
"use strict";

/*
 * EveJS Private Identity Transfer r1.5
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
const TOOL_VERSION = "r1.5";
const BUNDLE_VERSION = 4;
const US = String.fromCharCode(31);
const PLAYER_CORP_FLOOR = 98_000_000;
const PLAYER_ALLIANCE_FLOOR = 99_000_000;
const CHARACTER_ID_FLOOR = 140_000_001;
const ITEM_ID_FLOOR = 1_990_000_000;

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
  * r1.5 classic transfer defers player structures and their inventory domain.
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
    out[table] = fingerprintTable(db, table);
  }
  return out;
}

function summarizeBundle(bundle) {
  const rows = bundle.rows || {};
  return {
    sourceVersion: bundle.source && bundle.source.version,
    accounts: (rows.accounts || []).length,
    characters: (rows.characters || []).length,
    corporations: (bundle.corporations || []).length,
    alliances: (bundle.alliances || []).length,
    items: (rows.items || []).length,
    mailMessages: (rows.mail || []).filter((r) => r.key.startsWith(`messages${US}`)).length,
    walletAuthorityCharacters: (rows.walletAuthorityState || []).length,
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

  // The complete nested subtree follows a deferred parent. This is the key r1.5
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
          note: "r1.5 defers known player-structure offices; unknown non-static office locations remain blocking.",
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
        note: "r1.5 classic transfer does not move a character session out of a player structure automatically; dock/log out at a static NPC station or handle the structure in the optional pass.",
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
        note: "r1.5 classic transfer cannot preserve a corporation HQ/base hosted by a player structure; move HQ/base to a static NPC station or use the optional structure pass.",
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
      note: "Some imported assets reference an unresolved dynamic location that is neither transferred/static nor part of a known deferred player-structure domain. r1.5 refuses apply until the dependency is resolved.",
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
  if (!sourceRoot) throw new Error("r1.5 requires --source-root so it can resolve EveJS dependencies/version.");
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
      rows,
      deferred: {
        playerStructures: deferredPlayerStructures,
        corporationOffices: structureOfficeContext.offices,
        items: itemSelection.deferredItems,
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

function validateBundle(bundle) {
  if (!bundle || bundle.tool !== TOOL_NAME) throw new Error("Not an EveJS Private Identity Transfer bundle.");
  if (positive(bundle.bundleVersion, 0) !== BUNDLE_VERSION) {
    throw new Error(`Bundle version ${bundle.bundleVersion} != supported ${BUNDLE_VERSION}`);
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
        note: "Bundle keeps a character docked in a dynamic structure that r1.5 classic transfer does not import.",
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
        throw new Error(`SAFETY ABORT: username ${username} exists on target with accountID ${targetID}, but source uses ${sourceID}. r1.5 will not merge/rename accounts.`);
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
  for (const id of toDelete) deletedItems += deleteRow(db, "items", String(id));

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
  return { deletedItems };
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

function verifyImported(db, bundle) {
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
  if (!targetRoot) throw new Error("r1.5 requires --target-root so it can resolve dependencies/static database.");
  const bundlePath = path.resolve(opts.in);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  validateBundle(bundle);
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
      let cleanup = { deletedItems: 0 };
      if (opts.replaceExisting) cleanup = deleteTargetPersonalState(db, bundle);
      importCorporations(db, bundle);
      const counts = importRows(db, bundle.rows || {});
      updateIdentityHighWater(db, bundle);

      // Verify logical safety before COMMIT so a failed assertion rolls the
      // transaction back rather than leaving a half-accepted migration.
      const duringWorld = fingerprintWorld(db);
      const changedWorld = Object.keys(beforeWorld).filter((t) => beforeWorld[t] !== duringWorld[t]);
      if (changedWorld.length) {
        throw new Error(`SAFETY FAILURE: forbidden world table fingerprint changed: ${changedWorld.join(", ")}`);
      }
      const problems = verifyImported(db, bundle);
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

    db.pragma("wal_checkpoint(TRUNCATE)");
    console.log("\nIMPORT_OK");
    console.log(`Deleted old target personal items: ${result.cleanup.deletedItems}`);
    console.log(`Written tables: ${Object.keys(result.counts).sort().join(", ")}`);
    console.log("SQLite integrity_check: ok");
    console.log("Forbidden world-state fingerprints: unchanged");
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

main().catch((error) => {
  console.error("\nPRIVATE_TRANSFER_FAILED");
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
