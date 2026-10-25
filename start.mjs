// One-click launcher + supervisor: backend + Cloudflare quick tunnel, publishes the tunnel URL to GitHub Pages.
// If the backend or the tunnel dies, it is restarted automatically (a new tunnel URL is re-published).
// Run:  node start.mjs   (or double-click "Start DAWORLD Dashboard.cmd")
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(ROOT, "server", "data", "launcher.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const say = (s) => { const line = `[${new Date().toLocaleString()}] ${s}`; console.log(line); try { fs.appendFileSync(LOG, line + "\n"); } catch {} };
const CLOUDFLARED = [path.join(ROOT, "bin", "cloudflared.exe"), "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe"].find((p) => fs.existsSync(p)) || "cloudflared";
let stopping = false;
const kids = { backend: null, tunnel: null };
const killTree = (pid) => { try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {} };

// clean up leftovers from a previous run (closing the window can orphan the hidden children)
function cleanup() {
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
    for (const m of out.matchAll(/127\.0\.0\.1:8090\s+\S+\s+LISTENING\s+(\d+)/g)) killTree(m[1]);
  } catch {}
  try { execFileSync("taskkill", ["/IM", "cloudflared.exe", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
}

// children run in their own process group so a stray Ctrl+C on this console doesn't kill them
const opts = { detached: true, windowsHide: true };

function startBackend() {
  const p = spawn(process.execPath, ["index.mjs"], { ...opts, cwd: path.join(ROOT, "server"), stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => say("backend: " + d.toString().trim()));
  p.stderr.on("data", (d) => say("backend error: " + d.toString().trim().slice(0, 500)));
  kids.backend = p;
  p.on("exit", (c) => { if (stopping) return; say(`backend stopped (${c}), restarting in 3s`); setTimeout(startBackend, 3000); });
  return p;
}

let lastUrl = null;
function startTunnel() {
  const p = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", "http://localhost:8090"], { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  let got = false;
  const onOut = (buf) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
    if (m && !got) { got = true; publish(m[0]); }
  };
  p.stdout.on("data", onOut);
  p.stderr.on("data", onOut);
  kids.tunnel = p;
  p.on("exit", (c) => { if (stopping) return; say(`tunnel stopped (${c}), restarting in 5s`); setTimeout(startTunnel, 5000); });
  return p;
}

function git(...args) { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
function publish(url) {
  say("tunnel up: " + url);
  if (url === lastUrl) return;
  lastUrl = url;
  fs.writeFileSync(path.join(ROOT, "docs", "backend.json"), JSON.stringify({ url, updated: new Date().toISOString() }, null, 2) + "\n");
  for (let i = 1; i <= 3; i++) {
    try {
      git("add", "docs/backend.json");
      git("-c", "user.name=Aadam", "-c", "user.email=aadamyahyakamran@gmail.com", "commit", "-m", "Update backend tunnel URL");
      git("push", "origin", "main");
      say("published to GitHub, the page picks it up in about a minute.");
      break;
    } catch (e) { say(`push attempt ${i} failed: ` + String(e.stderr || e.message).trim().split("\n").pop()); }
  }
  say("Dashboard: https://aadamyahyakamran-commits.github.io/daworld-dashboard/  (keep this running)");
}

cleanup();
startBackend();
setTimeout(startTunnel, 1500);
say("launcher started");

// Only stop on Ctrl+C when someone is actually at this window; ignore stray signals when running hidden.
const shutdown = (why) => {
  if (stopping) return; stopping = true; say("stopping (" + why + ")");
  for (const k of Object.values(kids)) if (k?.pid) killTree(k.pid);
  process.exit(0);
};
// Only stop on Ctrl+C when someone is actually at this window; ignore stray signals when running hidden.
process.on("SIGINT", () => (process.stdin.isTTY ? shutdown("Ctrl+C") : say("ignored a stray Ctrl+C")));
process.on("SIGHUP", () => shutdown("window closed"));
process.on("SIGBREAK", () => shutdown("window closed"));
process.on("exit", () => { if (!stopping) for (const k of Object.values(kids)) if (k?.pid) killTree(k.pid); });
