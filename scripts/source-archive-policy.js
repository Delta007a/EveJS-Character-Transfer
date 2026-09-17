"use strict";

const FORBIDDEN = [
  /(^|\/)runs(\/|$)/i,
  /(^|\/)backups?(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)gameStore(\/|$)/i,
  /(^|\/)(?:portable[-_ ]?node|node-v\d)(\/|$)/i,
  /private-state-.*\.json(?:\.sha256)?$/i,
  /\.sqlite(?:-wal|-shm)?$/i,
  /(^|\/)(?:images\/Character|portraits?)(\/|$)/i,
  /migration[-_ ]?(?:bundle|backup)/i,
];

const ALLOWED = [
  /^(?:\.gitattributes|\.gitignore|README\.md|package\.json|package-lock\.json)$/,
  /^\.github\/workflows\/(?:ci|release)\.yml$/,
  /^assets\/(?:icon-source\.png|icon\.ico)$/,
  /^docs\/[A-Za-z0-9._-]+\.md$/,
  /^release\/README\.txt$/,
  /^engine\/accepted-r1\.6\/(?:EXAMPLE-COMMANDS\.ps1|README\.md|SHA256SUMS\.txt|SOURCE-REVIEW\.md|STATUS\.txt|private-identity-transfer\.js|verify-private-identity-transfer-(?:blueprints|portraits|static|structure-policy|wallet)\.js)$/,
  /^engine\/r1\.7\/(?:SHA256SUMS\.txt|STATUS\.txt|private-identity-transfer\.js|verify-private-identity-transfer-achievements\.js)$/,
  /^scripts\/[A-Za-z0-9._-]+\.(?:js|ps1)$/,
  /^src\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|html|css)$/,
  /^test\/[A-Za-z0-9._-]+\.test\.js$/,
];

function normalizeArchivePath(value) { return String(value || "").replaceAll("\\", "/").replace(/^\.\//, ""); }
function isForbidden(value) { const name = normalizeArchivePath(value); return FORBIDDEN.some((pattern) => pattern.test(name)); }
function isAllowed(value) {
  const name = normalizeArchivePath(value);
  return Boolean(name && !name.startsWith("/") && !name.split("/").includes("..") && !isForbidden(name) && ALLOWED.some((pattern) => pattern.test(name)));
}

module.exports = { FORBIDDEN, ALLOWED, normalizeArchivePath, isForbidden, isAllowed };
