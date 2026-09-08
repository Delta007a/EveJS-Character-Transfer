"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("./core");

const DATA_ROOT_ENV = "EVEJS_TRANSFER_DATA_ROOT";
const RUN_MANIFEST = ".evejs-character-transfer-run.json";
const RUN_KIND = "EVEJS_CHARACTER_TRANSFER_RUN";
const BACKUP_NAME = /^target-before-prepare-\d{4}-\d{2}-\d{2}T[0-9A-Z.-]+$/;
const RUN_NAME = /^run-([0-9a-f]{8}-[0-9a-f-]{27,})$/i;
const LOG_NAME = /^transfer-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const BACKUP_ENTRIES = new Set(["gamestore.sqlite", "gamestore.sqlite-wal", "gamestore.sqlite-shm", "data", "manifest.json", "images/Character"]);

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveDataRoot({ isPackaged, execPath, env = process.env, devRoot } = {}) {
  if (isPackaged) {
    const launcher = env.PORTABLE_EXECUTABLE_FILE && path.isAbsolute(env.PORTABLE_EXECUTABLE_FILE) ? env.PORTABLE_EXECUTABLE_FILE : null;
    const launcherDir = !launcher && env.PORTABLE_EXECUTABLE_DIR && path.isAbsolute(env.PORTABLE_EXECUTABLE_DIR) ? env.PORTABLE_EXECUTABLE_DIR : null;
    const executableDir = launcher ? path.dirname(path.resolve(launcher)) : launcherDir ? path.resolve(launcherDir) : path.dirname(path.resolve(execPath));
    return path.join(executableDir, "data");
  }
  const override = env[DATA_ROOT_ENV];
  return path.resolve(override || devRoot || path.join(__dirname, "..", ".dev-data"));
}

function pathsFor(root) {
  const resolved = path.resolve(root);
  return { root: resolved, runs: path.join(resolved, "runs"), logs: path.join(resolved, "logs"), backups: path.join(resolved, "backups"), electron: path.join(resolved, "electron"), history: path.join(resolved, "history.json") };
}

function storageError(root, cause) {
  const error = new Error(`Portable data directory is not writable:\n${path.resolve(root)}\n\nMove or extract the entire EveJS Character Transfer folder to a writable location, then run it again. No operation was started.`);
  error.code = "PORTABLE_DATA_UNWRITABLE";
  error.cause = cause;
  return error;
}

function ensureWritable(paths, { fsImpl = fs, token = crypto.randomUUID() } = {}) {
  const probe = path.join(paths.root, `.evejs-write-test-${token}.tmp`);
  try {
    for (const dir of [paths.root, paths.runs, paths.logs, paths.backups, paths.electron]) fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(probe, "write-test", { encoding: "utf8", flag: "wx" });
    fsImpl.rmSync(probe, { force: true });
    return paths;
  } catch (cause) {
    try { fsImpl.rmSync(probe, { force: true }); } catch {}
    throw storageError(paths.root, cause);
  }
}

function measurePath(target, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(target)) return 0;
  let bytes = 0;
  const visit = (current) => {
    const stat = fsImpl.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Application storage does not follow symbolic links: ${current}`);
    if (stat.isDirectory()) for (const name of fsImpl.readdirSync(current)) visit(path.join(current, name));
    else if (stat.isFile()) bytes += stat.size;
    else throw new Error(`Unsupported filesystem entry in application storage: ${current}`);
  };
  visit(target);
  return bytes;
}

function measurePaths(paths, options) { return paths.reduce((total, target) => total + measurePath(target, options), 0); }

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  const digits = index === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}`;
}

function freeSpace(root, { fsImpl = fs } = {}) {
  if (typeof fsImpl.statfsSync !== "function") return null;
  try {
    const stat = fsImpl.statfsSync(root, { bigint: true });
    const bytes = stat.bavail * stat.bsize;
    return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
  } catch { return null; }
}

function backupSpaceStatus(requiredBytes, availableBytes) {
  const required = Number(requiredBytes);
  const available = availableBytes == null ? null : Number(availableBytes);
  return { requiredBytes: required, availableBytes: available, insufficient: available != null && Number.isFinite(available) && available >= 0 && required > available };
}

function createOwnedRun(runsRoot, sessionId, { fsImpl = fs, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = {}) {
  const runDir = path.join(runsRoot, `run-${id}`);
  fsImpl.mkdirSync(runDir, { recursive: false });
  fsImpl.writeFileSync(path.join(runDir, RUN_MANIFEST), `${JSON.stringify({ kind: RUN_KIND, schemaVersion: 1, id, sessionId, createdAt }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return runDir;
}

function ownedRun(root, candidate, { fsImpl = fs } = {}) {
  if (!isWithin(root, candidate) || path.dirname(path.resolve(candidate)) !== path.resolve(root)) return false;
  const match = path.basename(candidate).match(RUN_NAME);
  if (!match) return false;
  try {
    const stat = fsImpl.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const manifest = JSON.parse(fsImpl.readFileSync(path.join(candidate, RUN_MANIFEST), "utf8"));
    return manifest.kind === RUN_KIND && manifest.schemaVersion === 1 && manifest.id === match[1] && typeof manifest.sessionId === "string" && manifest.sessionId.length > 0;
  } catch { return false; }
}

function removeOwnedRun(runsRoot, runDir, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (!ownedRun(runsRoot, runDir, options)) throw new Error("Run directory is not positively identified as application-owned.");
  fsImpl.rmSync(runDir, { recursive: true, force: false });
}

function cleanupStaleRuns(runsRoot, { active = [], fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(runsRoot)) return { deleted: [], retained: [] };
  const activeSet = new Set(active.map((item) => path.resolve(item).toLowerCase()));
  const deleted = [], retained = [];
  for (const name of fsImpl.readdirSync(runsRoot)) {
    const candidate = path.join(runsRoot, name);
    if (activeSet.has(path.resolve(candidate).toLowerCase()) || !ownedRun(runsRoot, candidate, { fsImpl })) { retained.push(candidate); continue; }
    fsImpl.rmSync(candidate, { recursive: true, force: false });
    deleted.push(candidate);
  }
  return { deleted, retained };
}

function validCompletedBackup(backupsRoot, backupDir, { fsImpl = fs } = {}) {
  if (!isWithin(backupsRoot, backupDir) || path.dirname(path.resolve(backupDir)) !== path.resolve(backupsRoot) || !BACKUP_NAME.test(path.basename(backupDir))) return null;
  try {
    const stat = fsImpl.lstatSync(backupDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const manifest = JSON.parse(fsImpl.readFileSync(path.join(backupDir, core.PREPARE_MANIFEST), "utf8"));
    if (manifest.kind !== core.PREPARE_MANIFEST_KIND || manifest.schemaVersion !== 1 || manifest.engineRevision !== core.ACCEPTED_ENGINE_REVISION || manifest.engineSha256 !== core.ACCEPTED_ENGINE_SHA256) return null;
    if (manifest.status !== "TRANSFER_APPLIED" || manifest.transferApplied !== true || !Array.isArray(manifest.entries) || manifest.entries.length === 0) return null;
    if (!manifest.targetBinding || !/^[a-f0-9]{64}$/.test(manifest.targetBinding.pathSha256) || !/^[a-f0-9]{64}$/.test(manifest.targetBinding.identitySha256)) return null;
    const seen = new Set();
    for (const entry of manifest.entries) {
      if (!entry || !BACKUP_ENTRIES.has(entry.relativePath) || seen.has(entry.relativePath)) return null;
      seen.add(entry.relativePath);
      const stored = path.join(backupDir, ...entry.relativePath.split("/"));
      if (!isWithin(backupDir, stored) || JSON.stringify(core.fingerprintPath(stored)) !== JSON.stringify(entry.fingerprint)) return null;
    }
    return { path: backupDir, bytes: measurePath(backupDir, { fsImpl }), manifest };
  } catch { return null; }
}

function completedBackups(backupsRoot, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(backupsRoot)) return [];
  return fsImpl.readdirSync(backupsRoot).map((name) => validCompletedBackup(backupsRoot, path.join(backupsRoot, name), { fsImpl })).filter(Boolean);
}

function deleteCompletedBackup(backupsRoot, backupDir, { fsImpl = fs } = {}) {
  const candidate = validCompletedBackup(backupsRoot, backupDir, { fsImpl });
  if (!candidate) throw new Error("Backup is not a valid completed v0.2.0 backup. Undo-eligible, failed, unknown, incomplete, legacy, and foreign backups cannot be deleted.");
  fsImpl.rmSync(candidate.path, { recursive: true, force: false });
  return candidate;
}

function cleanCompletedBackups(backupsRoot, { fsImpl = fs } = {}) {
  const candidates = completedBackups(backupsRoot, { fsImpl });
  const deleted = [];
  for (const candidate of candidates) {
    try { fsImpl.rmSync(candidate.path, { recursive: true, force: false }); deleted.push(candidate); }
    catch (cause) { const error = new Error(`Completed-backup cleanup failed after deleting ${deleted.length} of ${candidates.length}. Remaining backup material was left in place.\n${cause.message}`); error.deleted = deleted; error.candidates = candidates; throw error; }
  }
  return { deleted, bytes: deleted.reduce((sum, item) => sum + item.bytes, 0) };
}

function cleanupLogs(logsRoot, { fsImpl = fs, now = Date.now(), retentionDays = 30 } = {}) {
  if (!fsImpl.existsSync(logsRoot)) return { deleted: [], retained: [] };
  const cutoff = now - retentionDays * 86400000;
  const deleted = [], retained = [];
  for (const name of fsImpl.readdirSync(logsRoot)) {
    const candidate = path.join(logsRoot, name);
    const match = name.match(LOG_NAME);
    let stat;
    try { stat = fsImpl.lstatSync(candidate); } catch { retained.push(candidate); continue; }
    const date = match && Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!match || !stat.isFile() || stat.isSymbolicLink() || !Number.isFinite(date) || date >= cutoff) { retained.push(candidate); continue; }
    fsImpl.rmSync(candidate, { force: false });
    deleted.push(candidate);
  }
  return { deleted, retained };
}

module.exports = { DATA_ROOT_ENV, RUN_MANIFEST, RUN_KIND, resolveDataRoot, pathsFor, storageError, ensureWritable, measurePath, measurePaths, formatBytes, freeSpace, backupSpaceStatus, createOwnedRun, ownedRun, removeOwnedRun, cleanupStaleRuns, validCompletedBackup, completedBackups, deleteCompletedBackup, cleanCompletedBackups, cleanupLogs };
