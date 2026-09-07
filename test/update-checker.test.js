"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const updates = require("../src/update-checker");

function release(tag = "v0.2.0", overrides = {}) {
  return { tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/Delta007a/EveJS-Character-Transfer/releases/tag/${tag}`, body: "New safety features\n\nNo telemetry.", ...overrides };
}

test("update checker compares stable semantic versions from the pinned repository", async () => {
  const available = await updates.checkForUpdates({ currentVersion: "0.1.3", fetchLatestRelease: async () => release("v0.2.0") });
  assert.deepEqual(available, { status: "UPDATE_AVAILABLE", currentVersion: "0.1.3", latestVersion: "0.2.0", releaseNotes: "New safety features No telemetry.", downloadPage: updates.OFFICIAL_LATEST_RELEASE_URL });
  const current = await updates.checkForUpdates({ currentVersion: "0.2.0", fetchLatestRelease: async () => release("v0.2.0") });
  assert.equal(current.status, "UP_TO_DATE");
});

test("drafts, prereleases, malformed tags, and substituted URLs fail closed", async () => {
  for (const hostile of [
    release("v0.2.0", { draft: true }),
    release("v0.2.0-beta.1", { prerelease: true }),
    release("latest"),
    release("v0.2.0", { html_url: "https://evil.example/download.exe" }),
  ]) await assert.rejects(updates.checkForUpdates({ currentVersion: "0.1.3", fetchLatestRelease: async () => hostile }));
});

test("release notes are bounded and control characters are removed", () => {
  const summary = updates.releaseNotesSummary(`safe\u0000\n${"x".repeat(900)}`);
  assert.equal(summary.length, 500);
  assert.doesNotMatch(summary, /[\u0000-\u001f\u007f]/);
});

test("network failures remain isolated from migration state", async () => {
  const migration = { finalStatus: "READY", mechanical: { dbImport: "NOT RUN" } };
  await assert.rejects(updates.checkForUpdates({ currentVersion: "0.1.3", fetchLatestRelease: async () => { throw new Error("offline"); } }), /offline/);
  assert.deepEqual(migration, { finalStatus: "READY", mechanical: { dbImport: "NOT RUN" } });
});

test("main process opens only the hard-coded official release page", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /shell\.openExternal\(updateChecker\.OFFICIAL_LATEST_RELEASE_URL\)/);
  assert.doesNotMatch(main, /openExternal\([^)]*(?:html_url|downloadPage|ipc|_event)/i);
  assert.equal(updates.RELEASE_API_PATH, "/repos/Delta007a/EveJS-Character-Transfer/releases/latest");
  assert.equal(updates.OFFICIAL_LATEST_RELEASE_URL, "https://github.com/Delta007a/EveJS-Character-Transfer/releases/latest");
});
