// One-click launcher: backend + Cloudflare quick tunnel + publish the tunnel URL to GitHub Pages.
// Run:  node start.mjs   (or double-click "Start DAWORLD Dashboard.cmd")
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const say = (s) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`);
const CLOUDFLARED = [path.join(ROOT, "bin", "cloudflared.exe"), "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe", "cloudflared"].find((p) => p === "cloudflared" || fs.existsSync(p));

const backend = spawn(process.execPath, ["index.mjs"], { cwd: path.join(ROOT, "server"), stdio: ["ignore", "inherit", "inherit"] });
say("backend starting on http://localhost:8090");

let published = false;
const tunnel = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", "http://localhost:8090"], { stdio: ["ignore", "pipe", "pipe"] });
const onOut = (buf) => {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
  if (m && !published) { published = true; publish(m[0]); }
};
tunnel.stdout.on("data", onOut);
tunnel.stderr.on("data", onOut);

function git(...args) { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function publish(url) {
  say("tunnel up: " + url);
  fs.writeFileSync(path.join(ROOT, "docs", "backend.json"), JSON.stringify({ url, updated: new Date().toISOString() }, null, 2) + "\n");
  try {
    git("add", "docs/backend.json");
    git("-c", "user.name=Aadam", "-c", "user.email=aadamyahyakamran@gmail.com", "commit", "-m", "Update backend tunnel URL");
    git("push", "origin", "main");
    say("published to GitHub — the page picks it up in about a minute.");
  } catch (e) { say("could not push the URL: " + String(e.stderr || e.message).trim().split("\n").pop()); }
  say("Dashboard: https://aadamyahyakamran-commits.github.io/daworld-dashboard/");
  say("Keep this window open. Close it to take the dashboard offline.");
}

const stop = () => { try { backend.kill(); } catch {} try { tunnel.kill(); } catch {} process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
backend.on("exit", (c) => { say("backend stopped (" + c + ")"); stop(); });
tunnel.on("exit", (c) => { say("tunnel stopped (" + c + ")"); stop(); });
