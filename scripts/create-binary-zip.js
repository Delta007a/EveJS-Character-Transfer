"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { zipBuffer } = require("../src/support-report");

function option(name) { const index = process.argv.indexOf(`--${name}`); return index < 0 ? null : process.argv[index + 1]; }

function binaryLayout(version) {
  const folder = `EveJS-Character-Transfer-v${version}`;
  return { folder, exe: `${folder}/EveJS-Character-Transfer.exe`, readme: `${folder}/README.txt` };
}

function createBinaryZip({ root = path.resolve(__dirname, ".."), version, executable, readme, output } = {}) {
  const packageVersion = require(path.join(root, "package.json")).version;
  if (version && version !== packageVersion) throw new Error(`Requested binary ZIP version ${version} does not match package ${packageVersion}.`);
  const releaseVersion = version || packageVersion;
  const layout = binaryLayout(releaseVersion);
  const exeFile = path.resolve(executable || path.join(root, "dist", "EveJS-Character-Transfer.exe"));
  const readmeFile = path.resolve(readme || path.join(root, "release", "README.txt"));
  if (!fs.statSync(exeFile).isFile() || fs.statSync(exeFile).size === 0) throw new Error("Portable executable is missing or empty.");
  if (!fs.statSync(readmeFile).isFile() || fs.statSync(readmeFile).size === 0) throw new Error("Release README.txt is missing or empty.");
  const destination = path.resolve(output || path.join(root, "dist", `EveJS-Character-Transfer-v${releaseVersion}.zip`));
  const names = [layout.exe, layout.readme];
  const entries = [{ name: layout.exe, content: fs.readFileSync(exeFile) }, { name: layout.readme, content: fs.readFileSync(readmeFile) }];
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, zipBuffer(entries, new Date("2026-01-01T00:00:00.000Z"), names));
  return { destination, names };
}

if (require.main === module) {
  const result = createBinaryZip({ version: option("version"), executable: option("exe"), readme: option("readme"), output: option("out") });
  process.stdout.write(`BINARY_ZIP_OK ${result.names.length} ${result.destination}\n`);
}

module.exports = { binaryLayout, createBinaryZip };
