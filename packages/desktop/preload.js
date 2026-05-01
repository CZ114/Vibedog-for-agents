const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companionDesktop", {
  close: () => ipcRenderer.invoke("window:close"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleCompact: () => ipcRenderer.invoke("window:toggle-compact"),
  setMode: (mode) => ipcRenderer.invoke("window:set-mode", mode),
  openDashboard: () => ipcRenderer.invoke("open:dashboard"),
  peekHover: () => ipcRenderer.invoke("window:peek-hover"),
  peekUnhover: () => ipcRenderer.invoke("window:peek-unhover"),
  onCompactChanged: (callback) => {
    ipcRenderer.on("window:compact-changed", (_event, compact) => callback(Boolean(compact)));
  },
  onModeChanged: (callback) => {
    ipcRenderer.on("window:mode-changed", (_event, mode) => callback(String(mode || "compact")));
  },
  onPeekChanged: (callback) => {
    ipcRenderer.on("window:peek-changed", (_event, peeking) => callback(Boolean(peeking)));
  }
});
