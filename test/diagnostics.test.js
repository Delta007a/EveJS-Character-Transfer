"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { externalRecords, deepFind } = require("../src/diagnostics");

test("external records preserve raw IDs", () => {
  const bundle = { warnings: [{ code: "EXTERNAL_ITEM_LOCATIONS", severity: "blocking", items: [{ itemID: 10, typeID: 20, ownerID: 30, locationID: 2003 }] }] };
  assert.deepEqual(externalRecords(bundle).map((x) => [x.itemID,x.typeID,x.ownerID,x.locationID]), [[10,20,30,2003]]);
});

test("deep process record lookup is evidence based", () => {
  assert.equal(deepFind({ records: { a: { contractID: 7, status: 0 } } }, (x) => x.contractID === 7).length, 1);
});
