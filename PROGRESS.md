# Progress

- [x] M1 Backend: login (server-side password, rate-limited, signed 12h token), logs (IP/coord redaction, hunt lines hidden), players (kick/ban, owner protected), cheating scan of the last 15 log files.
- [x] M2 Claude referee: Agent SDK, `claude-haiku-5-5`, effort `medium`, no tools, JSON verdict → hard allowlist executor. Tested: fair request ran; biased and prompt-injection requests denied.
- [x] M3 Frontend (docs/index.html) + GitHub repo + Pages.
- [x] M4 Cloudflare quick tunnel (bin/cloudflared.exe, signed by Cloudflare) + one-click launcher that publishes docs/backend.json. Verified through the public tunnel: health, CORS for github.io, login, players. Pages build: built.
