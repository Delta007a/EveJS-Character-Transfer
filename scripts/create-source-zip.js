"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { zipBuffer } = require("../src/support-report");
const policy = require("./source-archive-policy");

function option(name) { const index = process.argv.indexOf(`--${name}`); return index < 0 ? null : process.argv[index + 1]; }
function trackedFiles(root) {
  return cp.execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map(policy.normalizeArchivePath).sort();
}

function createSourceArchive({ root = path.resolve(__dirname, ".."), version, output } = {}) {
  const packageVersion = require(path.join(root, "package.json")).version;
  if (version && version !== packageVersion) throw new Error(`Requested source ZIP version ${version} does not match package ${packageVersion}.`);
  const files = trackedFiles(root);
  const rejected = files.filter((file) => !policy.isAllowed(file));
  if (rejected.length) throw new Error(`Tracked file(s) are outside the source archive allowlist: ${rejected.join(", ")}`);
  if (!files.length) throw new Error("Source archive allowlist selected no files.");
  const destination = path.resolve(output || path.join(root, "dist", `EveJS-Character-Transfer-Source-v${packageVersion}.zip`));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const entries = files.map((name) => ({ name, content: fs.readFileSync(path.join(root, ...name.split("/"))) }));
  fs.writeFileSync(destination, zipBuffer(entries, new Date("2026-01-01T00:00:00.000Z"), files));
  return { destination, files };
}

if (require.main === module) {
  const result = createSourceArchive({ version: option("version"), output: option("out") });
  process.stdout.write(`SOURCE_ZIP_OK ${result.files.length} ${result.destination}\n`);
}

module.exports = { trackedFiles, createSourceArchive };
