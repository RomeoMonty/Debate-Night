// Runs the game against the real AI on a build machine, with no window: starts llama-server with the
// same settings the desktop app uses, opens game/index.html in a hidden browser with a stand-in for
// the app's bridge, then runs the AI lab and/or test debates and saves their reports.
//
//   MODE=lab|debates|both  PERSONAS=quick  MODEL_PATH=…/model.gguf  SERVER_BIN=…/llama-server
//   OUT=dir  PW_DIR=dir-with-playwright (optional)  node scripts/cloud-lab.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const MODE = env.MODE || "lab";
const PERSONAS = (env.PERSONAS || "quick").split(",").map(s => s.trim()).filter(Boolean);
const MODEL_ID = env.MODEL_ID || "standard";
const MODEL_PATH = env.MODEL_PATH;
const SERVER_BIN = env.SERVER_BIN || path.join(root, "resources", process.platform === "darwin" ? "llama-arm64" : "llama-x64", "llama-server");
// Several build machines can share one run: SHARD/SHARDS splits the debates between them, and TAG
// keeps each machine's files apart (e.g. "lab", "d2of6").
const SHARD = Number(env.SHARD || 0), SHARDS = Math.max(1, Number(env.SHARDS || 1));
const OUT = path.resolve(env.OUT || "lab-out");
const CTX = Number(env.CTX || 12288);
const PORT = Number(env.PORT || 18600);
const HOURS = Number(env.HOURS || 5.5);
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + (env.TAG ? "-" + env.TAG : "");
fs.mkdirSync(OUT, { recursive: true });

const req = createRequire(env.PW_DIR ? path.join(path.resolve(env.PW_DIR), "x.js") : import.meta.url);
const { chromium } = req("playwright");

// On the build machine, each report is pushed to the lab-reports branch as soon as it's saved, so a
// run that dies later (the machine can shut down) still leaves what it finished.
function publish(){
  if (!env.PUBLISH_DIR || !env.GH_TOKEN || !env.GITHUB_REPOSITORY) return;
  const rep = path.join(os.tmpdir(), "lab-publish"), url = `https://x-access-token:${env.GH_TOKEN}@github.com/${env.GITHUB_REPOSITORY}.git`;
  const run = c => execSync(c, { cwd: rep, stdio: "ignore" });
  try {
    fs.rmSync(rep, { recursive: true, force: true });
    try { execSync(`git clone -q --depth 1 --branch lab-reports "${url}" "${rep}"`, { stdio: "ignore" }); }
    catch(e){ fs.mkdirSync(rep, { recursive: true }); run("git init -q -b lab-reports"); run(`git remote add origin "${url}"`);
      fs.writeFileSync(path.join(rep, "README.md"), "# AI lab reports\n\nWritten by the \"AI lab (real model)\" workflow. Each folder under runs/ is one run.\n"); }
    const dest = path.join(rep, env.PUBLISH_DIR); fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(OUT)) fs.copyFileSync(path.join(OUT, f), path.join(dest, f));
    run("git add -A");
    try { run("git diff --cached --quiet"); return; } catch(e){}
    run(`git -c user.name="AI lab" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "Lab ${env.PUBLISH_DIR}: progress"`);
    // Other machines in the same run push too; each writes its own files, so a rebase never clashes.
    for (let i = 0; i < 8; i++){
      try { run("git push -q origin HEAD:lab-reports"); return; }
      catch(e){ try { run("git pull -q --rebase origin lab-reports"); } catch(x){} execSync(`sleep ${1 + Math.floor(Math.random() * 4)}`); }
    }
    throw new Error("push kept failing");
  } catch(e){ console.log("(couldn't publish progress yet)"); }
}
function progressFile(){ fs.writeFileSync(path.join(OUT, `${stamp}-run.md`), `# Cloud lab run (in progress)\n\n${machine()}\n\n## Steps\n\n${notes.map(n => "    " + n).join("\n")}\n`); fs.writeFileSync(path.join(OUT, `${stamp}-engine.log`), serverLog.slice(-3000).join("\n")); }

const notes = [];
const note = s => { const line = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(line); notes.push(line); };

// ---- The engine, with the desktop app's settings (ai-service.js) ----
const serverLog = [];
let server = null, serverSettings = "";
const base = ["-m", MODEL_PATH, "--host", "127.0.0.1", "--port", String(PORT), "-c", String(CTX), "-np", "1",
  "--reasoning-budget", "0", "--jinja", "-ctxcp", "8", "-cram", "0", "--no-webui"];
// The memory lock the app uses is skipped on build machines (NO_MLOCK=1): a 7 GB virtual Mac shut
// down with 3 GB of model locked in place.
const sets = process.platform === "darwin"
  ? [...(env.NO_MLOCK ? [] : [["-ngl", "all", "-fa", "on", "-lm", "mmap+mlock"]]), ["-ngl", "all", "-fa", "on"], ["-ngl", "all", "-fa", "auto"], ["-ngl", "0", "-fa", "auto"]]
  : [["-ngl", "all", "-fa", "auto"], ["-ngl", "0", "-fa", "auto"]];

async function healthy(){ try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); return r.ok; } catch(e){ return false; } }
async function startServer(){
  for (const extra of sets){
    note(`Starting the engine: ${extra.join(" ")}`);
    const proc = spawn(SERVER_BIN, [...base, ...extra], { cwd: path.dirname(SERVER_BIN), stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, GGML_METAL_RESIDENCY_KEEP_ALIVE_S: "3600", LD_LIBRARY_PATH: [path.dirname(SERVER_BIN), env.LD_LIBRARY_PATH].filter(Boolean).join(":") } });
    let exited = false;
    proc.on("exit", c => { exited = true; serverLog.push(`[engine exited with ${c}]`); });
    for (const s of [proc.stdout, proc.stderr]) s.on("data", d => { for (const l of String(d).split("\n")) if (l.trim()) { serverLog.push(l); if (serverLog.length > 20000) serverLog.splice(0, 5000); } });
    const t0 = Date.now();
    while (!exited && Date.now() - t0 < 10 * 60e3){ if (await healthy()) break; await new Promise(r => setTimeout(r, 1000)); }
    if (!exited && await healthy()){ server = proc; serverSettings = extra.join(" "); note(`Engine ready in ${Math.round((Date.now() - t0) / 1000)} s`); return; }
    try { proc.kill("SIGKILL"); } catch(e){}
    note("That didn't start; trying safer settings.");
  }
  throw new Error("The AI engine would not start with any settings.");
}

function sh(cmd){ try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch(e){ return ""; } }
function stats(){
  const out = { totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1), freeMemGB: +(os.freemem() / 2 ** 30).toFixed(2), load1: +os.loadavg()[0].toFixed(2), power: "plugged in", lowPower: false };
  const ps = server ? sh(`ps -o %cpu=,rss= -p ${server.pid}`).split(/\s+/) : [];
  if (ps.length >= 2){ out.engineCpu = Math.round(+ps[0]); out.engineMemGB = +(+ps[1] / 2 ** 20).toFixed(2); }
  const self = sh(`ps -o %cpu=,rss= -p ${process.pid}`).split(/\s+/);
  if (self.length >= 2){ out.gameCpu = Math.round(+self[0]); out.gameMemMB = Math.round(+self[1] / 1024); }
  if (process.platform === "darwin"){
    const sw = /used = ([\d.]+)M/.exec(sh("sysctl vm.swapusage")); if (sw) out.swapUsedMB = Math.round(+sw[1]);
    const mp = /free percentage: (\d+)%/.exec(sh("memory_pressure -Q")); if (mp) out.memFreePct = +mp[1];
  }
  return out;
}

// What this machine is, and whether the AI really got the graphics chip.
function machine(){
  const log = serverLog.join("\n");
  const gpu = /offloaded (\d+)\/(\d+) layers to GPU/.exec(log);
  const metal = /\b(Metal|MTL|ggml_metal)\b/i.test(log);
  return [
    `Machine: ${process.platform} ${os.arch()}, ${os.cpus().length} cores (${(os.cpus()[0] || {}).model || "?"}), ${(os.totalmem() / 2 ** 30).toFixed(1)} GB`,
    `Engine: ${serverSettings} · ${gpu ? `${gpu[1]}/${gpu[2]} layers on the graphics chip` : metal ? "Metal mentioned in the log" : "no graphics chip found in the log (processor only)"}`,
    `Model: ${path.basename(MODEL_PATH || "?")} · memory window ${CTX}`
  ].join("\n");
}

const MODELS = [
  { id: "pocket", name: "Pocket", label: "Qwen 3.5 2B", sizeGB: 1.3, minRamGB: 4, ctx: CTX, note: "", downloaded: true },
  { id: "standard", name: "Standard", label: "Qwen 3.5 4B", sizeGB: 3.0, minRamGB: 8, ctx: CTX, note: "", downloaded: true },
  { id: "max", name: "Max", label: "Qwen 3.5 9B", sizeGB: 6.2, minRamGB: 16, ctx: CTX, note: "", downloaded: true }
];

async function main(){
  await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(`page error: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`); });
  await page.exposeFunction("__labStats", () => stats());
  await page.exposeFunction("__labLog", n => serverLog.slice(-(n || 200)).join("\n"));
  await page.addInitScript(({ models, port, modelId }) => {
    const info = { platform: "darwin", arch: "arm64", ramGB: 8, recommended: modelId, running: null, models };
    const start = async id => ({ port, key: "", modelId: id, ctx: (models.find(m => m.id === id) || models[1]).ctx, mode: "gpu", fastest: true, settings: "cloud lab" });
    window.native = {
      info: async () => info, download: async () => ({ ok: true }), cancelDownload: async () => {},
      start, degrade: start, resetSpeed: async () => ({}), stop: async () => {}, remove: async () => {},
      openExternal: async () => {}, onEvent: () => () => {}, openLog: async () => {}, awake: async () => true, note: async () => {},
      log: n => window.__labLog(n), stats: () => window.__labStats()
    };
    try { localStorage.setItem("debate2028.voices", JSON.stringify({ on: false })); } catch(e){}
  }, { models: MODELS, port: PORT, modelId: MODEL_ID });
  await page.goto("file://" + path.join(root, "game", "index.html"));
  await page.waitForSelector(`#cache-${MODELS.find(m => m.id === MODEL_ID).name}`, { timeout: 60e3 });
  await page.evaluate(id => { const r = document.querySelector(`input[name=model][value=${id}]`); if (r) r.checked = true; }, MODEL_ID).catch(() => {});
  await page.click("#startBtn");
  await page.waitForSelector("#answerBox", { timeout: 30 * 60e3 });
  note("The debate started; the AI is answering.");
  progressFile(); publish();
  const deadline = Date.now() + HOURS * 3600e3;
  const saved = [];
  let emptyShard = false;

  if (MODE === "lab" || MODE === "both"){
    note("Running the AI lab…");
    await page.click("#gearMenu summary"); await page.click("#gearMenu [data-panel=p-hood]");
    const dl = page.waitForEvent("download", { timeout: Math.max(60e3, deadline - Date.now()) });
    await page.click("#testBox .btn:has-text('Run the AI lab')");
    const d = await dl; const f = path.join(OUT, `${stamp}-lab.md`); await d.saveAs(f); saved.push(f);
    note(`Lab report saved: ${path.basename(f)}`);
    progressFile(); publish();
    await page.keyboard.press("Escape").catch(() => {});
  }
  if (MODE === "debates" || MODE === "both"){
    note(`Running test debates: ${PERSONAS.join(", ")}…`);
    const ids = await page.evaluate(([list, shard, shards]) => {
      const expand = id => { const p = TEST_SETS[id]; return p && p.ids ? p.ids : [id]; };
      const all = list.flatMap(expand).filter(id => TEST_PERSONAS[id]).filter((id, i) => i % shards === shard);
      if (all.length) TestRun.begin(all); return all;
    }, [PERSONAS, SHARD, SHARDS]);
    note(`${ids.length} debate(s)${SHARDS > 1 ? ` (machine ${SHARD + 1} of ${SHARDS})` : ""}: ${ids.join(", ")}`);
    if (!ids.length) emptyShard = true;
    let last = -1;
    while (Date.now() < deadline){
      const st = await page.evaluate(() => ({ active: !!TestRun.active, done: TestRun.reports.length }));
      if (st.done !== last){
        note(`${st.done}/${ids.length} debates done`); last = st.done;
        // Each finished debate's report goes up right away, too.
        if (st.done){ try { const dl = page.waitForEvent("download", { timeout: 60e3 }); await page.evaluate(() => TestRun.download()); await (await dl).saveAs(path.join(OUT, `${stamp}-debates.md`)); } catch(e){} }
        progressFile(); publish();
      }
      if (!st.active && st.done >= ids.length) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    if (emptyShard){}
    else if (await page.evaluate(() => TestRun.reports.length)){
      const dl = page.waitForEvent("download", { timeout: 120e3 });
      await page.evaluate(() => TestRun.download());
      const d = await dl; const f = path.join(OUT, `${stamp}-debates.md`); await d.saveAs(f); saved.push(f);
      note(`Debate report saved: ${path.basename(f)}`);
    } else note("No debate finished in time.");
  }

  const head = `# Cloud lab run\n\n${machine()}\nMode: ${MODE}${MODE !== "lab" ? ` · players: ${PERSONAS.join(", ")}` : ""}\n${env.NOTE ? `Checking: ${env.NOTE}\n` : ""}\n## Steps\n\n${notes.map(n => "    " + n).join("\n")}\n\n## Errors in the game page\n\n${errors.length ? errors.slice(0, 200).map(e => "- " + e).join("\n") : "None."}\n`;
  fs.writeFileSync(path.join(OUT, `${stamp}-run.md`), head);
  fs.writeFileSync(path.join(OUT, `${stamp}-engine.log`), serverLog.slice(-3000).join("\n"));
  publish();
  await browser.close();
  return emptyShard && !saved.length ? ["(no debates for this machine)"] : saved;
}

main().then(saved => { console.log("Saved:", saved.join(", ") || "(nothing)"); if (server) server.kill(); process.exit(saved.length ? 0 : 1); })
  .catch(e => {
    console.error(e);
    try { fs.writeFileSync(path.join(OUT, `${stamp}-run.md`), `# Cloud lab run FAILED\n\n${machine()}\n\n${String(e && e.stack || e)}\n\n## Steps\n\n${notes.map(n => "    " + n).join("\n")}\n`);
      fs.writeFileSync(path.join(OUT, `${stamp}-engine.log`), serverLog.slice(-3000).join("\n")); } catch(x){}
    if (server) server.kill(); process.exit(1);
  });
