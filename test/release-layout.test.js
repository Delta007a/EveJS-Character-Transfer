"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipBuffer } = require("../src/support-report");
const { createBinaryZip, binaryLayout } = require("../scripts/create-binary-zip");
const { auditBinaryZip } = require("../scripts/audit-binary-zip");
const sourcePolicy = require("../scripts/source-archive-policy");

test("release binary ZIP has the exact portable folder layout and required guidance", () => {
  const root = path.join(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eve-binary-zip-"));
  try {
    const exe = path.join(temp, "EveJS-Character-Transfer.exe");
    const output = path.join(temp, "EveJS-Character-Transfer-v0.2.0.zip");
    fs.writeFileSync(exe, "fake-portable-executable");
    const created = createBinaryZip({ root, version: "0.2.0", executable: exe, output });
    assert.deepEqual(created.names, Object.values(binaryLayout("0.2.0")).slice(1));
    const audit = auditBinaryZip(output, "0.2.0");
    assert.deepEqual(audit.names, ["EveJS-Character-Transfer-v0.2.0/EveJS-Character-Transfer.exe", "EveJS-Character-Transfer-v0.2.0/README.txt"]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("binary ZIP audit rejects extra runtime/private artifacts", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eve-binary-bad-"));
  try {
    const layout = binaryLayout("0.2.0");
    const names = [layout.exe, layout.readme, `${layout.folder}/data/backups/private.sqlite`];
    const file = path.join(temp, "bad.zip");
    fs.writeFileSync(file, zipBuffer(names.map((name) => ({ name, content: name === layout.readme ? "Extract the whole somewhere writable .\\data next to the EXE backups may be large remain until you explicitly remove protected or unwritable directory" : "x" })), new Date("2026-01-01T00:00:00Z"), names));
    assert.throws(() => auditBinaryZip(file, "0.2.0"), /layout mismatch/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("source policy includes release instructions but excludes operational data", () => {
  assert.equal(sourcePolicy.isAllowed("release/README.txt"), true);
  for (const forbidden of ["data/history.json", "data/logs/transfer-2026-09-08.jsonl", "data/runs/run/private.json", "data/backups/backup/gamestore.sqlite"]) assert.equal(sourcePolicy.isAllowed(forbidden), false, forbidden);
});

test("CI and Release publish/hash the binary ZIP rather than the naked EXE", () => {
  const root = path.join(__dirname, "..");
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(ci, /path: dist\/EveJS-Character-Transfer-v0\.2\.0\.zip/);
  assert.match(release, /generate-sha256s\.js[^\n]*EveJS-Character-Transfer-v\$version\.zip/);
  assert.match(release, /gh release create[^\n]*EveJS-Character-Transfer-v\$version\.zip/);
  assert.doesNotMatch(release, /generate-sha256s\.js[^\n]*dist\/EveJS-Character-Transfer\.exe/);
  assert.doesNotMatch(release, /gh release create[^\n]*dist\/EveJS-Character-Transfer\.exe/);
});
