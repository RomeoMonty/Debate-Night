// Runs the game's AI on the player's computer: downloads a model once, then starts llama.cpp's
// llama-server on a private local port. Plain Node, so it can be tested without Electron.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const MODELS = require("./models");

const HF = process.env.DEBATE_HF_BASE || "https://huggingface.co";

class AIService {
  /**
   * @param {object} o
   * @param {string} o.modelsDir  where downloaded models live
   * @param {string} o.serverPath full path to the llama-server binary
   * @param {(e:object)=>void} [o.onEvent] progress / status / exit events for the window
   * @param {(line:string)=>void} [o.note] writes a line to the game's log file
   */
  constructor({ modelsDir, serverPath, onEvent, note }) {
    this.modelsDir = modelsDir;
    this.serverPath = serverPath;
    this.onEvent = onEvent || (() => {});
    this.note = note || (() => {});
    this.manifestPath = path.join(modelsDir, "manifest.json");
    this.proc = null;
    this.server = null; // {port, key, modelId, ctx}
    this.download = null; // {id, abort}
    this.log = [];
  }

  /* ---------- catalog ---------- */
  totalRamGB() { return Math.round(os.totalmem() / 2 ** 30); }
  recommendedId() {
    const ram = os.totalmem() / 2 ** 30;
    return ram >= 15.5 ? "max" : ram >= 7.5 ? "standard" : "pocket";
  }
  model(id) {
    const m = MODELS.find(x => x.id === id);
    if (!m) throw Object.assign(new Error("Unknown model " + id), { code: "bad_model" });
    return m;
  }
  async manifest() {
    try { return JSON.parse(await fsp.readFile(this.manifestPath, "utf8")); } catch { return {}; }
  }
  async saveManifest(m) {
    await fsp.mkdir(this.modelsDir, { recursive: true });
    await fsp.writeFile(this.manifestPath, JSON.stringify(m, null, 2));
  }
  async isDownloaded(id) {
    const m = (await this.manifest())[id];
    if (!m) return false;
    try { return (await fsp.stat(path.join(this.modelsDir, m.file))).size === m.size; } catch { return false; }
  }
  async info() {
    const models = [];
    for (const m of MODELS) {
      models.push({ id: m.id, name: m.name, label: m.label, sizeGB: m.sizeGB, minRamGB: m.minRamGB, ctx: m.ctx, note: m.note,
        downloaded: await this.isDownloaded(m.id) });
    }
    return { platform: process.platform, arch: process.arch, ramGB: this.totalRamGB(), recommended: this.recommendedId(),
      models, running: this.server ? { modelId: this.server.modelId } : null };
  }

  /* ---------- download ---------- */
  // Find the actual file in the repo (falls back to the expected name if the listing is unavailable).
  async resolveFile(m) {
    try {
      const r = await fetch(`${HF}/api/models/${m.repo}`, { headers: { "User-Agent": "DebateNight2028" } });
      if (r.ok) {
        const j = await r.json();
        const files = (j.siblings || []).map(s => s.rfilename).filter(f => !f.includes("/"));
        if (files.includes(m.file)) return m.file;
        const hit = files.find(f => f.toLowerCase().endsWith(`-${m.quant.toLowerCase()}.gguf`));
        if (hit) return hit;
      }
    } catch { /* offline listing: use the expected name */ }
    return m.file;
  }

  async startDownload(id) {
    if (this.download && this.download.id === id) return this.download.promise; // e.g. the window was reloaded mid-download
    if (this.download) throw Object.assign(new Error("Another model is still downloading. Wait for it to finish or pause it first."), { code: "busy" });
    const promise = this._download(id);
    this.download.promise = promise;
    return promise;
  }

  async _download(id) {
    const m = this.model(id);
    const ctl = new AbortController();
    this.download = { id, abort: () => ctl.abort(), promise: this.download && this.download.promise };
    if (await this.isDownloaded(id)) { this.download = null; return { ok: true, already: true }; }
    try {
      await fsp.mkdir(this.modelsDir, { recursive: true });
      const file = await this.resolveFile(m);
      const dest = path.join(this.modelsDir, file);
      const part = dest + ".part";
      let have = 0;
      try { have = (await fsp.stat(part)).size; } catch {}

      const url = `${HF}/${m.repo}/resolve/main/${encodeURIComponent(file)}?download=true`;
      const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ctl.signal, redirect: "follow" });
      if (res.status === 416) { have = 0; await fsp.rm(part, { force: true }); return this._retryFresh(id); }
      if (!res.ok) throw Object.assign(new Error(`Download failed (HTTP ${res.status}).`), { code: "download_http", status: res.status });
      if (have && res.status !== 206) { have = 0; } // server ignored the resume: start over
      const len = Number(res.headers.get("content-length") || 0);
      const total = have + len;
      await this.ensureSpace(total - have);

      const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
      let got = have, last = 0, lastBytes = have, t0 = Date.now();
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(value)) await new Promise(r => out.once("drain", r));
          got += value.length;
          const now = Date.now();
          if (now - last > 250) {
            const mbps = ((got - lastBytes) / 2 ** 20) / Math.max(0.001, (now - (last || t0)) / 1000);
            last = now; lastBytes = got;
            this.onEvent({ type: "download", id, received: got, total, mbps });
          }
        }
      } finally {
        await new Promise(r => out.end(r));
      }
      if (total && got !== total) throw Object.assign(new Error("The download ended early."), { code: "download_short" });
      await fsp.rename(part, dest);
      const man = await this.manifest();
      man[id] = { file, size: got, repo: m.repo };
      await this.saveManifest(man);
      this.onEvent({ type: "download", id, received: got, total: got, done: true });
      return { ok: true };
    } catch (e) {
      if (ctl.signal.aborted) throw Object.assign(new Error("Download paused."), { code: "cancelled" });
      throw e;
    } finally {
      this.download = null;
    }
  }
  async _retryFresh(id) {
    const joined = this.download && this.download.promise;
    this.download = null;
    const r = this._download(id);
    if (this.download) this.download.promise = joined;
    return r;
  }
  cancelDownload() { if (this.download) this.download.abort(); }

  async ensureSpace(bytes) {
    try {
      const s = await fsp.statfs(this.modelsDir);
      const free = s.bavail * s.bsize;
      if (free < bytes + 512 * 2 ** 20) {
        throw Object.assign(new Error(`Not enough disk space: the model needs ${(bytes / 2 ** 30).toFixed(1)} GB and only ${(free / 2 ** 30).toFixed(1)} GB is free.`), { code: "no_space" });
      }
    } catch (e) { if (e.code === "no_space") throw e; /* statfs unsupported: carry on */ }
  }

  async removeModel(id) {
    if (this.server && this.server.modelId === id) await this.stop();
    const man = await this.manifest();
    if (man[id]) { await fsp.rm(path.join(this.modelsDir, man[id].file), { force: true }); delete man[id]; await this.saveManifest(man); }
    return { ok: true };
  }

  /* ---------- server ---------- */
  freePort() {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
  }

  // Fastest settings first; if this machine can't take them, fall back to the most compatible ones.
  // Qwen 3.5 keeps most of its memory in a small fixed-size state, so the attention cache stays at
  // full precision (quantizing it saves little and can garble these models).
  // Multi-token prediction is left off: on Apple's chips it measured slower, not faster, for models
  // this size (llama.cpp #23752), and newer model uploads would otherwise switch it on silently.
  argSets(m) {
    const sets = [];
    // On Macs the model's memory is locked in place, so when other apps crowd the memory, macOS
    // swaps them out instead of the AI (a test on an 8 GB Mac with 4 GB of swap in use ran at
    // half speed because the model kept being paged out). If locking isn't allowed, the engine
    // just carries on without it.
    const lock = process.platform === "darwin" ? ["--mlock"] : [];
    sets.push(["-ngl", "all", "-fa", "on", ...lock]);
    sets.push(["-ngl", "all", "-fa", "auto", ...lock]);
    sets.push(["-ngl", "0", "-fa", "auto"]); // no usable graphics chip: run on the processor
    return sets;
  }
  // Apple Silicon always has a graphics chip the engine can use, so the slow processor-only
  // mode is never right there; it can only be a leftover from a one-off failure.
  lowestSet(m) { const n = this.argSets(m).length; return process.platform === "darwin" && process.arch === "arm64" ? n - 2 : n - 1; }

  // Starts, restarts and stops run one at a time, so two engines can never be launching at once.
  locked(fn) { const run = () => fn(); const p = (this.lock || Promise.resolve()).then(run, run); this.lock = p.catch(() => {}); return p; }
  start(id) { return this.locked(() => this._start(id)); }
  stopSafely() { return this.locked(() => this.stop()); }

  async _start(id) {
    this.cancelStart = false;
    if (this.server && this.server.modelId === id && this.proc) return this.publicServer();
    await this.stop();
    const m = this.model(id);
    const man = (await this.manifest())[id];
    if (!man || !(await this.isDownloaded(id))) throw Object.assign(new Error("That model isn't downloaded yet."), { code: "not_downloaded" });
    if (!fs.existsSync(this.serverPath)) throw Object.assign(new Error("The AI engine is missing from this copy of the game: " + this.serverPath), { code: "no_engine" });
    const modelPath = path.join(this.modelsDir, man.file);
    const sets = this.argSets(m);
    // Older versions also remembered slow-downs caused by one-off hiccups (like the computer
    // sleeping). Forget those once, so the fastest settings get a fresh try.
    if (man.settingsV !== 3) {
      const all = await this.manifest();
      if (all[id]) { if (all[id].settings) this.note(`Clearing an old slow-down (settings level ${all[id].settings}) for a fresh try at full speed.`); all[id].settings = 0; all[id].settingsV = 3; await this.saveManifest(all); }
      man.settings = 0;
    }
    // Start from the settings that worked last time, so a fallback is only paid for once.
    const first = Math.min(Math.max(0, man.settings || 0), this.lowestSet(m));
    let lastErr = null;
    for (let i = first; i < sets.length; i++) {
      try {
        await this.launch(m, modelPath, sets[i]);
        this.server.settingsIndex = i;
        this.note(`AI started: ${m.id} with ${sets[i].join(" ")}${i > first ? " (faster settings failed to start)" : ""}`);
        if (man.settings !== i) { const all = await this.manifest(); if (all[id]) { all[id].settings = i; await this.saveManifest(all); } }
        return this.publicServer();
      } catch (e) {
        this.note(`AI failed to start with ${sets[i].join(" ")}: ${e.code || ""} ${e.message || e} | ${(e.log || []).slice(-4).join(" / ")}`);
        lastErr = e; await this.stop();
        if (this.cancelStart) throw Object.assign(new Error("Stopped."), { code: "cancelled" });
        // Out of memory on the graphics chip: only the processor fallback can still help, and not on
        // Macs, where both share the same memory.
        if (e.code === "out_of_memory") { if (process.platform === "darwin") break; i = sets.length - 2; }
      }
    }
    throw lastErr;
  }

  // The running AI stopped answering. Usually that's a one-off (the computer slept, a hiccup), so:
  // if it's actually still fine, carry on; otherwise restart it with the same settings, and only
  // step down to safer settings if that fails too. Nothing here is remembered for next time, so
  // one bad moment can never leave the game permanently slow.
  degrade(id) { return this.locked(() => this._degrade(id)); }
  async _degrade(id) {
    const m = this.model(id), sets = this.argSets(m);
    const cur = this.server && this.server.modelId === id ? this.server.settingsIndex : null;
    if (this.server && this.proc && await this.healthy()) { this.note("AI hiccup: it was still running, so it was kept as is."); return this.publicServer(); }
    this.note(`AI stopped answering (${this.log.slice(-3).join(" / ") || "no message"}). Restarting it.`);
    const man = (await this.manifest())[id];
    if (!man) throw Object.assign(new Error("That model isn't downloaded yet."), { code: "not_downloaded" });
    await this.stop();
    const modelPath = path.join(this.modelsDir, man.file);
    let lastErr = null;
    for (let i = cur ?? (man.settings || 0); i <= this.lowestSet(m); i++) {
      try {
        await this.launch(m, modelPath, sets[i]);
        this.server.settingsIndex = i;
        this.note(`AI restarted with ${sets[i].join(" ")} for this session.`);
        return this.publicServer();
      } catch (e) { lastErr = e; this.note(`Restart failed with ${sets[i].join(" ")}: ${e.code || ""} ${e.message || e}`); await this.stop(); }
    }
    throw lastErr || Object.assign(new Error("The AI couldn't restart."), { code: "server_exit" });
  }
  async healthy() {
    const s = this.server;
    try { const r = await fetch(`http://127.0.0.1:${s.port}/health`, { headers: { Authorization: `Bearer ${s.key}` }, signal: AbortSignal.timeout(3000) }); return r.ok; }
    catch { return false; }
  }
  // "Try the fast settings again": forget any fallback and restart from the fastest settings.
  async resetSpeed(id) {
    const all = await this.manifest();
    if (all[id]) { all[id].settings = 0; await this.saveManifest(all); }
    this.note("Speed settings reset to the fastest.");
    return this.locked(async () => { await this.stop(); return this._start(id); });
  }

  async launch(m, modelPath, extra) {
    const port = await this.freePort();
    const key = crypto.randomBytes(16).toString("hex"); // only this game can talk to its AI
    const args = [
      "-m", modelPath, "--host", "127.0.0.1", "--port", String(port),
      "-c", String(m.ctx), "-np", "1",
      "--reasoning-budget", "0", "--jinja",
      // Saved snapshots of the AI's memory let each call skip re-reading the briefing and the debate
      // so far (the engine takes one at the start of each new message). The separate whole-prompt
      // cache is off: there is only ever one conversation, and it would copy ~130 MB per call.
      "-ctxcp", "8", "-cram", "0",
      "--no-webui", "--api-key", key, ...extra
    ];
    this.log = [];
    this.onEvent({ type: "status", text: "Starting the AI…" });
    // Keep the model in fast graphics memory between turns; by default macOS lets it go after
    // three idle minutes, which made the first answer after a long pause slow.
    const env = { ...process.env, GGML_METAL_RESIDENCY_KEEP_ALIVE_S: "3600" };
    const proc = spawn(this.serverPath, args, { cwd: path.dirname(this.serverPath), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    this.proc = proc;
    this.writePid(proc.pid);
    const keep = buf => { for (const line of String(buf).split(/\r?\n/)) if (line.trim()) { this.log.push(line); if (this.log.length > 60) this.log.shift(); } };
    proc.stdout.on("data", keep); proc.stderr.on("data", keep);
    let exited = null;
    proc.on("exit", (code, sig) => {
      exited = { code, sig };
      if (this.proc === proc) {
        this.proc = null;
        const wasReady = !!this.server;
        this.server = null;
        if (wasReady) {
          this.note(`AI engine exited unexpectedly (code ${code}, signal ${sig}). Last output: ${this.log.slice(-6).join(" / ")}`);
          this.onEvent({ type: "exit", code, signal: sig, memory: looksLikeMemory(this.log), log: this.log.slice(-12) });
        }
      }
    });
    proc.on("error", e => { exited = { error: e }; keep(e.message); });

    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (exited) {
        const memory = looksLikeMemory(this.log);
        throw Object.assign(new Error(memory ? "The AI ran out of memory while starting." : "The AI engine stopped while starting."),
          { code: memory ? "out_of_memory" : "server_exit", log: this.log.slice(-12) });
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${key}` } });
        if (r.ok) { this.server = { port, key, modelId: m.id, ctx: m.ctx, args: extra.join(" ") }; return; }
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 300));
    }
    throw Object.assign(new Error("The AI took too long to start."), { code: "start_timeout", log: this.log.slice(-12) });
  }

  publicServer() {
    const s = this.server;
    return { port: s.port, key: s.key, modelId: s.modelId, ctx: s.ctx, settings: s.args, canDegrade: true,
      mode: /-ngl 0\b/.test(s.args) ? "processor" : "graphics", fastest: s.settingsIndex === 0 };
  }

  // If the game ever crashes, its AI engine could be left running and holding gigabytes of memory.
  // The engine's process id is written down so the next launch can clean it up.
  get pidFile() { return path.join(this.modelsDir, "engine.pid"); }
  writePid(pid) { try { fs.mkdirSync(this.modelsDir, { recursive: true }); fs.writeFileSync(this.pidFile, String(pid)); } catch {} }
  killStale() {
    let pid = 0;
    try { pid = Number(fs.readFileSync(this.pidFile, "utf8")); } catch { return false; }
    try { fs.rmSync(this.pidFile, { force: true }); } catch {}
    if (!pid || pid === process.pid) return false;
    try { process.kill(pid, 0); } catch { return false; } // not running
    if (!isOurEngine(pid)) return false;                  // the number was reused by something else
    try { process.kill(pid); return true; } catch { return false; }
  }
  killNow() { const p = this.proc; if (p && p.exitCode === null) { try { p.kill(); } catch {} } }

  async stop() {
    const p = this.proc;
    this.proc = null; this.server = null;
    try { fs.rmSync(this.pidFile, { force: true }); } catch {}
    if (!p || p.exitCode !== null) return;
    await new Promise(resolve => {
      const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} resolve(); }, 4000);
      p.once("exit", () => { clearTimeout(t); resolve(); });
      try { p.kill(); } catch { clearTimeout(t); resolve(); }
    });
  }
}

function isOurEngine(pid) {
  try {
    const { execFileSync } = require("child_process");
    const out = process.platform === "win32"
      ? execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })
      : execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return /llama-server/i.test(out);
  } catch { return false; }
}

function looksLikeMemory(lines) {
  return /out of memory|failed to allocate|unable to allocate|insufficient memory|alloc.*fail|kIOGPU|cudaMalloc|ErrorOutOfDeviceMemory|std::bad_alloc/i.test(lines.join("\n"));
}

module.exports = { AIService, MODELS };
