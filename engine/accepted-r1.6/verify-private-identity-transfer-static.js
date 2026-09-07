#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const tool = path.join(__dirname, "private-identity-transfer.js");
let passed = 0;

function run(args, expectCode = 0) {
  const result = cp.spawnSync(process.execPath, [tool, ...args], {
    encoding: "utf8",
  });
  if (result.status !== expectCode) {
    throw new Error(
      `Unexpected exit for ${args.join(" ")}: got ${result.status}, expected ${expectCode}\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  passed += 1;
  return result;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-private-transfer-static-"));
try {
  run(["--help"], 0);

  const valid = {
    tool: "EveJS-Private-Identity-Transfer",
    toolVersion: "r1.6",
    bundleVersion: 5,
    source: { version: "0.12.6" },
    policy: {},
    selected: {
      accountIDs: [1],
      characterIDs: [140000001],
      corporationIDs: [98000000],
      allianceIDs: [],
      itemIDs: [1990000000],
    },
    corporations: [{ corporationID: 98000000, record: { corporationID: 98000000 } }],
    alliances: [],
    rows: {
      accounts: [{ key: "test", value: { id: 1 } }],
      characters: [{ key: "140000001", value: { accountId: 1 } }],
      items: [{ key: "1990000000", value: { itemID: 1990000000, ownerID: 140000001 } }],
    },
    deferred: {
      playerStructures: [{ structureID: 1030000000000, typeID: 35832, name: "Test Astrahus", ownerCorpID: 98000000, solarSystemID: 30000001 }],
      corporationOffices: [],
      items: [{ itemID: 1990000001, typeID: 4246, ownerID: 140000001, locationID: 1030000000000, shipID: 0, reason: "inside-player-structure" }],
    },
    warnings: [],
  };
  const validPath = path.join(dir, "valid.json");
  fs.writeFileSync(validPath, JSON.stringify(valid));
  const validResult = run(["inspect", "--in", validPath], 0);
  if (!validResult.stdout.includes('"worldTablesIncluded": []')) {
    throw new Error("Valid bundle inspect did not report an empty world-table list.");
  }
  passed += 1;
  if (!validResult.stdout.includes('"deferredStructures": 1') || !validResult.stdout.includes('"deferredItems": 1')) {
    throw new Error("Valid bundle inspect did not report deferred structure-domain counts.");
  }
  passed += 1;

  const forbidden = JSON.parse(JSON.stringify(valid));
  forbidden.rows.dungeonRuntimeState = [{ key: "instancesByID\u001f1", value: { instanceID: 1 } }];
  const forbiddenPath = path.join(dir, "forbidden.json");
  fs.writeFileSync(forbiddenPath, JSON.stringify(forbidden));
  const forbiddenResult = run(["inspect", "--in", forbiddenPath], 1);
  if (!forbiddenResult.stderr.includes("forbidden world tables")) {
    throw new Error("Forbidden-table bundle did not fail for the expected safety reason.");
  }
  passed += 1;

  const wrongVersion = JSON.parse(JSON.stringify(valid));
  wrongVersion.bundleVersion = 2;
  const wrongPath = path.join(dir, "wrong-version.json");
  fs.writeFileSync(wrongPath, JSON.stringify(wrongVersion));
  const versionResult = run(["inspect", "--in", wrongPath], 1);
  if (!versionResult.stderr.includes("Bundle version")) {
    throw new Error("Wrong bundle version did not fail closed.");
  }
  passed += 1;

  const toolSource = fs.readFileSync(tool, "utf8");
  for (const required of [
    'readStaticPayload(root, table)',
    'staticRows(root, "stations", "stations")',
    'staticRows(root, "solarSystems", "solarSystems")',
    'staticRows(root, "itemTypes", "types")',
    'validateTargetStaticReferences(targetRoot, bundle)',
    'playerStructureRecords(db)',
    'discoverPlayerStructureOfficeContext(db, corpIDs, staticStations, structureIDs)',
    'reason: reasonByID.get(itemID) || "deferred"',
    'playerStructureInventory: "deferred with structure; no automatic re-home"',
  ]) {
    if (!toolSource.includes(required)) {
      throw new Error(`Missing static-authority safety seam: ${required}`);
    }
    passed += 1;
  }
  for (const forbidden of [
    'staticStationIDs(db)',
    'staticSolarSystemIDs(db)',
    'itemCategoryMap(db)',
  ]) {
    if (toolSource.includes(forbidden)) {
      throw new Error(`SQLite-backed static-authority regression detected: ${forbidden}`);
    }
    passed += 1;
  }

  console.log(`STATIC_VERIFIER_PASS ${passed}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
