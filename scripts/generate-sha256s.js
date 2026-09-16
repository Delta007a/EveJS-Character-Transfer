"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const outIndex = process.argv.indexOf("--out");
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error("Usage: node scripts/generate-sha256s.js --out <file> <artifact...>");
const output = process.argv[outIndex + 1];
const files = process.argv.slice(outIndex + 2);
if (!files.length) throw new Error("At least one release artifact is required.");
const lines = files.map((file) => {
  if (!fs.statSync(file).isFile()) throw new Error(`Release artifact is not a file: ${file}`);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return `${hash}  ${path.basename(file)}`;
});
fs.writeFileSync(output, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`SHA256SUMS_OK ${files.length} ${output}\n`);
