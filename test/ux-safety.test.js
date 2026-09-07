"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("GUI identifies the exact field-tested migration baseline", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /Field-tested: EveJS 0\.12\.7 → 0\.12\.7\.1/);
});

test("clipboard summary is generated from the privacy-safe report model in main", () => {
  const root = path.join(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
  assert.match(main, /copy-sanitized-summary[\s\S]*clipboard\.writeText\(core\.reportMarkdown/);
  assert.match(preload, /copySanitizedSummary: \(\) => ipcRenderer\.invoke\("copy-sanitized-summary"\)/);
  assert.doesNotMatch(main, /copy-sanitized-summary[\s\S]{0,200}(?:sourceRoot|targetRoot|bundlePath)/);
});
