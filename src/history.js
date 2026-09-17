"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("./core");

const HISTORY_LIMIT = 50;

function safeStatus(value, fallback = "NOT RUN") {
  const normalized = String(value || "").toUpperCase();
  return /^[A-Z][A-Z0-9 _—-]{0,79}$/.test(normalized) ? normalized : fallback;
}

function safeVersion(value) { return core.releaseVersion(value) || "unknown"; }
function safeHash(value) { return /^[a-f0-9]{64}$/i.test(String(value || "")) ? String(value).toLowerCase() : "unavailable"; }
function safeCount(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }

function verificationResult(stages) {
  const values = [stages.databaseVerification, stages.worldIsolation, stages.walletVerification, stages.blueprintVerification, stages.portraitVerification];
  if (values.some((value) => value === "FAIL")) return "FAIL";
  const applicable = values.filter((value) => value !== "NOT APPLICABLE" && value !== "SKIPPED — NO SOURCE MEDIA");
  return applicable.length && applicable.every((value) => value === "PASS") ? "PASS" : "NOT RUN";
}

function historyEntry(state = {}, options = {}) {
  const report = core.reportData(state, options);
  return {
    timestamp: report.generatedAt,
    appVersion: report.appVersion,
    engineRevision: report.engineRevision,
    engineSha256: report.engineSha256,
    sourceVersion: report.source.version,
    targetVersion: report.target.version,
    sourceSupport: report.source.supportLabel,
    sourceSupportCode: report.source.supportCode,
    counts: { ...report.counts },
    findings: { blockers: report.findings.blockers, warnings: report.findings.warnings, deferred: report.findings.deferred },
    dryRunResult: report.stages.dryRun,
    transferResult: report.stages.import,
    targetVerificationResult: report.stages.targetVerification,
    verificationResult: verificationResult(report.stages),
    finalMechanicalResult: report.stages.finalMechanicalResult,
  };
}

function sanitizeStoredEntry(entry = {}) {
  const counts = {};
  for (const field of ["accounts", "characters", "corporations", "alliances", "items", "blueprintState", "researchedBlueprints", "blueprintCopies", "mail", "walletAuthority"]) counts[field] = safeCount((entry.counts || {})[field]);
  const supportCode = String(entry.sourceSupportCode || "SOURCE_VERSION_UNKNOWN");
  return {
    timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(entry.timestamp || "")) ? String(entry.timestamp) : "unknown",
    appVersion: safeVersion(entry.appVersion),
    engineRevision: entry.engineRevision === core.ENGINE_REVISION ? entry.engineRevision : core.ENGINE_REVISION,
    engineSha256: safeHash(entry.engineSha256),
    sourceVersion: safeVersion(entry.sourceVersion),
    targetVersion: safeVersion(entry.targetVersion),
    sourceSupport: entry.sourceSupport === "SUPPORTED" ? "SUPPORTED" : "ANALYZE ONLY",
    sourceSupportCode: /^[A-Z][A-Z0-9_]{1,79}$/.test(supportCode) ? supportCode : "SOURCE_VERSION_UNKNOWN",
    counts,
    findings: {
      blockers: safeCount((entry.findings || {}).blockers),
      warnings: safeCount((entry.findings || {}).warnings),
      deferred: safeCount((entry.findings || {}).deferred),
    },
    dryRunResult: safeStatus(entry.dryRunResult),
    transferResult: safeStatus(entry.transferResult),
    targetVerificationResult: safeStatus(entry.targetVerificationResult),
    verificationResult: safeStatus(entry.verificationResult),
    finalMechanicalResult: safeStatus(entry.finalMechanicalResult, "NOT STARTED"),
  };
}

function readHistory(file, { fsImpl = fs } = {}) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-HISTORY_LIMIT).map(sanitizeStoredEntry);
  } catch { return []; }
}

function atomicWrite(file, value, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fsImpl.renameSync(temp, file);
  } catch (error) {
    try { fsImpl.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function appendHistory(file, entry, options = {}) {
  const previous = readHistory(file, options);
  const entries = [...previous, sanitizeStoredEntry(entry)].slice(-HISTORY_LIMIT);
  atomicWrite(file, entries, options);
  return entries;
}

function appendHistorySafe(file, entry, options = {}) {
  try { return { ok: true, entries: appendHistory(file, entry, options) }; }
  catch { return { ok: false, entries: [] }; }
}

function clearHistory(file, options = {}) { atomicWrite(file, [], options); return []; }
function clearHistorySafe(file, options = {}) { try { clearHistory(file, options); return true; } catch { return false; } }

module.exports = { HISTORY_LIMIT, historyEntry, sanitizeStoredEntry, readHistory, appendHistory, appendHistorySafe, clearHistory, clearHistorySafe };
