"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { zipEntries } = require("./audit-source-zip");
const { binaryLayout } = require("./create-binary-zip");

function auditBinaryZip(file, version) {
  version = version || require("../package.json").version;
  const entries = zipEntries(fs.readFileSync(file));
  const layout = binaryLayout(version);
  const expected = [layout.exe, layout.readme];
  const names = entries.map((entry) => entry.name.replaceAll("\\", "/"));
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Binary ZIP layout mismatch. Expected exactly: ${expected.join(", ")}. Got: ${names.join(", ")}.`);
  if (!entries[0].content.length) throw new Error("Binary ZIP executable is empty.");
  const readme = entries[1].content.toString("utf8");
  for (const required of ["Extract the whole", "somewhere writable", ".\\data next to the EXE", "backups may be large", "remain until you explicitly remove", "protected or unwritable directory"]) {
    if (!readme.toLowerCase().includes(required.toLowerCase())) throw new Error(`Binary ZIP README is missing required guidance: ${required}`);
  }
  return { entries: names.length, names, executableBytes: entries[0].content.length };
}

if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/audit-binary-zip.js <binary.zip> [version]");
  const result = auditBinaryZip(path.resolve(process.argv[2]), process.argv[3]);
  process.stdout.write(`BINARY_ZIP_AUDIT_PASS ${result.entries} ${result.executableBytes}\n`);
}

module.exports = { auditBinaryZip };
