// Electron shell: one window running the game, plus the local AI service.
const { app, BrowserWindow, ipcMain, shell, Menu, powerSaveBlocker, powerMonitor } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { AIService } = require("./ai-service");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const serverPath = app.isPackaged
  ? path.join(process.resourcesPath, "llama", exe)
  : path.join(__dirname, "resources", `llama-${process.arch}`, exe);

// A plain-text diary of what happened (AI starts and stops, crashes, the computer sleeping), so a
// problem can be traced afterwards. Kept small: it starts over once it passes about 1 MB.
const logPath = path.join(app.getPath("userData"), "debate-night.log");
function note(line) {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1e6) fs.renameSync(logPath, logPath + ".old");
    fs.appendFileSync(logPath, `${new Date().toISOString()}  ${line}\n`);
  } catch {}
}
function logTail(n = 80) {
  try { return fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-n).join("\n"); } catch { return "(no log yet)"; }
}

let win = null;
const ai = new AIService({
  modelsDir: path.join(app.getPath("userData"), "models"),
  serverPath,
  note,
  onEvent: e => { if (win && !win.isDestroyed()) win.webContents.send("ai:event", e); }
});

// Errors cross to the page as plain objects so it can show the right message.
const wrap = fn => async (_e, ...args) => {
  try { return { ok: true, value: await fn(...args) }; }
  catch (e) { return { ok: false, error: { code: e.code || "error", message: e.message || String(e), log: e.log || [] } }; }
};

// Long test runs ask the computer not to sleep (a sleeping Mac pauses the AI mid-debate).
let awakeId = null;
function stayAwake(on) {
  if (on && awakeId === null) { awakeId = powerSaveBlocker.start("prevent-app-suspension"); note("Keeping the computer awake for a test run."); }
  if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; note("Test run over: the computer may sleep again."); }
  return true;
}

ipcMain.handle("ai:info", wrap(() => ai.info()));
ipcMain.handle("ai:download", wrap(id => ai.startDownload(id)));
ipcMain.handle("ai:cancel", wrap(() => ai.cancelDownload()));
ipcMain.handle("ai:start", wrap(id => ai.start(id)));
ipcMain.handle("ai:stop", wrap(() => ai.stopSafely()));
ipcMain.handle("ai:degrade", wrap(id => ai.degrade(id)));
ipcMain.handle("ai:resetSpeed", wrap(id => ai.resetSpeed(id)));
ipcMain.handle("ai:remove", wrap(id => ai.removeModel(id)));
ipcMain.handle("app:open", wrap(url => { if (/^https:\/\//.test(url)) return shell.openExternal(url); }));
ipcMain.handle("app:log", wrap(n => logTail(Math.min(Number(n) || 80, 2000))));
ipcMain.handle("app:stats", wrap(() => machineStats()));
ipcMain.handle("app:openLog", wrap(() => shell.showItemInFolder(logPath)));
ipcMain.handle("app:awake", wrap(on => stayAwake(!!on)));
ipcMain.handle("app:note", wrap(line => note("game: " + String(line).slice(0, 500))));
ipcMain.handle("app:ping", () => true);

// If the game ever died abruptly, macOS can leave its window process running on its own, eating
// CPU (seen at ~190%). Any of ours whose parent is gone get stopped at launch.
function killOrphans() {
  if (process.platform === "win32") return;
  execFile("ps", ["-axo", "pid=,ppid=,command="], (err, out) => {
    if (err) return;
    for (const line of String(out).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m || m[2] !== "1" || !/Debate Night 2028 Helper/.test(m[3])) continue;
      try { process.kill(Number(m[1]), "SIGKILL"); note(`Stopped a leftover game process from an earlier crash (pid ${m[1]}).`); } catch {}
    }
  });
}

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
      spellcheck: true,
      backgroundThrottling: false // keep the debate (and test runs) going when the window isn't in front
    }
  });
  win.once("ready-to-show", () => win.show());
  // Links open in the player's browser, never inside the game window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  // If the game page itself crashes, write down why and bring it back: the debate is saved.
  win.webContents.on("render-process-gone", (_e, d) => {
    note(`Game window crashed (${d.reason}, exit code ${d.exitCode}). Reloading it.`);
    setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 1000);
  });
  win.webContents.on("unresponsive", () => note("Game window stopped responding."));
  win.webContents.on("responsive", () => note("Game window is responding again."));
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
if (gotLock) {
  note(`--- Debate Night started (version ${app.getVersion()}, ${process.platform} ${process.arch}) ---`);
  if (ai.killStale()) note("Stopped an AI engine left over from a previous run (the game didn't close cleanly last time).");
  killOrphans();
}
process.on("exit", code => { note(`Game closed (exit code ${code}).`); ai.killNow(); });
// A stray error used to close the whole game. Now it's written down and the game carries on.
process.on("uncaughtException", e => { note("Unexpected error (the game kept running): " + (e && e.stack || e)); });
process.on("unhandledRejection", e => { note("Unhandled error (the game kept running): " + (e && e.stack || e)); });

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
// A snapshot of how the computer is coping, for test reports: free memory, swap (a Mac that is
// swapping slows the AI a lot), and how hard the AI engine and the game window are working.
function sh(cmd, args) { return new Promise(res => execFile(cmd, args, { timeout: 3000 }, (err, out) => res(err ? "" : String(out || "").trim()))); }
async function machineStats() {
  const st = { totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1), freeMemGB: +(os.freemem() / 2 ** 30).toFixed(2), load1: +os.loadavg()[0].toFixed(2) };
  try {
    const tab = app.getAppMetrics().find(p => p.type === "Tab");
    if (tab) { st.gameCpu = Math.round(tab.cpu.percentCPUUsage); st.gameMemMB = Math.round((tab.memory.workingSetSize || 0) / 1024); }
  } catch {}
  const pid = ai.proc && ai.proc.pid;
  if (pid && process.platform !== "win32") {
    const [cpu, rss] = (await sh("ps", ["-o", "%cpu=,rss=", "-p", String(pid)])).split(/\s+/);
    if (cpu) { st.engineCpu = Math.round(+cpu); st.engineMemGB = +(+rss / 1048576).toFixed(2); }
  }
  if (process.platform === "darwin") {
    const m = /used = ([\d.]+)M/.exec(await sh("sysctl", ["-n", "vm.swapusage"]));
    if (m) st.swapUsedMB = Math.round(+m[1]);
    const pr = /System-wide memory free percentage: (\d+)%/.exec(await sh("memory_pressure", ["-Q"]));
    if (pr) st.memFreePct = +pr[1];
    const th = await sh("pmset", ["-g", "therm"]);
    const sp = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(th); if (sp) st.cpuSpeedLimit = +sp[1];
    const batt = await sh("pmset", ["-g", "batt"]);
    st.power = /AC Power/.test(batt) ? "plugged in" : /Battery Power/.test(batt) ? "battery" : "";
  }
  return st;
}

// Every couple of minutes (every minute during a test run), write down how hard each part of the
// game is working. A runaway process shows up here as a big number.
function cpuCheck() {
  try {
    const m = app.getAppMetrics().map(p => `${p.type === "Tab" ? "game page" : p.type.toLowerCase()} ${Math.round(p.cpu.percentCPUUsage)}%`);
    const pid = ai.proc && ai.proc.pid;
    if (!pid || process.platform === "win32") return note("CPU: " + m.join(", "));
    execFile("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], (err, out) => {
      const [cpu, rss] = String(out || "").trim().split(/\s+/);
      // macOS keeps "free" memory near zero on purpose (it caches files), so the honest number there
      // is memory_pressure's free percentage, plus how much has been pushed out to swap.
      const run = (c, a) => { try { return require("child_process").execFileSync(c, a, { timeout: 2000 }).toString(); } catch { return ""; } };
      const mac = process.platform === "darwin";
      const swap = mac ? /used = ([\d.]+)M/.exec(run("sysctl", ["-n", "vm.swapusage"]))?.[1] : null;
      const freePct = mac ? /System-wide memory free percentage: (\d+)%/.exec(run("memory_pressure", ["-Q"]))?.[1] : null;
      note(`CPU: ${m.join(", ")}${cpu ? `, AI engine ${Math.round(+cpu)}% using ${(+rss / 1048576).toFixed(1)} GB` : ""} · ${freePct ? `memory ${freePct}% free` : `free memory ${(os.freemem() / 2 ** 30).toFixed(1)} GB`}${swap ? ` · swap used ${Math.round(+swap)} MB` : ""}`);
    });
  } catch {}
}
let cpuTimer = null;
function scheduleCpuCheck() { clearTimeout(cpuTimer); cpuTimer = setTimeout(() => { cpuCheck(); scheduleCpuCheck(); }, awakeId !== null ? 60000 : 120000); }

app.whenReady().then(() => {
  createWindow();
  scheduleCpuCheck();
  powerMonitor.on("suspend", () => note("Computer went to sleep."));
  powerMonitor.on("resume", () => note("Computer woke up."));
  app.on("child-process-gone", (_e, d) => note(`A helper process stopped: ${d.type} (${d.reason}).`));
});
app.on("window-all-closed", () => { note("Window closed."); app.quit(); });
let quitting = false;
app.on("before-quit", e => {
  if (quitting) return;
  note("Quitting.");
  e.preventDefault(); quitting = true;
  stayAwake(false);
  ai.cancelDownload();
  ai.cancelStart = true;
  ai.stop().finally(() => app.quit());
});
