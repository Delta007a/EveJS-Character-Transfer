"use strict";

const https = require("node:https");
const core = require("./core");

const GITHUB_OWNER = "Delta007a";
const GITHUB_REPOSITORY = "EveJS-Character-Transfer";
const RELEASE_API_PATH = `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/latest`;
const OFFICIAL_LATEST_RELEASE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/latest`;

function fetchOfficialLatestRelease({ httpsImpl = https, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsImpl.get({ protocol: "https:", hostname: "api.github.com", port: 443, path: RELEASE_API_PATH, headers: { Accept: "application/vnd.github+json", "User-Agent": "EveJS-Character-Transfer", "X-GitHub-Api-Version": "2022-11-28" } }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { request.destroy(new Error("GitHub response exceeded the update-check size limit.")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) { reject(new Error(`GitHub update check returned HTTP ${response.statusCode}.`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("GitHub update response was not valid JSON.")); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("GitHub update check timed out.")));
    request.on("error", reject);
  });
}

function releaseNotesSummary(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function parseStableRelease(release) {
  if (!release || release.draft === true || release.prerelease === true) throw new Error("Latest GitHub response was not a stable public release.");
  const match = String(release.tag_name || "").match(/^v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error("Latest GitHub release tag is invalid.");
  const expectedUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/tag/v${match[1]}`;
  if (release.html_url !== expectedUrl) throw new Error("Latest GitHub release URL was not the pinned official repository URL.");
  return { version: match[1], tag: `v${match[1]}`, releaseNotes: releaseNotesSummary(release.body) };
}

async function checkForUpdates({ currentVersion, fetchLatestRelease = fetchOfficialLatestRelease } = {}) {
  const current = core.releaseVersion(currentVersion);
  if (!current || !/^\d+\.\d+\.\d+$/.test(current)) throw new Error("Current application version is invalid.");
  const latest = parseStableRelease(await fetchLatestRelease());
  const comparison = core.compareVersions(latest.version, current);
  if (comparison == null) throw new Error("Release versions could not be compared.");
  return {
    status: comparison > 0 ? "UPDATE_AVAILABLE" : "UP_TO_DATE",
    currentVersion: current,
    latestVersion: latest.version,
    releaseNotes: latest.releaseNotes,
    downloadPage: OFFICIAL_LATEST_RELEASE_URL,
  };
}

module.exports = { GITHUB_OWNER, GITHUB_REPOSITORY, RELEASE_API_PATH, OFFICIAL_LATEST_RELEASE_URL, fetchOfficialLatestRelease, releaseNotesSummary, parseStableRelease, checkForUpdates };
