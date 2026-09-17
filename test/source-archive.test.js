"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const policy = require("../scripts/source-archive-policy");
const { auditSourceZip } = require("../scripts/audit-source-zip");
const { zipBuffer } = require("../src/support-report");

test("source archive policy is explicit and rejects runtime/private artifacts", () => {
  for (const allowed of [".gitattributes", "package.json", ".github/workflows/ci.yml", "src/core.js", "test/core.test.js", "engine/accepted-r1.6/private-identity-transfer.js", "engine/r1.7/private-identity-transfer.js", "engine/r1.7/verify-private-identity-transfer-achievements.js"]) assert.equal(policy.isAllowed(allowed), true, allowed);
  for (const forbidden of ["runs/x/private-state-1.json", "private-state-a.json", "x/gamestore.sqlite", "x/gamestore.sqlite-wal", "gameStore/data/x", "node_modules/a.js", "dist/app.exe", "backups/target/db", "portable-node/node.exe", "images/Character/1.jpg", "EveJS-0.12.7/server.js", "../secret.txt", "src/secret.sqlite"]) assert.equal(policy.isAllowed(forbidden), false, forbidden);
});

test("source ZIP auditor rejects a forbidden archive entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-source-audit-"));
  const file = path.join(root, "hostile.zip");
  try {
    fs.writeFileSync(file, zipBuffer([{ name: "runs/private-state-1.json", content: "secret" }], new Date("2026-01-01T00:00:00Z"), ["runs/private-state-1.json"]));
    assert.throws(() => auditSourceZip(file), /audit rejected/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("release version gate requires exact package tag", () => {
  const cp = require("node:child_process");
  const root = path.join(__dirname, "..");
  assert.match(cp.execFileSync(process.execPath, ["scripts/verify-release-version.js", `v${require("../package.json").version}`], { cwd: root, encoding: "utf8" }), /RELEASE_VERSION_OK/);
  assert.throws(() => cp.execFileSync(process.execPath, ["scripts/verify-release-version.js", "v9.9.9"], { cwd: root, stdio: "pipe" }));
});
