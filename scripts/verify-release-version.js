"use strict";

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(String(tag || ""))) throw new Error("Release tag must use vMAJOR.MINOR.PATCH format.");
const version = require("../package.json").version;
if (tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match package version ${version}.`);
process.stdout.write(`RELEASE_VERSION_OK ${tag}\n`);
