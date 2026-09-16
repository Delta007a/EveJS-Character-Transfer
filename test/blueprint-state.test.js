"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../src/core");

test("v0.2.0 preserves accepted blueprint transfer counts", () => {
  const rows = Array.from({ length: 83 }, (_, itemID) => ({ itemID }));
  const summary = core.summarizeBundle({
    rows: { industryBlueprintState: rows },
    blueprintSummary: { researchedBlueprints: 47, blueprintCopies: 16, blockedBlueprintStateRows: 0 },
    deferred: { blueprintStateRows: [] },
  });
  assert.equal(summary.blueprintState, 83);
  assert.equal(summary.researchedBlueprints, 47);
  assert.equal(summary.blueprintCopies, 16);
  assert.equal(summary.deferredBlueprintState, 0);
  assert.equal(summary.blockedBlueprintState, 0);
});

test("blueprint engine findings receive human-readable blocker guidance", () => {
  for (const code of Object.keys(core.REMEDIATIONS).filter((value) => value.startsWith("BLUEPRINT_"))) {
    const [card] = core.warningCard({ code, severity: "blocking", itemID: 9988400004985, typeID: 1010 });
    assert.equal(card.class, "BLOCKER");
    assert.notEqual(card.title, code);
    assert.ok(card.why.length > 20);
    assert.ok(card.fix.length > 0);
    const enriched = core.enrichCard(card, { types: { "1010": "Known Blueprint" } });
    assert.deepEqual(enriched.display[0], ["Blueprint", "Known Blueprint (1010)"]);
    assert.equal(enriched.affected.itemID, 9988400004985);
  }
});

test("GUI advertises accepted engine r1.6 and renders blueprint evidence", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");
  assert.match(html, /Accepted engine r1\.6/);
  assert.match(html, /0\.2\.0/);
  assert.match(renderer, /Blueprint state/);
  assert.match(renderer, /Researched/);
  assert.match(renderer, /Copies/);
});
