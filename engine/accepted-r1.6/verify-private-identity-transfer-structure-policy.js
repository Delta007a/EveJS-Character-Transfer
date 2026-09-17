#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const tool = path.join(__dirname, "private-identity-transfer.js");
const US = String.fromCharCode(31);
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function makeRuntime(root, dbData) {
  fs.mkdirSync(path.join(root, "server", "node_modules", "better-sqlite3"), { recursive: true });
  fs.mkdirSync(path.join(root, "_local", "gameStore"), { recursive: true });
  fs.writeFileSync(path.join(root, "_local", "gameStore", "gamestore.sqlite"), "fake");
  writeJson(path.join(root, "_local", "gameStore", "gamestore.sqlite.json"), dbData);
  writeJson(path.join(root, "server", "package.json"), { version: "0.12.7-test-fixture" });

  fs.writeFileSync(
    path.join(root, "server", "node_modules", "better-sqlite3", "index.js"),
`"use strict";
const fs = require("fs");
class FakeDatabase {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(fs.readFileSync(file + ".json", "utf8"));
  }
  _rows(table) {
    const rows = this.data[table];
    return Array.isArray(rows) ? rows : [];
  }
  prepare(sql) {
    const db = this;
    if (sql.includes("sqlite_master")) {
      return {
        get(table) {
          return Object.prototype.hasOwnProperty.call(db.data, String(table)) ? { present: 1 } : undefined;
        },
        all() { return []; },
      };
    }
    const match = sql.match(/FROM\\s+"([^"]+)"/i);
    if (!match) throw new Error("FakeDatabase unsupported SQL: " + sql);
    const table = match[1].replaceAll('""', '"');
    const hasWhereKey = /WHERE\\s+key=\\?/i.test(sql);
    return {
      get(key) {
        if (!hasWhereKey) return undefined;
        const row = db._rows(table).find((x) => String(x.key) === String(key));
        return row ? { key: String(row.key), json: JSON.stringify(row.value) } : undefined;
      },
      all() {
        return db._rows(table).map((row) => ({ key: String(row.key), json: JSON.stringify(row.value) }));
      },
      run() { throw new Error("FakeDatabase run() not supported in export verifier"); },
    };
  }
  pragma(name) {
    if (String(name).toLowerCase() === "integrity_check") return [{ integrity_check: "ok" }];
    return [];
  }
  close() {}
}
module.exports = FakeDatabase;
`,
  );

  writeJson(path.join(root, "_local", "gameStore", "data", "stations", "data.json"), {
    stations: [{ stationID: 6001, solarSystemID: 3001 }],
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "solarSystems", "data.json"), {
    solarSystems: [{ solarSystemID: 3001 }],
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "itemTypes", "data.json"), {
    types: [
      { typeID: 100, categoryID: 6 },
      { typeID: 101, categoryID: 4 },
      { typeID: 102, categoryID: 65 },
      { typeID: 103, categoryID: 66 },
      { typeID: 104, categoryID: 20 },
    ],
  });
}

function baseDbData() {
  return {
    accounts: [
      { key: "user", value: { id: 1, password: "x" } },
    ],
    characters: [
      {
        key: "140000001",
        value: {
          accountId: 1,
          characterName: "Fixture",
          corporationID: 98000000,
          allianceID: 0,
          stationID: 6001,
          homeStationID: 6001,
          cloneStationID: 6001,
          structureID: null,
          solarSystemID: 3001,
          shipID: 2000000100,
          shipTypeID: 100,
          shipName: "Imported Ship",
          balance: 123,
        },
      },
    ],
    corporations: [
      {
        key: "records",
        value: {
          "98000000": {
            corporationID: 98000000,
            corporationName: "Fixture Corp",
            stationID: 6001,
            allianceID: 0,
          },
        },
      },
    ],
    corporationRuntime: [
      {
        key: `corporations${US}98000000`,
        value: {
          corporationID: 98000000,
          offices: {
            "100": { officeID: 100, officeFolderID: 10100, stationID: 6001 },
            "267": { officeID: 267, officeFolderID: 268, stationID: 1030000000000 },
          },
          officeRentalSettlements: [{ id: 1 }],
        },
      },
    ],
    structures: [
      {
        key: "structures",
        value: [
          {
            structureID: 1030000000000,
            typeID: 35832,
            name: "Fixture Astrahus",
            ownerCorpID: 98000000,
            solarSystemID: 3001,
          },
        ],
      },
    ],
    items: [
      { key: "2000000100", value: { itemID: 2000000100, typeID: 100, ownerID: 140000001, locationID: 6001, flagID: 4 } },
      { key: "2000000101", value: { itemID: 2000000101, typeID: 101, ownerID: 140000001, locationID: 6001, flagID: 4 } },
      { key: "2000000200", value: { itemID: 2000000200, typeID: 101, ownerID: 140000001, locationID: 1030000000000, flagID: 4 } },
      { key: "2000000201", value: { itemID: 2000000201, typeID: 104, ownerID: 140000001, locationID: 2000000200, flagID: 5 } },
      { key: "2000000300", value: { itemID: 2000000300, typeID: 103, ownerID: 98000000, locationID: 1030000000000, flagID: 164 } },
      { key: "2000000400", value: { itemID: 2000000400, typeID: 101, ownerID: 98000000, locationID: 267, flagID: 116 } },
      { key: "2000000500", value: { itemID: 2000000500, typeID: 102, ownerID: 98000000, locationID: 3001, flagID: 0 } },
    ],
  };
}

function runExport(runtime, outFile) {
  return cp.spawnSync(process.execPath, [tool, "export", "--source-root", runtime, "--out", outFile], {
    encoding: "utf8",
  });
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-private-r16-structure-"));
try {
  const runtime = path.join(temp, "runtime");
  makeRuntime(runtime, baseDbData());
  const bundlePath = path.join(temp, "bundle.json");
  const result = runExport(runtime, bundlePath);
  if (result.status !== 0) {
    throw new Error(`Fixture export failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));

  assert(bundle.bundleVersion === 6, "bundleVersion must be 6");
  assert((bundle.warnings || []).length === 0, "known structure domain should not create blocking warnings");

  const imported = new Set((bundle.rows.items || []).map((row) => Number(row.value.itemID)));
  assert(imported.has(2000000100) && imported.has(2000000101), "ordinary NPC-station items must transfer");
  for (const id of [2000000200, 2000000201, 2000000300, 2000000400, 2000000500]) {
    assert(!imported.has(id), `deferred item ${id} must not be in classic rows.items`);
  }

  const deferred = new Map((bundle.deferred.items || []).map((item) => [Number(item.itemID), item]));
  assert(deferred.get(2000000200)?.reason === "inside-player-structure", "direct structure asset must be deferred as inside-player-structure");
  assert(deferred.get(2000000201)?.reason === "nested-under-deferred-item", "nested child must follow deferred parent");
  assert(deferred.get(2000000400)?.reason === "inside-player-structure-office", "structure-office asset must be deferred");
  assert(deferred.get(2000000500)?.reason === "player-world-object", "corp world object must be deferred");
  assert((bundle.deferred.playerStructures || []).length === 1, "selected player structure must appear in deferred audit summary");
  assert((bundle.deferred.corporationOffices || []).length === 1, "player-structure corporation office must be deferred");

  const corpRow = (bundle.rows.corporationRuntime || []).find((row) => String(row.key).startsWith("corporations"));
  const offices = (corpRow && corpRow.value && corpRow.value.offices) || {};
  assert(Boolean(offices["100"]), "NPC-station office must remain in classic corporation runtime");
  assert(!offices["267"], "player-structure office must be absent from classic corporation runtime");
  assert(Array.isArray(corpRow.value.officeRentalSettlements) && corpRow.value.officeRentalSettlements.length === 0, "operational corp settlement state must still be cleared");

  // Unknown dynamic location must remain fail-closed.
  const unknownData = baseDbData();
  unknownData.items.push({
    key: "2000000600",
    value: { itemID: 2000000600, typeID: 101, ownerID: 140000001, locationID: 999999999, flagID: 4 },
  });
  const runtimeUnknown = path.join(temp, "runtime-unknown");
  makeRuntime(runtimeUnknown, unknownData);
  const unknownBundlePath = path.join(temp, "unknown.json");
  const unknownResult = runExport(runtimeUnknown, unknownBundlePath);
  if (unknownResult.status !== 0) {
    throw new Error(`Unknown-location fixture export failed unexpectedly\n${unknownResult.stderr}`);
  }
  const unknownBundle = JSON.parse(fs.readFileSync(unknownBundlePath, "utf8"));
  assert((unknownBundle.warnings || []).some((w) => w.code === "EXTERNAL_ITEM_LOCATIONS" && w.severity === "blocking"), "unknown dynamic location must remain blocking");

  // Active ship in deferred structure domain must be an explicit blocker.
  const activeDeferredData = baseDbData();
  activeDeferredData.characters[0].value.shipID = 2000000200;
  const runtimeActive = path.join(temp, "runtime-active-deferred");
  makeRuntime(runtimeActive, activeDeferredData);
  const activeBundlePath = path.join(temp, "active.json");
  const activeResult = runExport(runtimeActive, activeBundlePath);
  if (activeResult.status !== 0) {
    throw new Error(`Active-deferred fixture export failed unexpectedly\n${activeResult.stderr}`);
  }
  const activeBundle = JSON.parse(fs.readFileSync(activeBundlePath, "utf8"));
  assert((activeBundle.warnings || []).some((w) => w.code === "CHARACTER_ACTIVE_SHIP_DEFERRED" && w.severity === "blocking"), "character active ship deferred must block classic transfer");

  console.log(`STRUCTURE_POLICY_VERIFIER_PASS ${passed}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
