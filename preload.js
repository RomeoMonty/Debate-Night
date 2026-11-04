// The only bridge between the game page and the computer: model downloads and the local AI.
const { contextBridge, ipcRenderer } = require("electron");

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (r.ok) return r.value;
  throw r.error;
};

// Watchdog: if the main app ever dies, this window must not linger on its own burning CPU.
// When the app stops answering for 30 seconds straight, the window shuts itself down.
let missed = 0;
setInterval(() => {
  const t = setTimeout(() => { if (++missed >= 3) { try { process.crash(); } catch (e) {} } }, 10000);
  ipcRenderer.invoke("app:ping").then(() => { clearTimeout(t); missed = 0; }).catch(() => {});
}, 10000);

contextBridge.exposeInMainWorld("native", {
  info: () => call("ai:info"),
  download: id => call("ai:download", id),
  cancelDownload: () => call("ai:cancel"),
  start: id => call("ai:start", id),
  stop: () => call("ai:stop"),
  degrade: id => call("ai:degrade", id),
  remove: id => call("ai:remove", id),
  resetSpeed: id => call("ai:resetSpeed", id),
  openExternal: url => call("app:open", url),
  log: () => call("app:log"),
  openLog: () => call("app:openLog"),
  awake: on => call("app:awake", on),
  note: line => call("app:note", line),
  onEvent: fn => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on("ai:event", h);
    return () => ipcRenderer.removeListener("ai:event", h);
  }
});
