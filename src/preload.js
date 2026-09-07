"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("eveTransfer", {
  getState: () => ipcRenderer.invoke("get-state"),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  chooseNode: () => ipcRenderer.invoke("choose-node"),
  setNode: (nodePath) => ipcRenderer.invoke("set-node", nodePath),
  setRoots: (roots) => ipcRenderer.invoke("set-roots", roots),
  analyze: () => ipcRenderer.invoke("analyze"),
  prepareTarget: (options) => ipcRenderer.invoke("prepare-target", options),
  verifyTarget: (options) => ipcRenderer.invoke("verify-target", options),
  review: () => ipcRenderer.invoke("review"),
  transfer: (options) => ipcRenderer.invoke("transfer", options),
  exportReport: () => ipcRenderer.invoke("export-report"),
  createSupportReport: () => ipcRenderer.invoke("create-support-report"),
  getHistory: () => ipcRenderer.invoke("get-history"),
  clearHistory: () => ipcRenderer.invoke("clear-history"),
  openLog: () => ipcRenderer.invoke("open-log"),
  openBackup: () => ipcRenderer.invoke("open-backup"),
  openTarget: () => ipcRenderer.invoke("open-target"),
  runSetup: () => ipcRenderer.invoke("run-setup"),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  onState: (handler) => ipcRenderer.on("state", (_event, state) => handler(state)),
});
