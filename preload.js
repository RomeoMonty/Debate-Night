// The only bridge between the game page and the computer: model downloads and the local AI.
const { contextBridge, ipcRenderer } = require("electron");

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (r.ok) return r.value;
  throw r.error;
};

contextBridge.exposeInMainWorld("native", {
  info: () => call("ai:info"),
  download: id => call("ai:download", id),
  cancelDownload: () => call("ai:cancel"),
  start: id => call("ai:start", id),
  stop: () => call("ai:stop"),
  degrade: id => call("ai:degrade", id),
  remove: id => call("ai:remove", id),
  openExternal: url => call("app:open", url),
  onEvent: fn => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on("ai:event", h);
    return () => ipcRenderer.removeListener("ai:event", h);
  }
});
