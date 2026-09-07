"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const core = require("../src/core");
const support = require("../src/support-report");

function readLocalEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = buffer.subarray(contentStart, contentStart + compressedSize);
    entries.set(name, (method === 8 ? zlib.inflateRawSync(compressed) : compressed).toString("utf8"));
    offset = contentStart + compressedSize;
  }
  return entries;
}

function hostileState() {
  return {
    appVersion: "0.1.3",
    engineSha256: core.ACCEPTED_ENGINE_SHA256,
    sourceRoot: "C:\\Users\\Delta\\Source-Private",
    targetRoot: "D:\\Secret\\Target-Private",
    bundlePath: "C:\\Users\\Delta\\private-state-123.json",
    bundle: { credentials: "super-secret-token", rows: [{ characterName: "Hidden Pilot", itemID: 88776655 }] },
    source: { version: "0.12.7", versionSource: "root-package", versionReliable: true },
    target: { version: "0.12.7.1", versionSource: "root-package", versionReliable: true },
    summary: { accounts: 1, characters: 1, items: 2, blueprintState: 1, researchedBlueprints: 1, blueprintCopies: 0, mail: 3, walletAuthority: 2 },
    portraits: { charactersWithMedia: 1, charactersWithoutMedia: 0, files: 6, ok: true },
    severity: { blockers: 1, warnings: 0, deferred: 0 },
    cards: [{ class: "BLOCKER", code: "ACTIVE_INDUSTRY_JOB", affected: { characterName: "Hidden Pilot", itemID: 88776655 }, technicalDetails: "super-secret-token" }],
    deferred: [], sourceState: "SOURCE_ANALYZED", targetPrepared: false, targetVerified: false, reviewReady: false, mechanical: {}, finalStatus: "ANALYZED",
  };
}

test("support ZIP has exactly the two explicit allowlisted entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-support-hostile-"));
  const output = path.join(root, "support.zip");
  try {
    fs.mkdirSync(path.join(root, "runs", "nested"), { recursive: true });
    fs.mkdirSync(path.join(root, "gameStore", "images", "Character"), { recursive: true });
    for (const name of ["private-state-123.json", "gamestore.sqlite", "gamestore.sqlite-wal", "backup.zip", "passwords.txt"]) fs.writeFileSync(path.join(root, name), `HOSTILE-${name}-super-secret-token`);
    fs.writeFileSync(path.join(root, "runs", "nested", "migration-bundle.json"), "Hidden Pilot 88776655");
    fs.writeFileSync(path.join(root, "gameStore", "images", "Character", "portrait.jpg"), "portrait-private-bytes");
    const result = support.createSupportZip(output, hostileState(), { platform: "win32", arch: "x64", electron: "38.7.2", node: "22.23.2" }, { generatedAt: "2026-09-07T12:00:00.000Z" });
    assert.deepEqual(result.entries, ["report.md", "diagnostics.json"]);
    const entries = readLocalEntries(fs.readFileSync(output));
    assert.deepEqual([...entries.keys()], ["report.md", "diagnostics.json"]);
    const content = [...entries.values()].join("\n");
    for (const forbidden of ["Delta", "Source-Private", "Target-Private", "private-state-123", "gamestore.sqlite", "migration-bundle", "Hidden Pilot", "88776655", "super-secret-token", "portrait-private-bytes", "passwords.txt", "backup.zip"]) assert.doesNotMatch(content, new RegExp(forbidden, "i"));
    assert.match(entries.get("report.md"), /ACTIVE_INDUSTRY_JOB/);
    const diagnostics = JSON.parse(entries.get("diagnostics.json"));
    assert.deepEqual(diagnostics.application, { version: "0.1.3", platform: "win32", arch: "x64", electron: "38.7.2", node: "22.23.2" });
    assert.equal(diagnostics.counts.characters, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("support diagnostic runtime metadata rejects non-version and non-platform input", () => {
  const data = support.supportDiagnostics(hostileState(), { platform: "C:\\Users\\Delta", arch: "Hidden Pilot", electron: "38.0.0 super-secret-token", node: "v22.23.2" }, { generatedAt: "2026-09-07T12:00:00.000Z" });
  assert.deepEqual(data.application, { version: "0.1.3", platform: "unknown", arch: "unknown", electron: "unknown", node: "22.23.2" });
  assert.doesNotMatch(JSON.stringify(data), /Delta|Hidden Pilot|super-secret-token|88776655/);
});

test("ZIP writer rejects every non-allowlisted filename", () => {
  assert.throws(() => support.zipBuffer([{ name: "runs/private-state.json", content: "secret" }]), /not allowlisted/);
});
