"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");
const policy = require("./source-archive-policy");

function zipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const expectedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = buffer.subarray(contentStart, contentStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(compressed) : method === 0 ? compressed : null;
    if (!content || content.length !== expectedSize) throw new Error(`Unreadable ZIP entry: ${name}`);
    entries.push({ name, content });
    offset = contentStart + compressedSize;
  }
  return entries;
}

function auditSourceZip(file) {
  const entries = zipEntries(fs.readFileSync(file));
  if (!entries.length) throw new Error("Source ZIP contains no readable entries.");
  const names = entries.map((entry) => policy.normalizeArchivePath(entry.name));
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`Source ZIP contains duplicate entries: ${duplicates.join(", ")}`);
  const rejected = names.filter((name) => !policy.isAllowed(name));
  if (rejected.length) throw new Error(`Source ZIP audit rejected: ${rejected.join(", ")}`);
  return { entries: names.length, names };
}

if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/audit-source-zip.js <source.zip>");
  const result = auditSourceZip(process.argv[2]);
  process.stdout.write(`SOURCE_ZIP_AUDIT_PASS ${result.entries}\n`);
}

module.exports = { zipEntries, auditSourceZip };
