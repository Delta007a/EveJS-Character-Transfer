#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const toolPath = path.join(__dirname, "private-identity-transfer.js");
const transfer = require(toolPath);

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
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

class FakeDatabase {
  constructor(data = {}) {
    this.data = clone(data);
    this.mutations = [];
  }
  rows(table) {
    return Array.isArray(this.data[table]) ? this.data[table] : [];
  }
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
        all() {
          return db.rows(table).map((row) => ({ key: String(row.key), json: JSON.stringify(row.value) }));
        },
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
}

function characterState(characterID, totalScore) {
  return {
    version: 1,
    characterID,
    achievementsById: {
      "achievement-a": {
        progressValue: totalScore,
        checklistValuesByType: { ship: ["587"] },
        hiddenUniqueValuesByType: { system: ["30000142"] },
        reachedMilestonesById: {
          "milestone-a": { reachedAtMs: 1000, categoryPointsAwarded: totalScore },
        },
        completedAtMs: 1000,
        updatedAtMs: 1000,
      },
    },
    categoryScoresById: { "category-a": totalScore },
    totalScore,
    unclaimedSourcesByKey: {
      "achievement:achievement-a:milestone-a": {
        sourceKind: "achievement",
        sourceID: "achievement-a",
        milestoneID: "milestone-a",
        rewardIds: ["reward-a"],
        createdAtMs: 1000,
      },
    },
    claimedRewardKeys: {},
    ownedTitleIds: ["title-a"],
    equippedTitleId: "title-a",
    legacyTracker: {
      completedByAchievementId: { "1": "1000" },
      eventCountsByName: { warp: 2 },
      hasEverWarped: true,
    },
    createdAtMs: 900,
    updatedAtMs: 1000,
  };
}

function achievementRows(characters, version = 1) {
  return [
    { key: "version", value: version },
    { key: "characters", value: characters },
  ];
}

function makeNativeRuntime(root, definitionsVersion = "1.0.3", titlesVersion = "1.0.0") {
  const base = path.join(root, "server", "src", "services", "achievement");
  fs.mkdirSync(path.join(base, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(base, "achievementState.js"),
    'const TABLE_NAME = "achievements";\nconst ROOT_VERSION = 1;\n',
  );
  writeJson(path.join(base, "data", "definitions.json"), { version: { raw: definitionsVersion } });
  writeJson(path.join(base, "data", "titles.json"), { version: { raw: titlesVersion } });
}

function bundle(achievements, version = 6) {
  const value = {
    tool: "EveJS-Private-Identity-Transfer",
    toolVersion: "r1.7",
    bundleVersion: version,
    selected: { characterIDs: [140000011], accountIDs: [], corporationIDs: [], allianceIDs: [], itemIDs: [] },
    rows: {},
  };
  if (version === 6) value.achievements = achievements;
  return value;
}

const fixtureRoot = fs.mkdtempSync(path.join(__dirname, ".tmp-achievements-"));
try {
  const nativeRoot = path.join(fixtureRoot, "native");
  makeNativeRuntime(nativeRoot);
  const selectedState = characterState(140000011, 25);
  const unrelatedSourceState = characterState(140000099, 99);

  // A: a 0.12.7.1-style source has no native table and exports explicit absence.
  const oldSource = new FakeDatabase({});
  assert(transfer.collectAchievementTransfer(oldSource, path.join(fixtureRoot, "old"), new Set([140000011])) === null,
    "source without achievements must remain absent");

  // B/C: exact selected subtree only; unrelated source ownership never enters the bundle.
  const source = new FakeDatabase({ achievements: achievementRows({
    "140000011": selectedState,
    "140000099": unrelatedSourceState,
  }) });
  const exported = transfer.collectAchievementTransfer(source, nativeRoot, new Set([140000011]));
  assert(JSON.stringify(exported.characters["140000011"]) === JSON.stringify(selectedState),
    "selected achievement subtree must export exactly");
  assert(!Object.prototype.hasOwnProperty.call(exported.characters, "140000099"),
    "unselected source achievement subtree must not export");
  assert(exported.definitionsVersion === "1.0.3" && exported.titlesVersion === "1.0.0",
    "bundle must carry authoritative catalog versions");

  // D/E: selected target subtree is replaced; unrelated target subtree is byte-logically preserved.
  const unrelatedTargetState = characterState(140000077, 77);
  const target = new FakeDatabase({ achievements: achievementRows({
    "140000011": characterState(140000011, 1),
    "140000077": unrelatedTargetState,
  }) });
  const achievementBundle = bundle(exported);
  transfer.validateBundle(achievementBundle);
  const unrelatedBefore = transfer.snapshotUnrelatedAchievementState(target, achievementBundle);
  assert(transfer.importAchievements(target, achievementBundle) === 1, "one selected subtree must import");
  const importedRoot = transfer.readAchievementRoot(target, "test target");
  assert(JSON.stringify(importedRoot.characters["140000011"]) === JSON.stringify(selectedState),
    "selected target subtree must be replaced exactly");
  assert(JSON.stringify(importedRoot.characters["140000077"]) === JSON.stringify(unrelatedTargetState),
    "unrelated target subtree must be preserved exactly");
  const problems = [];
  transfer.verifyImportedAchievements(target, achievementBundle, unrelatedBefore, problems);
  assert(problems.length === 0, "post-import achievement verifier must pass exact replacement/preservation");

  // F: state cannot enter a target lacking the native subsystem.
  assertThrows(
    () => transfer.readAchievementCompatibility(path.join(fixtureRoot, "no-native-support"), "target"),
    /lacks native achievement/,
    "target without native achievements must fail closed",
  );

  // G: definitions or titles drift is a hard compatibility failure.
  const badCatalogRoot = path.join(fixtureRoot, "bad-catalog");
  makeNativeRuntime(badCatalogRoot, "1.0.4", "1.0.0");
  assertThrows(
    () => transfer.readAchievementCompatibility(badCatalogRoot, "target"),
    /catalog versions are incompatible/,
    "incompatible achievement catalogs must fail closed",
  );
  const badCatalogBundle = clone(achievementBundle);
  badCatalogBundle.achievements.titlesVersion = "1.0.1";
  assertThrows(() => transfer.validateBundle(badCatalogBundle), /catalog versions are incompatible/,
    "tampered bundle catalog version must fail closed");

  // H: malformed root keys, schema version, and owner identity all fail closed.
  assertThrows(
    () => transfer.readAchievementRoot(new FakeDatabase({ achievements: [{ key: "characters", value: {} }] }), "source"),
    /invalid physical keys/,
    "partial achievement root must fail closed",
  );
  assertThrows(
    () => transfer.readAchievementRoot(new FakeDatabase({ achievements: achievementRows({}, 2) }), "source"),
    /schema\/version is incompatible/,
    "unsupported achievement root version must fail closed",
  );
  const wrongOwner = characterState(140000012, 2);
  assertThrows(
    () => transfer.readAchievementRoot(new FakeDatabase({ achievements: achievementRows({ "140000011": wrongOwner }) }), "source"),
    /ownership mismatch/,
    "achievement character ownership mismatch must fail closed",
  );
  const malformedRewards = characterState(140000011, 2);
  malformedRewards.unclaimedSourcesByKey.bad = { rewardIds: "not-an-array" };
  assertThrows(
    () => transfer.readAchievementRoot(new FakeDatabase({ achievements: achievementRows({ "140000011": malformedRewards }) }), "source"),
    /malformed pending reward/,
    "malformed achievement reward schema must fail closed",
  );

  // I: import consists only of persistence writes; reward state is copied but never fulfilled.
  assert(target.mutations.every((entry) => entry.startsWith("create:achievements") || entry.startsWith("put:achievements:")),
    "achievement import must only mutate the achievements table");
  assert(importedRoot.characters["140000011"].unclaimedSourcesByKey["achievement:achievement-a:milestone-a"].rewardIds[0] === "reward-a",
    "pending rewards must remain pending persisted state");
  const engineSource = fs.readFileSync(toolPath, "utf8");
  assert(!engineSource.includes("claimRewards(") && !engineSource.includes("grantFulfillmentToCharacter"),
    "migration engine must not invoke achievement reward fulfillment");

  // J: accepted legacy bundle behavior remains valid and cannot smuggle native state.
  const legacy = bundle(undefined, 5);
  transfer.validateBundle(legacy);
  const unchanged = clone(target.data.achievements);
  assert(transfer.importAchievements(target, legacy) === 0, "legacy/no-achievement bundle must perform no achievement write");
  assert(JSON.stringify(target.data.achievements) === JSON.stringify(unchanged),
    "legacy/no-achievement import must preserve target achievement state");
  const smuggled = clone(legacy);
  smuggled.achievements = exported;
  assertThrows(() => transfer.validateBundle(smuggled), /legacy bundle must not contain/,
    "legacy bundle must not smuggle native achievement state");

  // A second native target without a pre-existing table is initialized only when state exists.
  const emptyNativeTarget = new FakeDatabase({});
  assert(transfer.importAchievements(emptyNativeTarget, achievementBundle) === 1,
    "compatible native target may initialize its absent achievements table");
  assert(transfer.readAchievementRoot(emptyNativeTarget, "new target").characters["140000011"].totalScore === 25,
    "initialized target must contain exact selected state");

  console.log(`ACHIEVEMENT_VERIFIER_PASS ${passed}`);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
