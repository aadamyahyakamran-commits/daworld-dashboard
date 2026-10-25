// DAWORLD dashboard backend. Runs on the owner's PC, reached through a Cloudflare tunnel.
// Secrets (.env): PEBBLE_API_KEY, PEBBLE_SERVER_ID, DASH_PASSWORD, TOKEN_SECRET.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(HERE, ".env")) ? fs.readFileSync(path.join(HERE, ".env"), "utf8") : "").split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { api } = await import("./pebble.mjs");
const { review } = await import("./reviewer.mjs");
const { checkCommands } = await import("./policy.mjs");
const { ping } = await import("./slp.mjs");

const PORT = +process.env.PORT || 8090;
const PASSWORD = process.env.DASH_PASSWORD;
const SECRET = process.env.TOKEN_SECRET;
const OWNER = (process.env.OWNER || "EzioFlame").toLowerCase();
if (!PASSWORD || !SECRET || !process.env.PEBBLE_API_KEY) { console.error("missing .env values"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = /^\.?[A-Za-z0-9_]{1,16}$/;

// ---------- redaction: never leak IPs, coordinates or hunt internals ----------
const SECRET_LINE = /hunt_setup|hunt:|hunt_temple|hunt_site|temple|lodestone|LodestonePos|lodestone_tracker|\blocate\b|forceload|data get|seeker_compass/i;
function redact(line) {
  return line
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[ip]")
    .replace(/[0-9a-f]{1,4}(:[0-9a-f]{0,4}){4,7}/gi, "[ip]")
    .replace(/-?\d+(\.\d+)?[d,f]?\s*,\s*-?\d+(\.\d+)?[d,f]?\s*,\s*-?\d+(\.\d+)?[d,f]?/g, "[coords]")
    .replace(/\[(-?\d+(\.\d+)?d?,\s*){2}-?\d+(\.\d+)?d?\]/g, "[coords]")
    .replace(/\b[xyz]\s*[:=]\s*-?\d+(\.\d+)?/gi, "[coord]")
    .replace(/(issued server command: \/\S+(?:\s+\S+)?)\s+[-~^\d.\s]+$/, "$1 [coords]");
}
const LIST_NOISE = /There are \d+ of a max of \d+ players online/;
const clean = (lines) => lines.filter((l) => l.trim() && !SECRET_LINE.test(l)).map(redact);

// ---------- serialised command runner that captures console output from the log ----------
let chain = Promise.resolve();
function run(command, { capture = false, wait = 1200 } = {}) {
  const job = chain.then(async () => {
    const before = capture ? (await api.readLog()).split("\n").length : 0;
    await api.command(command);
    if (!capture) return "";
    await sleep(wait);
    return (await api.readLog()).split("\n").slice(before - 1).join("\n");
  });
  chain = job.catch(() => {});
  return job;
}

// ---------- state ----------
const history = []; // request log shown on the dashboard
const DATA = path.join(HERE, "data");
fs.mkdirSync(DATA, { recursive: true });
const HIST = path.join(DATA, "requests.json");
try { history.push(...JSON.parse(fs.readFileSync(HIST, "utf8"))); } catch {}
const saveHist = () => fs.writeFileSync(HIST, JSON.stringify(history.slice(-200), null, 1));
const audit = (entry) => fs.appendFileSync(path.join(DATA, "actions.log"), new Date().toISOString() + " " + JSON.stringify(entry) + "\n");

// ---------- auth ----------
const sign = (exp) => exp + "." + crypto.createHmac("sha256", SECRET).update(String(exp)).digest("base64url");
function validToken(t) {
  const [exp, sig] = String(t || "").split(".");
  if (!exp || !sig || +exp < Date.now()) return false;
  const good = sign(exp).split(".")[1];
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(), arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr); return true;
  };
}
const loginLimit = limiter(6, 60_000);
const requestLimit = limiter(6, 60_000);
const globalRequestLimit = limiter(40, 3_600_000);
const modLimit = limiter(20, 60_000);
const ipOf = (req) => req.get("cf-connecting-ip") || req.socket.remoteAddress || "?";

// ---------- app ----------
const app = express();
app.set("trust proxy", false);
app.use(express.json({ limit: "16kb" }));
const ORIGINS = new Set(["https://aadamyahyakamran-commits.github.io", "http://localhost:8090", "http://localhost:5180"]);
app.use((req, res, next) => {
  const o = req.get("origin");
  if (o && ORIGINS.has(o)) { res.set("Access-Control-Allow-Origin", o); res.set("Vary", "Origin"); }
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.post("/api/login", (req, res) => {
  if (!loginLimit(ipOf(req))) return res.status(429).json({ error: "Too many tries, wait a minute." });
  const p = Buffer.from(String(req.body?.password || "")), g = Buffer.from(PASSWORD);
  if (p.length !== g.length || !crypto.timingSafeEqual(p, g)) return res.status(401).json({ error: "Wrong password." });
  res.json({ token: sign(Date.now() + 12 * 3600_000) });
});
app.use("/api", (req, res, next) => (validToken((req.get("authorization") || "").replace(/^Bearer /, "")) ? next() : res.status(401).json({ error: "Log in again." })));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: String(e.message || e).replace(/-?\d{3,}/g, "#") }));

// status + logs
app.get("/api/status", wrap(async (req, res) => {
  const r = await api.resources();
  res.json({ state: r.state, cpu: r.resources?.cpu_absolute, memory: r.resources?.memory_bytes, uptime: r.resources?.uptime });
}));
app.get("/api/logs", wrap(async (req, res) => {
  const n = Math.min(+req.query.lines || 300, 1000);
  let raw = (await api.readLog()).split("\n");
  if (raw.length < n) {
    const prev = (await api.listFiles("/logs")).filter((f) => /\.log\.gz$/.test(f.name)).sort((a, b) => a.modified.localeCompare(b.modified) || a.name.localeCompare(b.name)).pop();
    if (prev) raw = [...(await api.readLog("/logs/" + prev.name).catch(() => "")).split("\n"), "──── new log file ────", ...raw];
  }
  const lines = clean(raw.filter((l) => !LIST_NOISE.test(l)));
  res.json({ lines: lines.slice(-n) });
}));

// players
let listCache = { at: 0, v: null };
async function onlinePlayers() {
  if (Date.now() - listCache.at < 5000 && listCache.v) return listCache.v;
  const v = await onlinePlayersRaw();
  listCache = { at: Date.now(), v };
  return v;
}
async function onlinePlayersRaw() {
  if (process.env.MC_HOST) {
    try {
      const [h, port] = process.env.MC_HOST.split(":");
      const r = await ping(h, +port || 25565);
      const names = (r.players?.sample || []).map((p) => p.name).filter((n) => NAME.test(n));
      if (names.length === r.players?.online) return { count: r.players.online, max: r.players.max, players: names };
    } catch {}
  }
  const out = await run("list", { capture: true });
  const m = /There are (\d+) of a max of (\d+) players online:(.*)/.exec(out);
  if (!m) return { count: null, max: null, players: [] };
  return { count: +m[1], max: +m[2], players: m[3].split(",").map((s) => s.trim()).filter(Boolean) };
}
const readJson = async (f) => { try { return JSON.parse(await api.readFile(f)); } catch { return []; } };
app.get("/api/players", wrap(async (req, res) => {
  const [online, wl, bans, cache] = await Promise.all([onlinePlayers(), readJson("/whitelist.json"), readJson("/banned-players.json"), readJson("/usercache.json")]);
  const known = new Map();
  for (const p of [...cache, ...wl]) if (p.name) known.set(p.name.toLowerCase(), p.name);
  for (const n of online.players) known.set(n.toLowerCase(), n);
  const banned = new Map(bans.map((b) => [b.name?.toLowerCase(), { reason: b.reason, source: b.source, created: b.created }]));
  const players = [...known.values()].sort((a, b) => a.localeCompare(b)).map((name) => ({
    name,
    online: online.players.some((p) => p.toLowerCase() === name.toLowerCase()),
    whitelisted: wl.some((p) => p.name?.toLowerCase() === name.toLowerCase()),
    banned: banned.has(name.toLowerCase()) ? banned.get(name.toLowerCase()) : null,
    protected: name.toLowerCase() === OWNER,
  }));
  for (const [n, b] of banned) if (n && !known.has(n)) players.push({ name: bans.find((x) => x.name?.toLowerCase() === n).name, online: false, whitelisted: false, banned: b, protected: false });
  res.json({ count: online.count, max: online.max, players });
}));
const safeReason = (s) => String(s || "").replace(/[§\r\n]/g, "").replace(/[^\w .,!?'()-]/g, "").slice(0, 80).trim();
function modAction(kind) {
  return wrap(async (req, res) => {
    if (!modLimit(ipOf(req))) return res.status(429).json({ error: "Slow down." });
    const name = String(req.body?.player || "");
    if (!NAME.test(name)) return res.status(400).json({ error: "Invalid player name." });
    if (name.toLowerCase() === OWNER) return res.status(403).json({ error: "The owner can't be kicked or banned from here." });
    const reason = safeReason(req.body?.reason) || (kind === "ban" ? "Banned via dashboard" : "Kicked via dashboard");
    const out = await run(`${kind} ${name} ${reason}`, { capture: true });
    audit({ kind, name, reason, ip: ipOf(req).slice(0, 7) + "…" });
    res.json({ ok: true, output: clean(out.split("\n")).slice(-5) });
  });
}
app.post("/api/kick", modAction("kick"));
app.post("/api/ban", modAction("ban"));

// cheating panel
const PATTERNS = [
  ["anticheat", /(moved wrongly|moved too quickly|floating too long|Flying is not enabled|out-of-order|Invalid move|Illegal stance|Kicked for flying)/i],
  ["kicked", /lost connection: .*(fly|flying|moved too quickly|illegal|invalid|cheat|hack|spam)/i],
  ["blocked command", /issued server command: \/(give|gamemode|gm[a-z]?|op|deop|tp|teleport|item|enchant|effect|summon|fill|setblock|clone|xp|experience|kill|attribute|data|loot|spawnpoint|weather|time|whitelist|ban|pardon|kick|execute|function|reload|stop|fwhitelist|orbital|clear)\b/i],
  ["give", /^\[([.\w]+): Gave (.*)\]/],
  ["gamemode", /^\[([.\w]+): Set (.*game mode.*)\]/i],
  ["chat hint", /(dupe|duplicat|x-?ray|freecam|hacked client|meteor client|wurst|baritone|killaura|kill aura|autoclick|esp\b)/i],
];
const CHAT = /^(?:\[Not Secure\] )?<([.\w]{2,17})>/;
const SUBJECT = /^\[?([.\w]{2,17})[: \]]/;
let cheatCache = { at: 0, data: null };
app.get("/api/cheating", wrap(async (req, res) => {
  if (Date.now() - cheatCache.at < 20_000 && cheatCache.data) return res.json(cheatCache.data);
  const files = (await api.listFiles("/logs")).filter((f) => /\.log(\.gz)?$/.test(f.name)).sort((a, b) => a.modified.localeCompare(b.modified) || (a.name === "latest.log") - (b.name === "latest.log") || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const pick = files.slice(-6);
  const [wl, cache] = await Promise.all([readJson("/whitelist.json"), readJson("/usercache.json")]);
  const known = new Set([...wl, ...cache].map((p) => String(p.name || "").toLowerCase()).filter(Boolean));
  const items = [];
  for (const f of pick) {
    const text = await api.readLog("/logs/" + f.name).catch(() => "");
    const day = /^\d{4}-\d{2}-\d{2}/.exec(f.name)?.[0] || f.modified.slice(0, 10);
    for (const raw of text.split("\n")) {
      const m = /^\[(\d\d:\d\d:\d\d)\] \[Server thread\/(?:INFO|WARN)\]: (.*)$/.exec(raw.trim());
      if (!m || SECRET_LINE.test(m[2])) continue;
      const body = m[2];
      const chat = CHAT.exec(body);
      const who = chat?.[1] || SUBJECT.exec(body)?.[1];
      if (!who || !known.has(who.toLowerCase())) continue;
      for (const [type, re] of PATTERNS) {
        if (type === "chat hint" ? !chat : !!chat) continue;
        if (!re.test(body)) continue;
        if (who.toLowerCase() === OWNER && type !== "anticheat" && type !== "kicked") break;
        items.push({ day, time: m[1], type, player: who, line: redact(body).slice(0, 300) });
        break;
      }
    }
  }
  const byPlayer = {};
  for (const i of items) byPlayer[i.player] = (byPlayer[i.player] || 0) + 1;
  cheatCache = { at: Date.now(), data: { files: pick.map((f) => f.name), byPlayer, items: items.slice(-400).reverse() } };
  res.json(cheatCache.data);
}));

// requests reviewed by Claude
app.get("/api/requests", (req, res) => res.json({ items: history.slice(-50).reverse() }));
// Owner mode: a request ending in the secret OWNER_SUFFIX from .env skips the fairness check and the policy.
// Owner requests never appear in the shared history, so the suffix isn't shown to mods.
const OWNER_SUFFIX = process.env.OWNER_SUFFIX || null; // unset = owner mode off
const ownerHistory = path.join(DATA, "owner-requests.log");
app.post("/api/request", wrap(async (req, res) => {
  const ip = ipOf(req);
  let text = String(req.body?.request || "").replace(/[\u0000-\u0009\u000b-\u001f§]/g, " ").trim().slice(0, 1000);
  const ownerMode = !!OWNER_SUFFIX && text.endsWith(OWNER_SUFFIX);
  if (ownerMode) text = text.slice(0, -OWNER_SUFFIX.length).trim();
  if (!ownerMode) {
    text = text.replace(/\n/g, " ").slice(0, 400);
    if (!requestLimit(ip)) return res.status(429).json({ error: "Max 6 requests a minute." });
    if (!globalRequestLimit("all")) return res.status(429).json({ error: "The hourly request budget is used up, try later." });
  }
  const from = String(req.body?.from || "").trim();
  if (text.length < 2) return res.status(400).json({ error: "Type a request." });
  if (from && !NAME.test(from)) return res.status(400).json({ error: "Your name must be a Minecraft username." });
  const online = (await onlinePlayers()).players;
  const entry = { id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), from: ownerMode ? "owner" : from || "anonymous", request: text, online };

  // owner can also type raw commands: every line starting with "/" runs as-is (Claude is skipped)
  const rawLines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  let verdict;
  if (ownerMode && rawLines.every((l) => l.startsWith("/"))) {
    verdict = { verdict: "fair", reason: "Owner command.", commands: rawLines.map((l) => l.slice(1)) };
  } else {
    try { verdict = await review({ request: text, from: entry.from, online, owner: OWNER, ownerMode }); }
    catch (e) { verdict = { verdict: "error", reason: "The reviewer failed: " + String(e.message).slice(0, 120), commands: [] }; }
  }
  entry.verdict = verdict.verdict; entry.reason = verdict.reason;
  entry.proposed = (verdict.commands || []).map((c) => String(c).trim().replace(/^\//, "")).filter(Boolean);
  const { ok, rejected } = ownerMode ? { ok: entry.proposed.slice(0, 50), rejected: [] } : checkCommands(entry.proposed);
  entry.rejected = rejected;
  entry.executed = [];
  entry.output = [];
  if (verdict.verdict === "fair" && ok.length) {
    for (const cmd of ok) {
      const out = await run(cmd, { capture: true, wait: 900 });
      entry.executed.push(cmd);
      entry.output.push(...clean(out.split("\n")).filter((l) => !LIST_NOISE.test(l)).map((l) => l.replace(/^\[[^\]]+\] \[[^\]]+\]: /, "")).slice(-3));
    }
    audit({ kind: ownerMode ? "owner-request" : "request", id: entry.id, from: entry.from, executed: entry.executed });
  }
  entry.status = verdict.verdict !== "fair" ? (verdict.verdict === "error" ? "error" : "denied") : entry.executed.length ? "executed" : "nothing allowed";
  if (ownerMode) fs.appendFileSync(ownerHistory, JSON.stringify(entry) + "\n");
  else { history.push(entry); saveHist(); }
  res.json(entry);
}));

app.use(express.static(path.join(HERE, "..", "docs"))); // local testing: http://localhost:8090
app.listen(PORT, "127.0.0.1", () => console.log(`DAWORLD dashboard backend on http://localhost:${PORT}`));
