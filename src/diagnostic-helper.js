"use strict";
const fs = require("node:fs");
const diagnostics = require("./diagnostics");
const [sourceRoot, bundlePath] = process.argv.slice(2);
if (!sourceRoot || !bundlePath) throw new Error("diagnostic-helper requires source root and bundle path");
const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
process.stdout.write(JSON.stringify(diagnostics.diagnose(sourceRoot, bundle)));
