#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const tool = path.join(__dirname, "private-identity-transfer.js");
let passed = 0;
function assert(condition, message) { if (!condition) throw new Error(message); passed += 1; }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

function makeRuntime(root) {
  fs.mkdirSync(path.join(root, "server", "node_modules", "better-sqlite3"), { recursive: true });
  fs.mkdirSync(path.join(root, "_local", "gameStore"), { recursive: true });
  fs.writeFileSync(path.join(root, "_local", "gameStore", "gamestore.sqlite"), "fake");
  writeJson(path.join(root, "server", "package.json"), { version: "0.12.7-wallet-fixture" });
  const US = String.fromCharCode(31);
  const data = {
    accounts: [{ key: "user", value: { id: 1, password: "x" } }],
    characters: [{ key: "140000011", value: { accountId: 1, characterName: "CEO", corporationID: 98000000, allianceID: 0, stationID: 6001, homeStationID: 6001, cloneStationID: 6001, structureID: null, solarSystemID: 3001, shipID: 2000000100, shipTypeID: 100, shipName: "Ship", balance: 100000 } }],
    corporations: [{ key: "records", value: { "98000000": { corporationID: 98000000, corporationName: "Corp", stationID: 6001, allianceID: 0 } } }],
    corporationRuntime: [{ key: `corporations${US}98000000`, value: { corporationID: 98000000, offices: {}, officeRentalSettlements: [] } }],
    structures: [{ key: "structures", value: [] }],
    items: [{ key: "2000000100", value: { itemID: 2000000100, typeID: 100, ownerID: 140000011, locationID: 6001, flagID: 4 } }],
    walletAuthorityState: [
      { key: "character:140000011", value: { characterID: 140000011, balance: 35622900, aurBalance: 0, plexBalance: 2222, balanceChange: 22500, walletJournal: [{ transactionID: 1, amount: 22500, balance: 35622900, description: "Bounty" }] } },
      { key: "character:140000099", value: { characterID: 140000099, balance: 999, aurBalance: 0, plexBalance: 0, balanceChange: 0, walletJournal: [] } },
    ],
  };
  writeJson(path.join(root, "_local", "gameStore", "gamestore.sqlite.json"), data);
  fs.writeFileSync(path.join(root, "server", "node_modules", "better-sqlite3", "index.js"), `"use strict";\nconst fs=require("fs");\nclass FakeDatabase {\n constructor(file){this.data=JSON.parse(fs.readFileSync(file+".json","utf8"));}\n _rows(t){return Array.isArray(this.data[t])?this.data[t]:[];}\n prepare(sql){const db=this;if(sql.includes("sqlite_master")) return {get(table){return Object.prototype.hasOwnProperty.call(db.data,String(table))?{present:1}:undefined;},all(){return[];}}; const m=sql.match(/FROM\\s+\"([^\"]+)\"/i); if(!m) throw new Error("unsupported "+sql); const table=m[1]; const where=/WHERE\\s+key=\\?/i.test(sql); return {get(key){if(!where)return undefined;const r=db._rows(table).find(x=>String(x.key)===String(key));return r?{key:String(r.key),json:JSON.stringify(r.value)}:undefined;},all(){return db._rows(table).map(r=>({key:String(r.key),json:JSON.stringify(r.value)}));},run(){throw new Error("writes unsupported");}};}\n pragma(name){return String(name).toLowerCase()==="integrity_check"?[{integrity_check:"ok"}]:[];} close(){} }\nmodule.exports=FakeDatabase;\n`);
  writeJson(path.join(root, "_local", "gameStore", "data", "stations", "data.json"), { stations: [{ stationID: 6001, solarSystemID: 3001 }] });
  writeJson(path.join(root, "_local", "gameStore", "data", "solarSystems", "data.json"), { solarSystems: [{ solarSystemID: 3001 }] });
  writeJson(path.join(root, "_local", "gameStore", "data", "itemTypes", "data.json"), { types: [{ typeID: 100, categoryID: 6 }] });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-private-r16-wallet-"));
try {
  const runtime = path.join(dir, "runtime");
  const out = path.join(dir, "bundle.json");
  makeRuntime(runtime);
  const result = cp.spawnSync(process.execPath, [tool, "export", "--source-root", runtime, "--out", out], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`wallet fixture export failed\n${result.stdout}\n${result.stderr}`);
  const bundle = JSON.parse(fs.readFileSync(out, "utf8"));
  assert(bundle.bundleVersion === 6, "wallet bundle must use v6");
  assert(bundle.toolVersion === "r1.6", "wallet bundle must identify r1.6");
  assert((bundle.rows.walletAuthorityState || []).length === 1, "exactly selected character wallet authority should export");
  const row = bundle.rows.walletAuthorityState[0];
  assert(row.key === "character:140000011", "wallet authority key must be character:<id>");
  assert(row.value.balance === 35622900, "wallet ISK authority must preserve exact balance");
  assert(row.value.plexBalance === 2222 && row.value.aurBalance === 0, "wallet PLEX/AUR authority must preserve values");
  assert(Array.isArray(row.value.walletJournal) && row.value.walletJournal.length === 1 && row.value.walletJournal[0].amount === 22500, "wallet journal must preserve exact entries");
  assert(!JSON.stringify(bundle).includes("character:140000099"), "unselected character wallet authority must not leak into bundle");
  assert(result.stdout.includes('"walletAuthorityCharacters": 1'), "export summary must expose wallet authority count");
  assert(bundle.policy.walletAuthority && bundle.policy.walletAuthority.includes("ISK/AUR/PLEX"), "bundle policy must document wallet authority scope");

  const malformed = JSON.parse(JSON.stringify(bundle));
  malformed.rows.walletAuthorityState[0].key = "character:140000012";
  const malformedPath = path.join(dir, "malformed.json");
  fs.writeFileSync(malformedPath, JSON.stringify(malformed));
  const bad = cp.spawnSync(process.execPath, [tool, "inspect", "--in", malformedPath], { encoding: "utf8" });
  assert(bad.status === 1 && bad.stderr.includes("walletAuthorityState"), "wallet key/value scope mismatch must fail closed");

  const src = fs.readFileSync(tool, "utf8");
  assert(src.includes('{ table: "walletAuthorityState", key: (id) => `character:${String(id)}` }'), "wallet authority must be in character transfer spec");
  assert(src.includes('problems.push(`walletAuthorityState mismatch ${row.key}`)'), "post-import verifier must compare wallet authority rows exactly");

  console.log(`WALLET_VERIFIER_PASS ${passed}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
