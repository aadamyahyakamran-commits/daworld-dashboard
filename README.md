# DAWORLD Dashboard

Password-protected control panel for the DAWORLD Minecraft server.

- **Requests** – players type a request; Claude (Haiku 5.5, medium effort) judges if it's fair. Fair requests run automatically.
- **Players** – kick / ban (the owner is protected; no op, no clear).
- **Potential cheating** – anti-cheat warnings, blocked admin commands and suspicious chat from recent logs.
- **Server logs** – live tail with IPs and coordinates hidden.

## How it works

```
GitHub Pages (docs/)  ──HTTPS──▶  Cloudflare quick tunnel  ──▶  backend on the owner's PC (server/, port 8090)
                                                                   ├─ PebbleHost panel API (key stays on the PC)
                                                                   └─ Claude Agent SDK (owner's Claude login, no tools)
```

The password is checked by the backend, never in the page. Whatever Claude approves, only the hard
allowlist in `server/actions.mjs` can run: time, weather, announcements/titles, sounds, short harmless
effects, teleport player→player or to spawn. Max 5 actions per request, 3 requests/min per person, 40/hour total.

## Run

Double-click **Start DAWORLD Dashboard.cmd** (or `node start.mjs`). It starts the backend, opens a tunnel and
pushes the tunnel URL to `docs/backend.json`. The dashboard only works while that window is open.

`server/.env` (not committed) holds `PEBBLE_API_KEY`, `PEBBLE_SERVER_ID`, `DASH_PASSWORD`, `TOKEN_SECRET`, `OWNER`, `MC_HOST`.
