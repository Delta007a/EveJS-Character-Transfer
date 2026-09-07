#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const tool = path.join(__dirname, "private-identity-transfer.js");
const US = String.fromCharCode(31);
const stateKey = (id) => `records${US}${id}`;
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function fakeDatabaseModule() {
  return `"use strict";
const fs = require("fs");
class FakeDatabase {
  constructor(file) {
    this.file = file;
    this.sidecar = file + ".json";
    this.data = JSON.parse(fs.readFileSync(this.sidecar, "utf8"));
  }
  _rows(table) {
    const rows = this.data[table];
    return Array.isArray(rows) ? rows : [];
  }
  _persist() { fs.writeFileSync(this.sidecar, JSON.stringify(this.data, null, 2)); }
  prepare(sql) {
    const db = this;
    if (sql.includes("sqlite_master")) {
      return {
        get(table) {
          return Object.prototype.hasOwnProperty.call(db.data, String(table))
            ? { present: 1 }
            : undefined;
        },
        all() { return []; },
      };
    }
    const match = sql.match(/(?:FROM|INTO)\\s+"([^"]+)"/i);
    if (!match) throw new Error("FakeDatabase unsupported SQL: " + sql);
    const table = match[1].replaceAll('""', '"');
    const hasWhereKey = /WHERE\\s+key=\\?/i.test(sql);
    const isInsert = /^\\s*INSERT/i.test(sql);
    const isDelete = /^\\s*DELETE/i.test(sql);
    return {
      get(key) {
        if (!hasWhereKey) return undefined;
        const row = db._rows(table).find((entry) => String(entry.key) === String(key));
        return row ? { key: String(row.key), json: JSON.stringify(row.value) } : undefined;
      },
      all() {
        let rows = db._rows(table).map((row) => ({ key: String(row.key), json: JSON.stringify(row.value) }));
        if (/ORDER\\s+BY\\s+key/i.test(sql)) rows = rows.sort((a, b) => a.key.localeCompare(b.key));
        return rows;
      },
      run(key, json) {
        if (isInsert) {
          if (!Object.prototype.hasOwnProperty.call(db.data, table)) db.data[table] = [];
          const rows = db._rows(table);
          const index = rows.findIndex((entry) => String(entry.key) === String(key));
          const next = { key: String(key), value: JSON.parse(json) };
          if (index >= 0) rows[index] = next; else rows.push(next);
          db._persist();
          return { changes: 1 };
        }
        if (isDelete) {
          const rows = db._rows(table);
          const index = rows.findIndex((entry) => String(entry.key) === String(key));
          if (index < 0) return { changes: 0 };
          rows.splice(index, 1);
          db._persist();
          return { changes: 1 };
        }
        throw new Error("FakeDatabase unsupported run SQL: " + sql);
      },
    };
  }
  pragma(name) {
    if (String(name).toLowerCase() === "integrity_check") return [{ integrity_check: "ok" }];
    return [];
  }
  transaction(fn) {
    const db = this;
    return (...args) => {
      const before = JSON.parse(JSON.stringify(db.data));
      try {
        const result = fn(...args);
        db._persist();
        return result;
      } catch (error) {
        db.data = before;
        db._persist();
        throw error;
      }
    };
  }
  async backup(out) {
    fs.mkdirSync(require("path").dirname(out), { recursive: true });
    fs.copyFileSync(this.file, out);
    fs.copyFileSync(this.sidecar, out + ".json");
  }
  close() { this._persist(); }
}
module.exports = FakeDatabase;
`;
}

function makeRuntime(root, data) {
  const moduleDir = path.join(root, "server", "node_modules", "better-sqlite3");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.mkdirSync(path.join(root, "_local", "gameStore"), { recursive: true });
  fs.writeFileSync(path.join(root, "_local", "gameStore", "gamestore.sqlite"), "fixture");
  writeJson(path.join(root, "_local", "gameStore", "gamestore.sqlite.json"), data);
  writeJson(path.join(root, "server", "package.json"), { version: "0.12.7" });
  fs.writeFileSync(path.join(moduleDir, "index.js"), fakeDatabaseModule());
  writeJson(path.join(root, "_local", "gameStore", "data", "stations", "data.json"), {
    stations: [{ stationID: 6001, solarSystemID: 3001 }],
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "solarSystems", "data.json"), {
    solarSystems: [{ solarSystemID: 3001 }],
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "itemTypes", "data.json"), {
    types: [
      { typeID: 100, categoryID: 6 },
      { typeID: 5001, categoryID: 9 },
      { typeID: 5002, categoryID: 9 },
      { typeID: 35832, categoryID: 65 },
    ],
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "dungeonClientContent", "data.json"), {});
}

function item(itemID, typeID, ownerID, locationID, singleton, quantity, name) {
  return {
    key: String(itemID),
    value: {
      itemID,
      typeID,
      ownerID,
      locationID,
      flagID: 4,
      singleton,
      quantity,
      stacksize: 1,
      categoryID: typeID === 5001 || typeID === 5002 ? 9 : 6,
      itemName: name,
    },
  };
}

function state(itemID, typeID, materialEfficiency, timeEfficiency, original, runsRemaining, extra = {}) {
  return {
    key: stateKey(itemID),
    value: {
      itemID,
      typeID,
      materialEfficiency,
      timeEfficiency,
      original,
      runsRemaining,
      jobID: null,
      updatedAt: 123456,
      ...extra,
    },
  };
}

function sourceData() {
  return {
    accounts: [{ key: "pilot", value: { id: 1, password: "x" } }],
    characters: [{
      key: "140000001",
      value: {
        accountId: 1,
        characterName: "Blueprint Pilot",
        corporationID: 98000000,
        allianceID: 0,
        stationID: 6001,
        homeStationID: 6001,
        cloneStationID: 6001,
        structureID: null,
        solarSystemID: 3001,
        shipID: 2000000100,
        shipTypeID: 100,
        shipName: "Fixture Ship",
      },
    }],
    corporations: [{ key: "records", value: { "98000000": { corporationID: 98000000, corporationName: "Blueprint Corp", stationID: 6001 } } }],
    corporationRuntime: [],
    alliances: [],
    structures: [{ key: "structures", value: [{ structureID: 1030000000000, typeID: 35832, name: "Deferred Astrahus", ownerCorpID: 98000000, solarSystemID: 3001 }] }],
    items: [
      item(2000000100, 100, 140000001, 6001, 1, -1, "Fixture Ship"),
      item(2100000001, 5001, 140000001, 6001, 1, -1, "Researched Original"),
      item(2100000002, 5001, 140000001, 6001, 1, -1, "Default Original"),
      item(2100000003, 5002, 140000001, 6001, 2, -2, "Copy Seven"),
      item(2100000004, 5002, 140000001, 6001, 2, -2, "Copy Three"),
      item(2100000005, 5001, 140000001, 1030000000000, 1, -1, "Deferred Original"),
      item(2200000001, 5001, 140000099, 6001, 1, -1, "Unrelated Original"),
    ],
    industryBlueprintState: [
      state(2100000001, 5001, 10, 20, true, -1, { lastCompletedJobID: 970000000000001 }),
      // 2100000002 intentionally has no row: EveJS safely defaults singleton-1 originals.
      state(2100000003, 5002, 10, 12, false, 7),
      state(2100000004, 5002, 2, 4, false, 3),
      state(2100000005, 5001, 5, 10, true, -1),
      state(2200000001, 5001, 9, 18, true, -1),
    ],
    industryJobs: [{ key: "jobs", value: {} }],
    identityState: [],
    mail: [],
    skills: [],
    skillPlans: [],
    skillQueues: [],
    skillTradingState: [],
    characterExpertSystems: [],
    walletAuthorityState: [],
    lpWallets: [],
    bookmarkKnownFolders: [],
    savedFittings: [],
    notifications: [],
    mapTelemetry: [],
    evermarkEntitlements: [],
    moduleGroupingState: [],
    shipDirt: [],
    shipKillCounters: [],
    shipLogoFittings: [],
    bookmarkFolders: [],
    bookmarkSubfolders: [],
    bookmarkGroups: [],
    bookmarks: [],
    dungeonRuntimeState: [{ key: "sentinel", value: { unchanged: true } }],
  };
}

function targetData() {
  const data = sourceData();
  data.accounts = [];
  data.characters = [];
  data.corporations = [{ key: "records", value: {} }];
  data.structures = [{ key: "structures", value: [] }];
  data.items = [
    item(2100000001, 5001, 140000001, 6001, 1, -1, "Stale Original"),
    item(2999999999, 5001, 140000001, 6001, 1, -1, "Stale Owner Blueprint"),
    item(2888888888, 5001, 140000088, 6001, 1, -1, "Unrelated Target Blueprint"),
  ];
  data.industryBlueprintState = [
    state(2100000001, 5001, 0, 0, true, -1),
    state(2999999999, 5001, 1, 2, true, -1),
    state(2888888888, 5001, 3, 6, true, -1),
  ];
  data.industryJobs = [{ key: "jobs", value: {} }];
  data.dungeonRuntimeState = [{ key: "sentinel", value: { unchanged: true } }];
  return data;
}

function run(args, expected = 0) {
  const result = cp.spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
  if (result.status !== expected) {
    throw new Error(`Unexpected exit ${result.status}; expected ${expected}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function exportFixture(temp, label, mutate = null) {
  const root = path.join(temp, label);
  const data = sourceData();
  if (mutate) mutate(data);
  makeRuntime(root, data);
  const bundlePath = path.join(temp, `${label}.json`);
  const result = run(["export", "--source-root", root, "--out", bundlePath]);
  return { root, bundlePath, bundle: JSON.parse(fs.readFileSync(bundlePath, "utf8")), result };
}

function hasBlocker(bundle, code) {
  return (bundle.warnings || []).some((warning) => warning.code === code && warning.severity === "blocking");
}

function mutateState(data, itemID, mutate) {
  const row = data.industryBlueprintState.find((entry) => Number(entry.value.itemID) === Number(itemID));
  if (!row) throw new Error(`Missing fixture state ${itemID}`);
  mutate(row);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-private-r16-blueprints-"));
try {
  const baseline = exportFixture(temp, "baseline");
  const bundle = baseline.bundle;
  const rows = new Map(bundle.rows.industryBlueprintState.map((row) => [row.key, row.value]));

  assert(bundle.toolVersion === "r1.6" && bundle.bundleVersion === 5, "r1.6 bundle identity");
  assert(rows.size === 4, "only four transferable blueprint-state rows are exported");
  assert(rows.get(stateKey(2100000001)).materialEfficiency === 10 && rows.get(stateKey(2100000001)).timeEfficiency === 20, "researched original ME/TE round-trip source");
  assert(rows.get(stateKey(2100000002)).materialEfficiency === 0 && rows.get(stateKey(2100000002)).timeEfficiency === 0 && rows.get(stateKey(2100000002)).runsRemaining === -1, "missing original state becomes canonical EveJS default");
  assert(rows.get(stateKey(2100000003)).original === false && rows.get(stateKey(2100000003)).runsRemaining === 7, "copy finite runs preserved");
  assert(rows.get(stateKey(2100000004)).runsRemaining === 3, "same-type copies keep independent runs");
  assert(!rows.has(stateKey(2100000005)), "deferred structure-rooted blueprint state excluded");
  assert((bundle.deferred.blueprintStateRows || []).some((row) => row.itemID === 2100000005), "deferred companion state reported");
  assert(!rows.has(stateKey(2200000001)), "unrelated owner blueprint state excluded");
  assert(!Object.prototype.hasOwnProperty.call(rows.get(stateKey(2100000001)), "lastCompletedJobID"), "job replay history normalized away");
  assert([...rows.values()].every((value) => value.jobID === null), "active job linkage normalized to null");
  assert(bundle.blueprintSummary.blueprintStateRows === 4 && bundle.blueprintSummary.blueprintCopies === 2, "explicit blueprint summary counts");

  const targetRoot = path.join(temp, "target");
  makeRuntime(targetRoot, targetData());
  const beforeTarget = JSON.parse(fs.readFileSync(path.join(targetRoot, "_local", "gameStore", "gamestore.sqlite.json"), "utf8"));
  const beforeWorld = JSON.stringify(beforeTarget.dungeonRuntimeState);
  const imported = run(["import", "--target-root", targetRoot, "--in", baseline.bundlePath, "--replace-existing", "--apply"]);
  assert(/IMPORT_OK/.test(imported.stdout), "blueprint fixture import succeeds");
  assert(/Forbidden world-state fingerprints: unchanged/.test(imported.stdout), "engine confirms forbidden world isolation");
  const after = JSON.parse(fs.readFileSync(path.join(targetRoot, "_local", "gameStore", "gamestore.sqlite.json"), "utf8"));
  const afterStates = new Map(after.industryBlueprintState.map((row) => [row.key, row.value]));
  assert(afterStates.get(stateKey(2100000001)).materialEfficiency === 10 && afterStates.get(stateKey(2100000001)).timeEfficiency === 20, "import preserves researched original semantics");
  assert(afterStates.get(stateKey(2100000003)).runsRemaining === 7 && afterStates.get(stateKey(2100000004)).runsRemaining === 3, "import preserves independent copy runs");
  assert(!afterStates.has(stateKey(2999999999)), "replacement cleanup removes stale same-owner companion state");
  assert(afterStates.get(stateKey(2888888888)).materialEfficiency === 3, "replacement cleanup leaves unrelated target state untouched");
  assert(!afterStates.has(stateKey(2100000005)), "deferred blueprint state remains absent after import");
  assert(JSON.stringify(after.dungeonRuntimeState) === beforeWorld, "forbidden world table is byte-logically unchanged");
  assert(!Object.prototype.hasOwnProperty.call(bundle.rows, "industryJobs"), "active industryJobs are not exported");

  const missingCopy = exportFixture(temp, "missing-copy", (data) => {
    data.industryBlueprintState = data.industryBlueprintState.filter((row) => row.value.itemID !== 2100000003);
  });
  assert(hasBlocker(missingCopy.bundle, "BLUEPRINT_COPY_STATE_MISSING"), "missing copy companion state blocks");

  const keyMismatch = exportFixture(temp, "key-mismatch", (data) => {
    mutateState(data, 2100000001, (row) => { row.key = stateKey(9999999999); });
  });
  assert(hasBlocker(keyMismatch.bundle, "BLUEPRINT_STATE_KEY_ITEMID_MISMATCH"), "state key/itemID mismatch blocks");

  const typeMismatch = exportFixture(temp, "type-mismatch", (data) => {
    mutateState(data, 2100000001, (row) => { row.value.typeID = 5002; });
  });
  assert(hasBlocker(typeMismatch.bundle, "BLUEPRINT_STATE_TYPE_MISMATCH"), "state typeID mismatch blocks");

  const invalidMe = exportFixture(temp, "invalid-me", (data) => {
    mutateState(data, 2100000001, (row) => { row.value.materialEfficiency = 11; });
  });
  assert(hasBlocker(invalidMe.bundle, "BLUEPRINT_STATE_MATERIAL_EFFICIENCY_INVALID"), "invalid ME blocks");

  const invalidTe = exportFixture(temp, "invalid-te", (data) => {
    mutateState(data, 2100000001, (row) => { row.value.timeEfficiency = 21; });
  });
  assert(hasBlocker(invalidTe.bundle, "BLUEPRINT_STATE_TIME_EFFICIENCY_INVALID"), "invalid TE blocks");

  const singletonMismatch = exportFixture(temp, "singleton-mismatch", (data) => {
    mutateState(data, 2100000001, (row) => { row.value.original = false; row.value.runsRemaining = 5; });
  });
  assert(hasBlocker(singletonMismatch.bundle, "BLUEPRINT_STATE_SINGLETON_ORIGINAL_MISMATCH"), "singleton/original mismatch blocks");

  const invalidOriginalRuns = exportFixture(temp, "invalid-original-runs", (data) => {
    mutateState(data, 2100000001, (row) => { row.value.runsRemaining = 0; });
  });
  assert(hasBlocker(invalidOriginalRuns.bundle, "BLUEPRINT_STATE_RUNS_INVALID"), "invalid original runs block");

  const invalidCopyRuns = exportFixture(temp, "invalid-copy-runs", (data) => {
    mutateState(data, 2100000003, (row) => { row.value.runsRemaining = 0; });
  });
  assert(hasBlocker(invalidCopyRuns.bundle, "BLUEPRINT_STATE_RUNS_INVALID"), "invalid copy runs block");

  const activeJob = exportFixture(temp, "active-job", (data) => {
    mutateState(data, 2100000001, (row) => { row.value.jobID = 970000000000001; });
  });
  assert(hasBlocker(activeJob.bundle, "BLUEPRINT_ACTIVE_INDUSTRY_JOB"), "active jobID blocks");
  assert(!(activeJob.bundle.rows.industryBlueprintState || []).some((row) => row.value.jobID), "active job state is not bundled");

  const installed = exportFixture(temp, "installed-location", (data) => {
    data.items.find((row) => row.value.itemID === 2100000001).value.locationID = 2003;
  });
  assert(hasBlocker(installed.bundle, "BLUEPRINT_INSTALLED_LOCATION_ACTIVE"), "installed active-industry location blocks");

  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.rows.industryBlueprintState[0].value.lastCompletedJobID = 99;
  const tamperedPath = path.join(temp, "tampered.json");
  writeJson(tamperedPath, tampered);
  const rejected = run(["inspect", "--in", tamperedPath], 1);
  assert(/job replay history is not transferable/i.test(rejected.stderr), "bundle validation rejects imported job history");

  console.log(`BLUEPRINT_STATE_VERIFIER_PASS ${passed}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
