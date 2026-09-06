"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { US } = require("./core");

function openRuntimeDb(root) {
  const candidates = [path.join(root, "server", "node_modules", "better-sqlite3"), path.join(root, "node_modules", "better-sqlite3")];
  const modulePath = candidates.find((p) => fs.existsSync(p));
  if (!modulePath) throw new Error("Source better-sqlite3 runtime was not found; process diagnostics are unavailable.");
  const Database = require(modulePath);
  return new Database(path.join(root, "_local", "gameStore", "gamestore.sqlite"), { readonly: true, fileMustExist: true });
}

function tableRows(db, table) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  return db.prepare(`SELECT key,json FROM "${table.replaceAll('"', '""')}"`).all().map((r) => { try { return { key: String(r.key), value: JSON.parse(r.json) }; } catch { return { key: String(r.key), value: null }; } });
}

function deepFind(value, predicate, found = []) {
  if (!value || typeof value !== "object") return found;
  if (predicate(value)) found.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) deepFind(child, predicate, found);
  return found;
}

function externalRecords(bundle) {
  const records = [];
  for (const warning of bundle.warnings || []) {
    if (warning.code !== "EXTERNAL_ITEM_LOCATIONS") continue;
    const candidates = deepFind(warning, (v) => Number(v.itemID) > 0 && Number(v.locationID) > 0);
    for (const value of candidates) records.push({ warning, itemID: Number(value.itemID), typeID: Number(value.typeID || 0), ownerID: Number(value.ownerID || 0), locationID: Number(value.locationID), raw: value });
  }
  return records;
}

function affected(record) { return { itemID: record.itemID, typeID: record.typeID, ownerID: record.ownerID, locationID: record.locationID }; }

function staticRecords(root, table, keys) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(root, "_local", "gameStore", "data", table, "data.json"), "utf8"));
    for (const key of keys) if (Array.isArray(payload && payload[key])) return payload[key];
  } catch {}
  return [];
}

function put(map, id, name) { if (Number(id) > 0 && name) map[String(Number(id))] = String(name); }

function buildResolution(db, root) {
  const result = { characters: {}, corporations: {}, types: {}, stations: {}, systems: {}, structures: {} };
  for (const row of tableRows(db, "characters")) put(result.characters, row.key, row.value && row.value.characterName);
  for (const row of tableRows(db, "corporations")) {
    if (row.key === "records") for (const record of Object.values(row.value || {})) put(result.corporations, record.corporationID, record.corporationName || record.name);
    else put(result.corporations, row.value && row.value.corporationID || row.key, row.value && (row.value.corporationName || row.value.name));
  }
  for (const record of staticRecords(root, "itemTypes", ["types", "itemTypes"])) put(result.types, record.typeID, record.name || record.typeName);
  for (const record of staticRecords(root, "stations", ["stations"])) put(result.stations, record.stationID, record.stationName || record.name);
  for (const record of staticRecords(root, "solarSystems", ["solarSystems", "systems"])) put(result.systems, record.solarSystemID, record.solarSystemName || record.name);
  for (const row of tableRows(db, "structures")) {
    const records = Array.isArray(row.value) ? row.value : row.value && Array.isArray(row.value.structures) ? row.value.structures : row.value && row.value.structureID ? [row.value] : [];
    for (const record of records) {
      const type = result.types[String(Number(record.typeID))];
      put(result.structures, record.structureID, type ? `${record.name || "Unnamed structure"} — ${type}` : record.name);
    }
  }
  return result;
}

function diagnose(root, bundle) {
  const output = [];
  let resolution = { characters: {}, corporations: {}, types: {}, stations: {}, systems: {}, structures: {} };
  let db;
  try {
    db = openRuntimeDb(root);
    resolution = buildResolution(db, root);
    const jobs = tableRows(db, "industryJobs").filter((r) => r.key.startsWith(`jobs${US}`)).map((r) => r.value).filter(Boolean);
    const contracts = tableRows(db, "contractRuntime").map((r) => r.value).filter(Boolean);
    const missionSettlements = tableRows(db, "missionRewardSettlements").map((r) => r.value).filter(Boolean);
    for (const record of externalRecords(bundle)) {
      const job = jobs.find((j) => Number(j.blueprintID) === record.itemID && Number(j.installedLocationID) === record.locationID && [0, 1, 2, 3, 100].includes(Number(j.status)));
      if (record.locationID === 2003 && job) {
        const activity = ({ 1: "Manufacturing", 3: "Time Efficiency research", 4: "Material Efficiency research", 5: "Copying", 8: "Invention", 9: "Reaction" })[Number(job.activityID)] || "Industry";
        output.push({ source: "external-item", warningCode: "EXTERNAL_ITEM_LOCATIONS", class: "BLOCKER", code: "ACTIVE_INDUSTRY_JOB", title: "Blueprint is installed in an active Industry job", why: "This blueprint is currently owned by Industry runtime and is not ordinary inventory.", affected: { ...affected(record), jobID: job.jobID, jobDescription: `${activity} job ${job.jobID}`, characterID: job.installerID || job.ownerID }, fix: ["1. Start the SOURCE server.", `2. Log in as ${resolution.characters[String(Number(job.installerID || job.ownerID))] || `the owning character (${job.installerID || job.ownerID})`}.`, "3. Open Industry.", "4. Complete/Deliver the job, or cancel it if appropriate.", "5. Confirm the blueprint/item has returned to ordinary inventory.", "6. Log out.", "7. Shut down the source normally.", "8. Click Scan Again."] });
        continue;
      }
      if (record.locationID >= 9_200_000_000 && record.locationID < 9_300_000_000) {
        output.push({ source: "external-item", warningCode: "EXTERNAL_ITEM_LOCATIONS", class: "BLOCKER", code: "ACTIVE_MARKET_ESCROW", title: "Active market state holds transferable assets/escrow", why: "This item is in the source-defined market order escrow location range; Classic Transfer excludes market process state.", affected: { ...affected(record), orderID: record.locationID - 9_200_000_000 }, fix: ["Cancel or finish the relevant order on the SOURCE server and confirm the item returns to ordinary inventory. Log out, shut down the source, then click Scan Again."] });
        continue;
      }
      if (record.locationID >= 9_300_000_000 && record.locationID < 9_400_000_000) {
        const contractID = record.locationID - 9_300_000_000;
        const proven = deepFind(contracts, (v) => Number(v.contractID) === contractID && [0, 1, 10, -1].includes(Number(v.status))).length > 0;
        if (proven) {
          output.push({ source: "external-item", warningCode: "EXTERNAL_ITEM_LOCATIONS", class: "BLOCKER", code: "ACTIVE_CONTRACT_ESCROW", title: "Active contract holds transferable assets", why: "The item is in the proven escrow location of an active contract, and contract process state is excluded.", affected: { ...affected(record), contractID }, fix: ["Complete or cancel the contract and reclaim the item, log out, stop the source, then click Scan Again."] });
          continue;
        }
      }
      if (record.locationID >= 9_500_000_000) {
        const proven = deepFind(missionSettlements, (v) => Number(v.escrowLocationID) === record.locationID).length > 0;
        if (proven) {
          output.push({ source: "external-item", warningCode: "EXTERNAL_ITEM_LOCATIONS", class: "BLOCKER", code: "MISSION_SETTLEMENT_CUSTODY", title: "Mission process holds a transferable item", why: "The selected item is proven to be in mission reward settlement custody, which Classic Transfer excludes.", affected: affected(record), fix: ["Finish or abandon the relevant mission and recover the item into ordinary inventory at a static NPC station. Log out, stop the source, then click Scan Again."] });
          continue;
        }
      }
      output.push({ source: "external-item", warningCode: "EXTERNAL_ITEM_LOCATIONS", class: "BLOCKER", code: "UNRESOLVED_DYNAMIC_LOCATION", title: "Item is held at an unresolved dynamic location", why: "The process relationship cannot be proven safely from this source schema.", affected: affected(record), fix: ["Recover or move the item into ordinary inventory at a static NPC station, log out, stop the source, then click Scan Again. No process type is assumed and no item is automatically re-homed."] });
    }
    const selected = new Set((bundle.selected && bundle.selected.characterIDs || []).map(Number));
    for (const row of tableRows(db, "missionRuntimeState").filter((r) => r.key.startsWith(`charactersByID${US}`))) {
      const charID = Number(row.value && row.value.characterID);
      const active = Object.values(row.value && row.value.missionsByAgentID || {}).filter((m) => m && !["completed", "failed", "declined", "expired"].includes(String(m.status).toLowerCase()));
      if (selected.has(charID) && active.length) {
        const missionNames = active.map((m) => m.missionName || m.name || m.title).filter(Boolean);
        output.push({ source: "mission-progress", class: "WARNING", code: "ACTIVE_MISSION_PROGRESS", title: "Active mission progress will not transfer", why: "Mission runtime is excluded; no selected asset custody was proven by this warning.", affected: { characterID: charID, missionCount: active.length, missionName: missionNames.length ? missionNames.join(", ") : `Unknown mission (${active.map((m) => m.missionID || m.agentID || "unresolved").join(", ")})` }, fix: ["Complete or abandon the mission first if you care about its progress. Ordinary transferable assets remain unaffected."] });
      }
    }
  } catch (error) {
    output.push({ source: "diagnostic", class: "WARNING", code: "PROCESS_DIAGNOSTICS_UNAVAILABLE", title: "Process-state diagnostic scan unavailable", why: error.message, affected: {}, fix: ["The accepted engine remains authoritative. Raw external-location blockers still fail closed."] });
  } finally { if (db) db.close(); }
  return { cards: output, resolution };
}

module.exports = { diagnose, externalRecords, deepFind, buildResolution, staticRecords };
