"use strict";
const $ = (id) => document.getElementById(id);
let state = {};
const stepNames = ["Select Servers", "Analyze Source", "Prepare / Verify", "Review", "Transfer", "Verify / Report"];
$("steps").innerHTML = stepNames.map((name, i) => `<span class="nav-step" data-step="${i}">${i + 1}. ${name}</span>`).join("");

function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function setBusy(on, text = "Working…") { $("busyText").textContent = text; $("busy").classList.toggle("hidden", !on); }
let toastTimer;
function errorToast(error) { const text = error && (error.message || error.toString()) || "Unknown error"; $("toast").textContent = text.replace(/^Error invoking remote method '[^']+': Error:\s*/, ""); $("toast").classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 9000); }
async function action(text, fn) { setBusy(true, text); try { const result = await fn(); if (result && result.state) render(result.state); else if (result && result.engineSha256 !== undefined) render(result); return result; } catch (error) { errorToast(error); } finally { setBusy(false); } }

function facts(runtime) {
  if (!runtime) return "";
  const version = runtime.version ? `${runtime.version}${runtime.versionSource === "folder-name-fallback" ? " (folder-name fallback)" : ""}` : "Legacy / version unknown";
  const values = [["Version", version], ["State", runtime.lifecycle], ["gameStore", runtime.gameStore], ["DB", runtime.sqlite], ["manifest", runtime.manifest], ["data", runtime.data], ["content-packs", runtime.contentPacks], ["SetupEveJS.bat", runtime.setupScript], ["portraits", runtime.portraits], ["process", runtime.running]];
  return values.map(([key, val]) => `<span class="fact ${val === true || key === "Version" && val ? "ok" : val === false ? "bad" : ""}">${esc(key)}: ${esc(val == null ? "unknown" : val)}</span>`).join("");
}
let renderedCards = [];
function issue(card, index) {
  const fix = Array.isArray(card.fix) ? `<ol>${card.fix.map((x) => `<li>${esc(String(x).replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>` : "";
  const entities = (card.display || []).length ? `<dl class="entity-list">${card.display.map(([label,value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>` : "";
  const raw = JSON.stringify(card.affected || { structureID: card.structureID, name: card.name, nestedItems: card.nestedItems }, null, 2);
  const technical = card.technicalDetails || raw;
  return `<article class="issue ${esc(card.class)}"><div class="issue-head"><span class="badge">${esc(card.class)}</span><h3>${esc(card.title)}</h3></div>${entities}<p><strong>Why:</strong> ${esc(card.why)}</p>${fix}<details class="tech"><summary>Technical details</summary><pre>${esc(technical)}</pre><button class="copy-tech" data-card="${index}">Copy Technical Details</button></details></article>`;
}
function render(next) {
  state = next || state;
  $("engineHash").textContent = state.engineSha256 || "unavailable";
  $("appVersion").textContent = state.appVersion || "0.1.3";
  if (document.activeElement !== $("sourcePath")) $("sourcePath").value = state.sourceRoot || "";
  if (document.activeElement !== $("targetPath")) $("targetPath").value = state.targetRoot || "";
  $("sourceFacts").innerHTML = facts(state.source);
  $("targetFacts").innerHTML = facts(state.target);
  $("nodePath").value = state.manualNodePath || state.activeNodePath || "";
  $("analysisMessage").textContent = state.analysisMessage || "No valid analysis exists for the currently selected source.";
  const s = state.summary;
  $("summary").className = s ? "metrics" : "metrics empty";
  const severity = state.severity || {};
  $("summary").innerHTML = s ? [["Accounts",s.accounts],["Characters",s.characters],["Corporations",s.corporations],["Alliances",s.alliances],["Items",s.items],["Blueprint state",s.blueprintState],["Researched",s.researchedBlueprints],["Copies",s.blueprintCopies],["Mail messages",s.mail],["Wallet rows",s.walletAuthority],["Blockers",severity.blockers],["Warnings",severity.warnings],["Deferred",severity.deferred],["Deferred items",s.deferredItems],["Portrait files",state.portraits&&state.portraits.files]].map(([l,v])=>`<div class="metric"><b>${esc(v||0)}</b><span>${esc(l)}</span></div>`).join("") : "No analysis yet.";
  renderedCards = [...(state.cards || []), ...(state.deferred || [])];
  $("cards").innerHTML = (state.cards || []).map((card,i)=>issue(card,i)).join("");
  $("deferred").innerHTML = (state.deferred || []).map((card,i)=>issue(card,(state.cards||[]).length+i)).join("");
  const setupRequired = state.target && state.target.recognized && !state.preparedConfiguredTarget && (state.target.pristine || state.targetState === "TARGET_PRISTINE_SETUP_REQUIRED");
  $("setupGuidance").classList.toggle("hidden", !setupRequired);
  $("runSetupBtn").classList.toggle("hidden", !(state.target && state.target.setupScript));
  $("prepareMessage").classList.toggle("hidden", !state.targetPrepared || state.targetVerified);
  const readiness = state.readiness || { canDryRun: false, ready: false, message: "Not ready: complete analysis and target verification." };
  const ready = readiness.ready && !state.transferBlocked;
  $("readiness").textContent = readiness.message;
  $("readiness").classList.toggle("ready", ready);
  $("reviewBtn").disabled = !readiness.canDryRun;
  $("transferBtn").disabled = !ready;
  const mechanical = state.mechanical || {};
  $("mechanical").innerHTML = [["DB import",mechanical.dbImport],["SQLite integrity",mechanical.integrity],["World isolation",mechanical.worldIsolation],["Wallet authority",mechanical.walletAuthority],["Blueprint state",mechanical.blueprintState],["Portrait copy",mechanical.portraits]].map(([label,value])=>`<div class="check-result"><span>${esc(label)}</span><b class="${esc(value||"")}">${esc(value||"NOT RUN")}</b></div>`).join("");
  $("finalStatus").textContent = state.finalStatus === "MECHANICAL_PASS_GAMEPLAY_REQUIRED" ? "Migration mechanical checks passed. Gameplay verification is REQUIRED." : state.finalStatus === "DB_PASS_PORTRAIT_FAIL" ? "Database migration passed; portrait copy failed. Gameplay verification remains REQUIRED." : `Status: ${state.finalStatus || "NOT_STARTED"}. Gameplay verification will not be auto-claimed.`;
  const current = state.finalStatus === "MECHANICAL_PASS_GAMEPLAY_REQUIRED" ? 5 : state.reviewReady ? 4 : state.targetVerified ? 3 : state.summary ? 2 : state.sourceRoot && state.targetRoot ? 1 : 0;
  document.querySelectorAll(".nav-step").forEach((el, i) => el.classList.toggle("active", i === current));
}

async function syncRoots() { return window.eveTransfer.setRoots({ sourceRoot: $("sourcePath").value.trim(), targetRoot: $("targetPath").value.trim() }); }
$("browseSource").onclick = async () => { const folder = await window.eveTransfer.chooseFolder(); if (folder) { $("sourcePath").value = folder; render(await syncRoots()); } };
$("browseTarget").onclick = async () => { const folder = await window.eveTransfer.chooseFolder(); if (folder) { $("targetPath").value = folder; render(await syncRoots()); } };
$("sourcePath").onchange = () => action("Inspecting Source…", syncRoots);
$("targetPath").onchange = () => action("Inspecting Target…", syncRoots);
$("browseNode").onclick = async () => { const file = await window.eveTransfer.chooseNode(); if (file) render(await window.eveTransfer.setNode(file)); };
$("clearNode").onclick = async () => render(await window.eveTransfer.setNode(""));
$("analyzeBtn").onclick = $("scanBtn").onclick = () => action("Analyzing Source (read-only)…", async () => { await syncRoots(); return window.eveTransfer.analyze(); });
$("prepareBtn").onclick = () => action("Backing up and preparing Target…", async () => { if (!confirm("Prepare Fresh Target will back up and remove only the listed generated gameStore state. Continue?")) return state; return window.eveTransfer.prepareTarget({ confirmUnknown: $("unknownConfirm").checked }); });
$("verifyBtn").onclick = () => action("Verifying Target…", () => window.eveTransfer.verifyTarget({ confirmFresh: $("freshConfirm").checked }));
$("reviewBtn").onclick = () => action("Running accepted import dry-run…", () => window.eveTransfer.review());
$("transferBtn").onclick = () => action("Applying database transfer and portraits…", async () => { if (!confirm("Apply the reviewed transfer now? Both EveJS servers must be stopped.")) return state; return window.eveTransfer.transfer({ confirmSourceUnknown: $("sourceStopped").checked, confirmTargetUnknown: $("targetStopped").checked }); });
$("exportBtn").onclick = () => action("Exporting report…", window.eveTransfer.exportReport);
$("supportBtn").onclick = () => action("Creating sanitized support ZIP…", window.eveTransfer.createSupportReport);
function renderHistory(entries) {
  $("historyEntries").innerHTML = entries.length ? entries.slice().reverse().map((entry) => `<article class="history-entry"><h3>${esc(entry.timestamp)}</h3><div class="facts"><span class="fact">App: ${esc(entry.appVersion)}</span><span class="fact">Engine: ${esc(entry.engineRevision)}</span><span class="fact">Source: ${esc(entry.sourceVersion)}</span><span class="fact">Target: ${esc(entry.targetVersion)}</span><span class="fact">Transfer: ${esc(entry.transferResult)}</span><span class="fact">Verification: ${esc(entry.verificationResult)}</span><span class="fact">Final: ${esc(entry.finalMechanicalResult)}</span></div><p>Characters: ${esc(entry.counts.characters)} · Items: ${esc(entry.counts.items)} · Blockers/Warnings/Deferred: ${esc(entry.findings.blockers)}/${esc(entry.findings.warnings)}/${esc(entry.findings.deferred)}</p></article>`).join("") : `<p class="muted">No transfer attempts recorded.</p>`;
}
$("historyBtn").onclick = async () => { try { renderHistory(await window.eveTransfer.getHistory()); $("historyDialog").showModal(); } catch (error) { errorToast(error); } };
$("closeHistoryBtn").onclick = () => $("historyDialog").close();
$("clearHistoryBtn").onclick = async () => { if (!confirm("Clear all local migration history? This does not affect EveJS runtimes or backups.")) return; try { renderHistory(await window.eveTransfer.clearHistory()); } catch (error) { errorToast(error); } };
$("logBtn").onclick = window.eveTransfer.openLog;
$("backupBtn").onclick = window.eveTransfer.openBackup;
$("openTargetBtn").onclick = window.eveTransfer.openTarget;
$("runSetupBtn").onclick = window.eveTransfer.runSetup;
document.addEventListener("click", (event) => { const button = event.target.closest(".copy-tech"); if (!button) return; const card = renderedCards[Number(button.dataset.card)]; const text = card && (card.technicalDetails || JSON.stringify(card.affected || {}, null, 2)); window.eveTransfer.copyText(text || ""); button.textContent = "Copied"; });
window.eveTransfer.onState(render);
action("Verifying accepted engine…", () => window.eveTransfer.getState());
