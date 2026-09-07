"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");
const core = require("./core");

const SUPPORT_FILES = Object.freeze(["report.md", "diagnostics.json"]);
const PLATFORMS = new Set(["win32", "darwin", "linux", "aix", "freebsd", "openbsd", "sunos", "android"]);
const ARCHITECTURES = new Set(["x64", "arm64", "ia32", "arm", "ppc64", "s390x", "riscv64", "loong64"]);

function runtimeVersion(value) {
  const match = String(value || "").match(/^v?(\d+(?:\.\d+){1,3})(?:[-+][0-9A-Za-z.-]+)?$/);
  return match ? match[1] : "unknown";
}

function supportDiagnostics(state, runtime = {}, options = {}) {
  const report = core.reportData(state, options);
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    application: {
      version: report.appVersion,
      platform: PLATFORMS.has(runtime.platform) ? runtime.platform : "unknown",
      arch: ARCHITECTURES.has(runtime.arch) ? runtime.arch : "unknown",
      electron: runtimeVersion(runtime.electron),
      node: runtimeVersion(runtime.node),
    },
    engine: { revision: report.engineRevision, sha256: report.engineSha256 },
    source: report.source,
    target: report.target,
    counts: report.counts,
    portraits: report.portraits,
    findings: report.findings,
    stages: report.stages,
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function zipBuffer(entries, date = new Date(), allowedNames = SUPPORT_FILES) {
  const locals = [];
  const central = [];
  let offset = 0;
  const stamp = dosTimestamp(date);
  for (const entry of entries) {
    if (!allowedNames.includes(entry.name)) throw new Error(`ZIP entry is not allowlisted: ${entry.name}`);
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), "utf8");
    const compressed = zlib.deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(stamp.time, 10);
    localHeader.writeUInt16LE(stamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    locals.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(stamp.time, 12);
    centralHeader.writeUInt16LE(stamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...central, end]);
}

function createSupportZip(file, state, runtime = {}, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const modelOptions = { generatedAt };
  const entries = [
    { name: "report.md", content: `${core.reportMarkdown(state, modelOptions)}\n` },
    { name: "diagnostics.json", content: `${JSON.stringify(supportDiagnostics(state, runtime, modelOptions), null, 2)}\n` },
  ];
  const archive = zipBuffer(entries, new Date(generatedAt));
  fs.writeFileSync(file, archive, { flag: "w" });
  return { file, entries: SUPPORT_FILES.slice(), bytes: archive.length };
}

module.exports = { SUPPORT_FILES, supportDiagnostics, zipBuffer, createSupportZip };
