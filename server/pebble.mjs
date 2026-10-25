// Thin client for PebbleHost's game panel (Pterodactyl client API).
import { gunzipSync } from "node:zlib";

const PANEL = (process.env.PEBBLE_PANEL_URL || "https://panel.pebblehost.com").replace(/\/+$/, "");
const KEY = process.env.PEBBLE_API_KEY;
const SERVER = process.env.PEBBLE_SERVER_ID;

if (!KEY || !SERVER) {
  throw new Error("Set PEBBLE_API_KEY and PEBBLE_SERVER_ID environment variables.");
}

const base = `${PANEL}/api/client/servers/${SERVER}`;

async function req(path, { method = "GET", json, body, raw = false } = {}) {
  const headers = { Authorization: `Bearer ${KEY}`, Accept: "application/json" };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (body !== undefined) headers["Content-Type"] = "text/plain";
  const res = await fetch(base + path, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (!res.ok) {
    let detail = await res.text().catch(() => "");
    try {
      const j = JSON.parse(detail);
      detail = (j.errors || []).map((e) => e.detail || e.code).join("; ") || detail;
    } catch {}
    throw new Error(`PebbleHost API ${method} ${path} failed: ${res.status} ${detail}`.trim());
  }
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

const enc = encodeURIComponent;

export const api = {
  info: async () => (await req("")).attributes,

  resources: async () => {
    const a = (await req("/resources")).attributes;
    return { ...a, state: a.state ?? a.current_state };
  },

  power: (signal) => req("/power", { method: "POST", json: { signal } }),

  command: (command) => req("/command", { method: "POST", json: { command } }),

  listFiles: async (directory = "/") =>
    (await req(`/files/list?directory=${enc(directory)}`)).data.map((f) => f.attributes),

  readFile: (file) => req(`/files/contents?file=${enc(file)}`, { raw: true }),

  writeFile: (file, content) => req(`/files/write?file=${enc(file)}`, { method: "POST", body: content }),

  deleteFiles: (root, files) => req("/files/delete", { method: "POST", json: { root, files } }),

  downloadUrl: async (file) => (await req(`/files/download?file_path=${enc(file)}`)).attributes.url,

  // Reads any log, including rotated .log.gz files (fetched via signed URL and gunzipped).
  readLog: async (file = "/logs/latest.log") => {
    if (!file.endsWith(".gz")) return api.readFile(file);
    const url = await api.downloadUrl(file);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download of ${file} failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString("utf8");
  },

  listBackups: async () => (await req("/backups")).data.map((b) => b.attributes),

  createBackup: async (name) => (await req("/backups", { method: "POST", json: name ? { name } : {} })).attributes,
};
