#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const tool = path.join(__dirname, "private-identity-transfer.js");
let passed = 0;
function assert(condition, message) { if (!condition) throw new Error(message); passed += 1; }
function sha(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-private-r16-portraits-"));
try {
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");
  const srcDir = path.join(source, "_local", "gameStore", "images", "Character");
  const dstDir = path.join(target, "_local", "gameStore", "images", "Character");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(dstDir, { recursive: true });

  fs.writeFileSync(path.join(srcDir, "140000011_128.jpg"), "CEO-CORRECT-128");
  fs.writeFileSync(path.join(srcDir, "140000011_512.jpg"), "CEO-CORRECT-512");
  fs.writeFileSync(path.join(srcDir, "140000012_128.jpg"), "OTHER-CORRECT");
  fs.writeFileSync(path.join(srcDir, "140000099_128.jpg"), "UNSELECTED");
  fs.writeFileSync(path.join(dstDir, "140000011_128.jpg"), "STALE-TARGET");

  const bundle = {
    tool: "EveJS-Private-Identity-Transfer",
    toolVersion: "r1.6",
    bundleVersion: 5,
    source: { version: "0.12.7" },
    policy: {},
    selected: {
      accountIDs: [1], characterIDs: [140000011, 140000012, 140000013], corporationIDs: [], allianceIDs: [], itemIDs: [],
    },
    corporations: [], alliances: [], rows: { accounts: [], characters: [], items: [] }, deferred: { playerStructures: [], corporationOffices: [], items: [] }, warnings: [],
  };
  const bundlePath = path.join(dir, "bundle.json");
  fs.writeFileSync(bundlePath, JSON.stringify(bundle));

  const dry = cp.spawnSync(process.execPath, [tool, "portraits", "--source-root", source, "--target-root", target, "--in", bundlePath], { encoding: "utf8" });
  if (dry.status !== 0) throw new Error(`portrait dry run failed\n${dry.stdout}\n${dry.stderr}`);
  assert(dry.stdout.includes("PORTRAIT_DRY_RUN_OK"), "portrait dry run must report no writes");
  assert(dry.stdout.includes("Characters with portrait media: 2"), "portrait dry run must count characters with media");
  assert(dry.stdout.includes("Characters without portrait media: 1"), "portrait dry run must count missing portrait sets");
  assert(dry.stdout.includes("Portrait files selected: 3"), "portrait dry run must select only selected-character files");
  assert(fs.readFileSync(path.join(dstDir, "140000011_128.jpg"), "utf8") === "STALE-TARGET", "dry run must not overwrite target portrait");

  const apply = cp.spawnSync(process.execPath, [tool, "portraits", "--source-root", source, "--target-root", target, "--in", bundlePath, "--apply"], { encoding: "utf8" });
  if (apply.status !== 0) throw new Error(`portrait apply failed\n${apply.stdout}\n${apply.stderr}`);
  assert(apply.stdout.includes("PORTRAITS_OK"), "portrait apply must succeed");
  assert(apply.stdout.includes("Copied portrait files: 3"), "portrait apply must report copied file count");
  assert(apply.stdout.includes("Overwritten target files: 1"), "portrait apply must report overwritten file count");
  assert(sha(path.join(dstDir, "140000011_128.jpg")) === sha(path.join(srcDir, "140000011_128.jpg")), "overwritten target portrait must hash-match source");
  assert(sha(path.join(dstDir, "140000011_512.jpg")) === sha(path.join(srcDir, "140000011_512.jpg")), "new target portrait must hash-match source");
  assert(sha(path.join(dstDir, "140000012_128.jpg")) === sha(path.join(srcDir, "140000012_128.jpg")), "second selected character portrait must copy");
  assert(!fs.existsSync(path.join(dstDir, "140000099_128.jpg")), "unselected character portrait must not copy");

  const backupsRoot = path.join(target, "_local", "migration-backups");
  const backupDirs = fs.readdirSync(backupsRoot).filter((name) => name.startsWith("portraits-before-private-transfer-"));
  assert(backupDirs.length === 1, "portrait apply must create one backup directory");
  const backupFile = path.join(backupsRoot, backupDirs[0], "140000011_128.jpg");
  assert(fs.existsSync(backupFile) && fs.readFileSync(backupFile, "utf8") === "STALE-TARGET", "portrait backup must preserve overwritten target image");

  console.log(`PORTRAIT_VERIFIER_PASS ${passed}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
