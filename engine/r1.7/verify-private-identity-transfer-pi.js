#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const transfer = require(path.join(__dirname, "private-identity-transfer.js"));
const US = String.fromCharCode(31);
const originalMultiplierEnv = process.env.EVEJS_PLANET_SCHEMATIC_OUTPUT_MULTIPLIER;
delete process.env.EVEJS_PLANET_SCHEMATIC_OUTPUT_MULTIPLIER;
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}
function assertThrows(fn, pattern, message) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert(error && pattern.test(String(error.message)), message);
}
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

class FakeDatabase {
  constructor(data = {}) {
    this.data = clone(data);
    this.mutations = [];
  }
  rows(table) { return Array.isArray(this.data[table]) ? this.data[table] : []; }
  prepare(sql) {
    const db = this;
    if (sql.includes("sqlite_master")) {
      return { get(table) { return Object.prototype.hasOwnProperty.call(db.data, String(table)) ? { present: 1 } : undefined; } };
    }
    const create = sql.match(/CREATE TABLE IF NOT EXISTS\s+"([^"]+)"/i);
    if (create) {
      return { run() { if (!db.data[create[1]]) db.data[create[1]] = []; db.mutations.push(`create:${create[1]}`); return { changes: 0 }; } };
    }
    const from = sql.match(/FROM\s+"([^"]+)"/i);
    if (from) {
      const table = from[1];
      const where = /WHERE\s+key=\?/i.test(sql);
      return {
        get(key) {
          if (!where) return undefined;
          const row = db.rows(table).find((entry) => String(entry.key) === String(key));
          return row ? { key: String(row.key), json: JSON.stringify(row.value) } : undefined;
        },
        all() { return db.rows(table).map((row) => ({ key: String(row.key), json: JSON.stringify(row.value) })); },
      };
    }
    const insert = sql.match(/INSERT INTO\s+"([^"]+)"/i);
    if (insert) {
      const table = insert[1];
      return {
        run(key, json) {
          if (!db.data[table]) db.data[table] = [];
          const value = JSON.parse(json);
          const existing = db.data[table].find((row) => String(row.key) === String(key));
          if (existing) existing.value = value;
          else db.data[table].push({ key: String(key), value });
          db.mutations.push(`put:${table}:${key}`);
          return { changes: 1 };
        },
      };
    }
    throw new Error(`Unsupported fake SQL: ${sql}`);
  }
  transaction(callback) {
    const db = this;
    return () => {
      const before = clone(db.data);
      try { return callback(); } catch (error) { db.data = before; throw error; }
    };
  }
}

const IDS = Object.freeze({
  selected: 140000011,
  unrelated: 140000099,
  planet: 40000001,
  otherPlanet: 40000002,
  system: 30000142,
  commandType: 2254,
  storageType: 2541,
  processType: 2469,
  linkType: 2280,
  commodityType: 2268,
  schematic: 101,
});

function colony(ownerID, planetID = IDS.planet, offset = 0) {
  const command = 900000000100 + offset;
  const storage = command + 1;
  const process = command + 2;
  return {
    planetID,
    ownerID,
    solarSystemID: IDS.system,
    planetTypeID: 2016,
    planetRadius: 6000000,
    typeID: 2016,
    level: 3,
    commandCenterLevel: 3,
    networkRevision: 7,
    currentSimTime: "133700000000000000",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    persistedExtension: { preserve: true },
    pins: [
      { id: command, pinID: command, ownerID, typeID: IDS.commandType, latitude: 1, longitude: 2,
        lastRunTime: "133700000000000000", contents: { [IDS.commodityType]: 12 }, state: 0, lastLaunchTime: "0" },
      { id: storage, pinID: storage, ownerID, typeID: IDS.storageType, latitude: 1.1, longitude: 2.1,
        lastRunTime: "133700000000000000", contents: {}, state: 0 },
      { id: process, pinID: process, ownerID, typeID: IDS.processType, latitude: 1.2, longitude: 2.2,
        lastRunTime: "133700000000000000", contents: {}, state: 0, schematicID: IDS.schematic,
        hasReceivedInputs: true, receivedInputsLastCycle: true },
    ],
    links: [
      { typeID: IDS.linkType, endpoint1: command, endpoint2: storage, level: 0 },
      { typeID: IDS.linkType, endpoint1: storage, endpoint2: process, level: 0 },
    ],
    routes: [
      { routeID: 100 + offset, charID: ownerID, path: [command, storage, process],
        commodityTypeID: IDS.commodityType, commodityQuantity: 5 },
    ],
  };
}

function piRows(colonies = {}, extras = {}) {
  const rows = [
    { key: "schemaVersion", value: 2 },
    { key: "resourcesByPlanetID", value: {} },
    { key: "coloniesByKey", value: {} },
    { key: "launchesByID", value: {} },
    { key: "acceptedNetworkEditsByKey", value: {} },
    { key: "networkEditReceiptsByKey", value: {} },
    { key: "customsOperationReceipts", value: extras.customsOperationReceipts || {} },
    { key: "nextIDs", value: extras.nextIDs || { pinID: 900000000900, routeID: 900, launchID: 910000000900 } },
  ];
  for (const [key, value] of Object.entries(colonies)) rows.push({ key: `coloniesByKey${US}${key}`, value });
  for (const [key, value] of Object.entries(extras.resourcesByPlanetID || {})) rows.push({ key: `resourcesByPlanetID${US}${key}`, value });
  for (const [key, value] of Object.entries(extras.launchesByID || {})) rows.push({ key: `launchesByID${US}${key}`, value });
  return rows;
}

function makeRuntime(root, multiplier = 1, schematicCycle = 1800) {
  const runtimeStore = path.join(root, "server", "src", "services", "planet", "planetRuntimeStore.js");
  fs.mkdirSync(path.dirname(runtimeStore), { recursive: true });
  fs.writeFileSync(runtimeStore, 'const TABLE_NAME = "planetRuntimeState";\nconst SCHEMA_VERSION = 2;\n');
  const schema = path.join(root, "server", "src", "config", "schema", "gameplay.js");
  fs.mkdirSync(path.dirname(schema), { recursive: true });
  fs.writeFileSync(schema, 'module.exports = [{"key":"planetSchematicOutputMultiplier","defaultValue":1}];\n');
  writeJson(path.join(root, "config", "gameplay.json"), {
    planets: { planetSchematicOutputMultiplier: multiplier },
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "celestials", "data.json"), {
    celestials: [
      { kind: "planet", itemID: IDS.planet, solarSystemID: IDS.system, typeID: 2016, radius: 6000000 },
      { kind: "planet", itemID: IDS.otherPlanet, solarSystemID: IDS.system, typeID: 2016, radius: 6000000 },
    ],
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "planetSchematics", "data.json"), {
    schematics: [{ schematicID: IDS.schematic, name: { en: "Test" }, cycleTime: schematicCycle,
      pinTypeIDs: [IDS.processType], inputs: [{ typeID: IDS.commodityType, quantity: 5 }],
      outputs: [{ typeID: 2393, quantity: 1 }] }],
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "itemTypes", "data.json"), {
    types: [
      { typeID: IDS.commandType, groupID: 1027, categoryID: 41, volume: 1 },
      { typeID: IDS.storageType, groupID: 1029, categoryID: 41, volume: 1 },
      { typeID: IDS.processType, groupID: 1028, categoryID: 41, volume: 1 },
      { typeID: IDS.linkType, groupID: 1036, categoryID: 41, volume: 1 },
      { typeID: IDS.commodityType, groupID: 1033, categoryID: 42, volume: 0.01 },
    ],
  });
  writeJson(path.join(root, "_local", "gameStore", "data", "typeDogma", "data.json"), {
    typesByTypeID: Object.fromEntries(
      [IDS.commandType, IDS.storageType, IDS.processType, IDS.linkType, IDS.commodityType]
        .map((typeID) => [String(typeID), { attributes: { "1631": 1000 } }]),
    ),
  });
}

function bundle(pi) {
  return {
    tool: "EveJS-Private-Identity-Transfer",
    toolVersion: "r1.7",
    bundleVersion: 6,
    selected: { characterIDs: [IDS.selected], accountIDs: [], corporationIDs: [], allianceIDs: [], itemIDs: [] },
    rows: {},
    achievements: null,
    planetaryInteraction: pi,
  };
}

const fixtureRoot = fs.mkdtempSync(path.join(__dirname, ".tmp-pi-"));
try {
  const sourceRoot = path.join(fixtureRoot, "source");
  const targetRoot = path.join(fixtureRoot, "target");
  makeRuntime(sourceRoot);
  makeRuntime(targetRoot);
  const selected = colony(IDS.selected);
  const unrelatedSource = colony(IDS.unrelated, IDS.otherPlanet, 1000);
  const sourceWorld = { abundance: 0.42, depletion: [{ x: 1, y: 2 }] };
  const source = new FakeDatabase({
    planetRuntimeState: piRows({
      [`${IDS.planet}:${IDS.selected}`]: selected,
      [`${IDS.otherPlanet}:${IDS.unrelated}`]: unrelatedSource,
    }, { resourcesByPlanetID: { [IDS.planet]: sourceWorld } }),
    planetOrbitalState: [{ key: "orbitalsByID", value: { 1: { ownerID: IDS.selected } } }],
    items: [], scheduledJobs: [],
  });

  // 1/2: exact selected colony transfers; unrelated source colony is excluded.
  const exported = transfer.collectPlanetaryInteractionTransfer(source, sourceRoot, new Set([IDS.selected]));
  assert(JSON.stringify(exported.coloniesByKey[`${IDS.planet}:${IDS.selected}`]) === JSON.stringify(selected),
    "selected colony must export exactly");
  assert(!Object.prototype.hasOwnProperty.call(exported.coloniesByKey, `${IDS.otherPlanet}:${IDS.unrelated}`),
    "unrelated source colony must be excluded");
  assert(exported.runtimeSchemaVersion === 2 && !Object.hasOwn(exported, "outputMultiplier"),
    "PI schema must be recorded without requiring output multiplier metadata");

  const piBundle = bundle(exported);
  transfer.validateBundle(piBundle);
  transfer.validatePiTargetCompatibility(targetRoot, piBundle);

  // Bundle v6 absence/empty payloads are no-ops; additive and legacy
  // diagnostic metadata do not control compatibility or allocator safety.
  const missingPiBundle = bundle(null);
  delete missingPiBundle.planetaryInteraction;
  transfer.validateBundle(missingPiBundle);
  assert(transfer.planPlanetaryInteractionImport(new FakeDatabase({}), missingPiBundle) === null,
    "missing v6 PI field must mean no payload");
  const emptyPiBundle = bundle({ coloniesByKey: {}, informationalExtension: { future: true } });
  transfer.validateBundle(emptyPiBundle);
  const irrelevantMalformedTarget = new FakeDatabase({
    planetRuntimeState: [{ key: "schemaVersion", value: 999 }],
  });
  assert(transfer.planPlanetaryInteractionImport(irrelevantMalformedTarget, emptyPiBundle) === null &&
    transfer.importPlanetaryInteraction(irrelevantMalformedTarget, emptyPiBundle, null) === 0,
  "empty v6 PI colonies must be a no-op without inspecting target PI");
  const metadataFreeBundle = clone(piBundle);
  delete metadataFreeBundle.planetaryInteraction.allocatorRequirements;
  delete metadataFreeBundle.planetaryInteraction.staticAuthority;
  metadataFreeBundle.planetaryInteraction.informationalExtension = { future: true };
  transfer.validateBundle(metadataFreeBundle);
  transfer.validatePiTargetCompatibility(targetRoot, metadataFreeBundle);
  const metadataFreePlan = transfer.planPlanetaryInteractionImport(new FakeDatabase({}), metadataFreeBundle);
  assert(metadataFreePlan.nextIDs.pinID > Math.max(...selected.pins.map((pin) => pin.pinID)) &&
    metadataFreePlan.nextIDs.routeID > selected.routes[0].routeID,
  "allocator floors must be derived from actual colony IDs without bundle metadata");
  const misleadingMetadataBundle = clone(piBundle);
  misleadingMetadataBundle.planetaryInteraction.allocatorRequirements = { maxPinID: 1, maxRouteID: 1 };
  misleadingMetadataBundle.planetaryInteraction.staticAuthority = "diagnostic-only";
  transfer.validateBundle(misleadingMetadataBundle);
  assert(transfer.planPlanetaryInteractionImport(new FakeDatabase({}), misleadingMetadataBundle)
    .nextIDs.pinID === metadataFreePlan.nextIDs.pinID,
  "legacy allocator/static metadata must not override recomputed floors");

  // 3/4/8: unrelated target preserved, same-key target replaced, allocators raised safely.
  const oldSelected = colony(IDS.selected, IDS.planet, 3000);
  const unrelatedTarget = colony(IDS.unrelated, IDS.otherPlanet, 6000);
  const targetResources = { abundance: 0.9, depletion: [{ x: 9, y: 9 }] };
  const target = new FakeDatabase({
    planetRuntimeState: piRows({
      [`${IDS.planet}:${IDS.selected}`]: oldSelected,
      [`${IDS.otherPlanet}:${IDS.unrelated}`]: unrelatedTarget,
    }, {
      resourcesByPlanetID: { [IDS.planet]: targetResources },
      nextIDs: { pinID: 900000000050, routeID: 50, launchID: 910000000555 },
    }),
    planetOrbitalState: [{ key: "orbitalsByID", value: { keep: true } }],
    achievements: [{ key: "version", value: 1 }, { key: "characters", value: { keep: true } }],
    items: [], scheduledJobs: [],
  });
  const orbitalBefore = clone(target.data.planetOrbitalState);
  const achievementsBefore = clone(target.data.achievements);
  const plan = transfer.planPlanetaryInteractionImport(target, piBundle);
  const protectedBefore = transfer.snapshotProtectedPiState(target, piBundle);
  assert(plan.nextIDs.pinID > Math.max(...selected.pins.map((pin) => pin.pinID), ...unrelatedTarget.pins.map((pin) => pin.pinID)),
    "pin allocator floor must exceed all retained/imported IDs");
  assert(plan.nextIDs.routeID > Math.max(selected.routes[0].routeID, unrelatedTarget.routes[0].routeID),
    "route allocator floor must exceed all retained/imported IDs");
  assert(transfer.importPlanetaryInteraction(target, piBundle, plan) === 1, "one selected colony must import");
  const importedRoot = transfer.readPiRuntimeRoot(target, "test target", { allowAbsent: false });
  assert(JSON.stringify(importedRoot.coloniesByKey[`${IDS.planet}:${IDS.selected}`]) === JSON.stringify(selected),
    "existing selected target colony must be replaced exactly");
  assert(JSON.stringify(importedRoot.coloniesByKey[`${IDS.otherPlanet}:${IDS.unrelated}`]) === JSON.stringify(unrelatedTarget),
    "unrelated target colony must remain exact");
  const importProblems = [];
  transfer.verifyImportedPlanetaryInteraction(target, piBundle, plan, importProblems);
  assert(importProblems.length === 0, "post-import PI verifier must accept safe exact replacement");

  // 9/10/16: world resources, orbitals, and achievements remain outside PI writes.
  assert(JSON.stringify(transfer.snapshotProtectedPiState(target, piBundle)) === JSON.stringify(protectedBefore),
    "world PI resources and unrelated colonies must remain unchanged");
  assert(JSON.stringify(target.data.planetOrbitalState) === JSON.stringify(orbitalBefore),
    "planetOrbitalState must not be transferred or modified");
  assert(JSON.stringify(target.data.achievements) === JSON.stringify(achievementsBefore),
    "PI import must not affect achievement state");
  assert(!Object.keys(exported).some((key) => /resource|orbital/i.test(key)),
    "PI bundle must not contain resource/depletion/orbital state");

  // Unselected source colonies and retained target colonies are inspected only
  // for selection and allocator safety, respectively.
  const malformedUnselected = colony(IDS.unrelated, IDS.otherPlanet, 9000);
  malformedUnselected.links = "unrelated malformed gameplay state";
  const scopedSource = new FakeDatabase({
    planetRuntimeState: piRows({
      [`${IDS.planet}:${IDS.selected}`]: selected,
      [`${IDS.otherPlanet}:${IDS.unrelated}`]: malformedUnselected,
    }), items: [], scheduledJobs: [],
  });
  assert(JSON.stringify(transfer.collectPlanetaryInteractionTransfer(
    scopedSource, sourceRoot, new Set([IDS.selected]),
  ).coloniesByKey[`${IDS.planet}:${IDS.selected}`]) === JSON.stringify(selected),
  "malformed unselected source colony must not block selected export");
  const allocatorReadableTarget = colony(IDS.unrelated, IDS.otherPlanet, 12000);
  allocatorReadableTarget.ownerID = 1;
  allocatorReadableTarget.links = "retained target gameplay shape is not validated";
  const scopedTarget = new FakeDatabase({
    planetRuntimeState: piRows({ [`${IDS.otherPlanet}:${IDS.unrelated}`]: allocatorReadableTarget }),
    items: [], scheduledJobs: [],
  });
  const scopedPlan = transfer.planPlanetaryInteractionImport(scopedTarget, piBundle);
  assert(scopedPlan.nextIDs.pinID > Math.max(...allocatorReadableTarget.pins.map((pin) => pin.pinID)),
    "retained target only needs readable IDs for safe allocator floors");

  // Excluded world/process rows and unrelated launch/customs entries may be
  // malformed without blocking a selected-character colony transfer.
  const relaxedWorldRows = piRows({ [`${IDS.planet}:${IDS.selected}`]: selected }, {
    resourcesByPlanetID: { [IDS.planet]: 7 },
    launchesByID: { broken: { ownerID: IDS.unrelated } },
    customsOperationReceipts: "diagnostic world-state damage",
  }).filter((row) => !["resourcesByPlanetID", "acceptedNetworkEditsByKey",
    "networkEditReceiptsByKey"].includes(row.key));
  const relaxedWorldSource = new FakeDatabase({
    planetRuntimeState: relaxedWorldRows,
    planetaryCustomsSettlements: [
      { key: "version", value: "bad" }, { key: "nextOperationID", value: "bad" },
      { key: "byCharacter", value: { [IDS.unrelated]: "malformed unrelated settlement" } },
    ],
    items: [], scheduledJobs: [],
  });
  assert(Boolean(transfer.collectPlanetaryInteractionTransfer(
    relaxedWorldSource, sourceRoot, new Set([IDS.selected]),
  )), "malformed excluded world/process state must not block selected transfer");

  const zeroContents = colony(IDS.selected);
  zeroContents.pins[0].contents[IDS.commodityType] = 0;
  const zeroExport = transfer.collectPlanetaryInteractionTransfer(
    new FakeDatabase({
      planetRuntimeState: piRows({ [`${IDS.planet}:${IDS.selected}`]: zeroContents }),
      items: [], scheduledJobs: [],
    }), sourceRoot, new Set([IDS.selected]),
  );
  assert(zeroExport.coloniesByKey[`${IDS.planet}:${IDS.selected}`]
    .pins[0].contents[IDS.commodityType] === 0,
  "zero quantity contents must transfer without normalization");

  // 5: no selected PI means explicit absence and no synthesis/write.
  const noSelectedSource = new FakeDatabase({
    planetRuntimeState: piRows({ [`${IDS.otherPlanet}:${IDS.unrelated}`]: unrelatedSource }),
  });
  assert(transfer.collectPlanetaryInteractionTransfer(noSelectedSource, sourceRoot, new Set([IDS.selected])) === null,
    "no selected colony must export absence");
  const noPiTarget = new FakeDatabase({});
  assert(transfer.importPlanetaryInteraction(noPiTarget, bundle(null), null) === 0,
    "absent PI section must perform no write");
  assert(!Object.prototype.hasOwnProperty.call(noPiTarget.data, "planetRuntimeState"),
    "absent PI must not synthesize a target table");

  // 6: malformed or mismatched ownership fails closed.
  const wrongOwner = colony(IDS.selected);
  wrongOwner.ownerID = IDS.unrelated;
  assertThrows(
    () => transfer.collectPlanetaryInteractionTransfer(
      new FakeDatabase({ planetRuntimeState: piRows({ [`${IDS.planet}:${IDS.selected}`]: wrongOwner }) }),
      sourceRoot, new Set([IDS.selected]),
    ),
    /ownership mismatch/,
    "colony key/value ownership mismatch must fail closed",
  );

  // 7: dangling pin/link/route graph references fail closed.
  const dangling = colony(IDS.selected);
  dangling.routes[0].path[1] = 999999999999;
  assertThrows(
    () => transfer.collectPlanetaryInteractionTransfer(
      new FakeDatabase({ planetRuntimeState: piRows({ [`${IDS.planet}:${IDS.selected}`]: dangling }) }),
      sourceRoot, new Set([IDS.selected]),
    ),
    /missing pin/,
    "dangling colony graph reference must fail closed",
  );

  // 8: an actual retained/imported ID collision cannot be repaired by allocator movement.
  const collisionTarget = colony(IDS.unrelated, IDS.otherPlanet);
  assertThrows(
    () => transfer.planPlanetaryInteractionImport(
      new FakeDatabase({ planetRuntimeState: piRows({ [`${IDS.otherPlanet}:${IDS.unrelated}`]: collisionTarget }) }),
      piBundle,
    ),
    /pin ID collision/,
    "retained/imported PI ID collision must fail closed",
  );

  // 11: live launches and surviving physical launch containers block migration.
  assertThrows(
    () => transfer.collectPlanetaryInteractionTransfer(
      new FakeDatabase({
        planetRuntimeState: piRows({ [`${IDS.planet}:${IDS.selected}`]: selected }, {
          launchesByID: { 910000000001: { launchID: 910000000001, ownerID: IDS.selected,
            launchTime: ((BigInt(Date.now()) * 10000n) + 116444736000000000n).toString(), deleted: false } },
        }),
        items: [], scheduledJobs: [],
      }), sourceRoot, new Set([IDS.selected]),
    ),
    /live planetary launch/,
    "live planetary launch must block",
  );
  assertThrows(
    () => transfer.collectPlanetaryInteractionTransfer(
      new FakeDatabase({
        planetRuntimeState: piRows({ [`${IDS.planet}:${IDS.selected}`]: selected }),
        items: [{ key: "1990000001", value: { itemID: 1990000001, ownerID: IDS.selected,
          typeID: 2263, locationID: IDS.system, customInfo: "{}" } }], scheduledJobs: [],
      }), sourceRoot, new Set([IDS.selected]),
    ),
    /physical planetary launch container/,
    "physical launch container must block",
  );

  // 12: settlement, escrow, and recovery-job residue each block.
  assertThrows(
    () => transfer.collectPlanetaryInteractionTransfer(
      new FakeDatabase({
        planetRuntimeState: piRows({ [`${IDS.planet}:${IDS.selected}`]: selected }),
        planetaryCustomsSettlements: [
          { key: "version", value: 1 }, { key: "nextOperationID", value: 2 },
          { key: "byCharacter", value: { [IDS.selected]: { characterID: IDS.selected } } },
        ], items: [], scheduledJobs: [],
      }), sourceRoot, new Set([IDS.selected]),
    ),
    /pending planetary customs settlement/,
    "pending customs settlement must block",
  );
  assertThrows(
    () => transfer.collectPlanetaryInteractionTransfer(
      new FakeDatabase({
        planetRuntimeState: piRows({ [`${IDS.planet}:${IDS.selected}`]: selected }),
        items: [{ key: "1990000002", value: { itemID: 1990000002, ownerID: IDS.selected,
          typeID: IDS.commodityType, locationID: 9600000002 } }], scheduledJobs: [],
        planetaryCustomsSettlements: [
          { key: "version", value: 1 }, { key: "nextOperationID", value: 3 },
          { key: "byCharacter", value: {} },
        ],
      }), sourceRoot, new Set([IDS.selected]),
    ),
    /customs escrow inventory/,
    "orphan customs escrow must block",
  );
  assertThrows(
    () => transfer.collectPlanetaryInteractionTransfer(
      new FakeDatabase({
        planetRuntimeState: piRows({ [`${IDS.planet}:${IDS.selected}`]: selected }), items: [],
        scheduledJobs: [{ key: `planet-customs:${IDS.selected}`, value: {
          jobID: `planet-customs:${IDS.selected}`, type: "planet.customs-settle",
          payload: { characterID: IDS.selected }, state: "dead-letter",
        } }],
      }), sourceRoot, new Set([IDS.selected]),
    ),
    /recovery\/scheduled job/,
    "customs recovery job must block",
  );

  // 13: source static snapshots are diagnostic; target referenced IDs are
  // validated directly, while harmless schematic/radius differences are accepted.
  const badStaticRoot = path.join(fixtureRoot, "bad-static");
  makeRuntime(badStaticRoot, 1, 3600);
  const celestialPath = path.join(badStaticRoot, "_local", "gameStore", "data", "celestials", "data.json");
  const changedCelestials = JSON.parse(fs.readFileSync(celestialPath, "utf8"));
  changedCelestials.celestials[0].radius = 7000000;
  writeJson(celestialPath, changedCelestials);
  transfer.validatePiTargetCompatibility(badStaticRoot, piBundle);
  assert(true, "target schematic details and planet radius may differ when referenced IDs remain valid");
  const missingStaticRoot = path.join(fixtureRoot, "missing-static");
  makeRuntime(missingStaticRoot);
  writeJson(path.join(missingStaticRoot, "_local", "gameStore", "data", "planetSchematics", "data.json"), {
    schematics: [],
  });
  assertThrows(
    () => transfer.validatePiTargetCompatibility(missingStaticRoot, piBundle),
    /missing schematic authority/,
    "missing target referenced schematic authority must fail closed",
  );

  // 14: different multipliers are accepted; colony and target config stay exact.
  const differentMultiplierRoot = path.join(fixtureRoot, "different-multiplier");
  makeRuntime(differentMultiplierRoot, 1.5);
  const configPath = path.join(differentMultiplierRoot, "config", "gameplay.json");
  const configBefore = fs.readFileSync(configPath, "utf8");
  const differentTarget = new FakeDatabase({ items: [], scheduledJobs: [] });
  transfer.validatePiTargetCompatibility(differentMultiplierRoot, piBundle);
  const differentPlan = transfer.planPlanetaryInteractionImport(differentTarget, piBundle);
  transfer.importPlanetaryInteraction(differentTarget, piBundle, differentPlan);
  assert(JSON.stringify(transfer.readPiRuntimeRoot(differentTarget, "test target")
    .coloniesByKey[`${IDS.planet}:${IDS.selected}`]) === JSON.stringify(selected),
  "source x1 to target x1.5 must preserve the colony exactly");
  assert(fs.readFileSync(configPath, "utf8") === configBefore,
    "transfer must preserve target multiplier configuration exactly");
  const olderBundle = clone(piBundle);
  olderBundle.planetaryInteraction.outputMultiplier = 3;
  transfer.validateBundle(olderBundle);
  transfer.validatePiTargetCompatibility(differentMultiplierRoot, olderBundle);
  assert(true, "older v6 multiplier metadata must be accepted without equality checks");

  // 15: verifier failure inside a transaction rolls every PI write back.
  const rollbackTarget = new FakeDatabase({
    planetRuntimeState: piRows({ [`${IDS.otherPlanet}:${IDS.unrelated}`]: unrelatedTarget }),
    items: [], scheduledJobs: [],
  });
  const rollbackBefore = clone(rollbackTarget.data);
  const rollbackPlan = transfer.planPlanetaryInteractionImport(rollbackTarget, piBundle);
  assertThrows(
    () => rollbackTarget.transaction(() => {
      transfer.importPlanetaryInteraction(rollbackTarget, piBundle, rollbackPlan);
      rollbackTarget.data.planetRuntimeState.push({
        key: `resourcesByPlanetID${US}${IDS.planet}`, value: { illegallyChanged: true },
      });
      const problems = [];
      transfer.verifyImportedPlanetaryInteraction(rollbackTarget, piBundle, rollbackPlan, problems);
      if (problems.length) throw new Error(`rollback verifier: ${problems.join(", ")}`);
    })(),
    /rollback verifier/,
    "PI verification failure must abort transaction",
  );
  assert(JSON.stringify(rollbackTarget.data) === JSON.stringify(rollbackBefore),
    "transaction rollback must preserve exact target state");

  console.log(`PI_VERIFIER_PASS ${passed}`);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  if (originalMultiplierEnv === undefined) {
    delete process.env.EVEJS_PLANET_SCHEMATIC_OUTPUT_MULTIPLIER;
  } else {
    process.env.EVEJS_PLANET_SCHEMATIC_OUTPUT_MULTIPLIER = originalMultiplierEnv;
  }
}
