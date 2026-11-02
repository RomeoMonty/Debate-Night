// Electron shell: one window running the game, plus the local AI service.
const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path = require("path");
const { AIService } = require("./ai-service");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const serverPath = app.isPackaged
  ? path.join(process.resourcesPath, "llama", exe)
  : path.join(__dirname, "resources", `llama-${process.arch}`, exe);

let win = null;
const ai = new AIService({
  modelsDir: path.join(app.getPath("userData"), "models"),
  serverPath,
  onEvent: e => { if (win && !win.isDestroyed()) win.webContents.send("ai:event", e); }
});

// Errors cross to the page as plain objects so it can show the right message.
const wrap = fn => async (_e, ...args) => {
  try { return { ok: true, value: await fn(...args) }; }
  catch (e) { return { ok: false, error: { code: e.code || "error", message: e.message || String(e), log: e.log || [] } }; }
};

ipcMain.handle("ai:info", wrap(() => ai.info()));
ipcMain.handle("ai:download", wrap(id => ai.startDownload(id)));
ipcMain.handle("ai:cancel", wrap(() => ai.cancelDownload()));
ipcMain.handle("ai:start", wrap(id => ai.start(id)));
ipcMain.handle("ai:stop", wrap(() => ai.stopSafely()));
ipcMain.handle("ai:degrade", wrap(id => ai.degrade(id)));
ipcMain.handle("ai:remove", wrap(id => ai.removeModel(id)));
ipcMain.handle("app:open", wrap(url => { if (/^https:\/\//.test(url)) return shell.openExternal(url); }));

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 900, minWidth: 380, minHeight: 600,
    title: "Debate Night 2028",
    backgroundColor: "#0E121A",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  win.once("ready-to-show", () => win.show());
  // Links open in the player's browser, never inside the game window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.loadFile(path.join(__dirname, "game", "index.html"));
  win.on("closed", () => { win = null; });
}

// A small menu: standard editing shortcuts (copy/paste in the answer box) and reload.
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
  { role: "editMenu" },
  { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
  { role: "windowMenu" }
]));

// Clean up an AI engine left running by a crash, and never leave one behind ourselves.
if (gotLock && ai.killStale()) console.log("Stopped an AI engine left over from a previous run.");
process.on("exit", () => ai.killNow());
process.on("uncaughtException", e => { console.error(e); ai.killNow(); app.exit(1); });

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
let quitting = false;
app.on("before-quit", e => {
  if (quitting) return;
  e.preventDefault(); quitting = true;
  ai.cancelDownload();
  ai.cancelStart = true;
  ai.stop().finally(() => app.quit());
});
