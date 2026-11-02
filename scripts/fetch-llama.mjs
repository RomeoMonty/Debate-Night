// Downloads the prebuilt llama.cpp server for a platform and keeps only what the game needs
// (llama-server plus its libraries) in resources/llama-<arch>/.
// Usage: node scripts/fetch-llama.mjs <mac-arm64|mac-x64|win-x64|linux-x64>
// Needs the GitHub CLI (`gh`), which GitHub's build machines already have.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TAG = process.env.LLAMA_TAG || "b11600";
const target = process.argv[2];
const plans = {
  "mac-arm64": { arch: "arm64", assets: [`llama-${TAG}-bin-macos-arm64.tar.gz`] },
  "mac-x64":   { arch: "x64",   assets: [`llama-${TAG}-bin-macos-x64.tar.gz`] },
  "linux-x64": { arch: "x64",   assets: [`llama-${TAG}-bin-ubuntu-x64.tar.gz`] },
  // Windows: the CPU package carries llama-server.exe; the Vulkan package adds GPU acceleration.
  "win-x64":   { arch: "x64",   assets: [`llama-${TAG}-bin-win-cpu-x64.zip`, `llama-${TAG}-bin-win-vulkan-x64.zip`], optional: [1] }
};
const plan = plans[target];
if (!plan) { console.error("Usage: node scripts/fetch-llama.mjs <" + Object.keys(plans).join("|") + ">"); process.exit(1); }

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "llama-"));
const out = path.join(root, "resources", `llama-${plan.arch}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

plan.assets.forEach((asset, i) => {
  try {
    if (process.env.LLAMA_ARCHIVE_DIR) fs.copyFileSync(path.join(process.env.LLAMA_ARCHIVE_DIR, asset), path.join(work, asset)); // offline testing
    else execFileSync("gh", ["release", "download", TAG, "-R", "ggml-org/llama.cpp", "-p", asset, "-D", work, "--clobber"], { stdio: "inherit" });
  } catch (e) {
    if ((plan.optional || []).includes(i)) { console.warn(`(optional) ${asset} not found, continuing without it`); return; }
    throw e;
  }
  const dir = path.join(work, "x" + i);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(work, asset);
  if (asset.endsWith(".zip") && process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", archive, "-C", dir], { stdio: "inherit" });
  }
  copyRuntime(dir);
});

const exe = target.startsWith("win") ? "llama-server.exe" : "llama-server";
if (!fs.existsSync(path.join(out, exe))) { console.error("llama-server was not found in the downloaded packages."); process.exit(1); }
if (!target.startsWith("win")) fs.chmodSync(path.join(out, exe), 0o755);
console.log("AI engine ready in", out, "\n" + fs.readdirSync(out).join("\n"));

function copyRuntime(dir) {
  const keep = f => f === "llama-server" || f === "llama-server.exe" || /\.(dylib|dll|metal|metallib)$/i.test(f) || /\.so(\.\d+)*$/.test(f) || /^LICENSE/i.test(f);
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (keep(e.name)) fs.cpSync(p, path.join(out, e.name), { verbatimSymlinks: true, force: true });
    }
  };
  walk(dir);
}
