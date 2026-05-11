# MusicDownWeb

Paste a Spotify or Apple Music link, get tagged m4a files. Same idea as the sibling [MusicDown](../MusicDown/), but the heavy lifting (matching, tagging, zipping) runs in the user's browser. The backend is a stateless server with three endpoints — small enough to run on Cloudflare Workers' free tier OR on a Raspberry Pi alongside the sibling project's Docker stack.

## What's tested

End-to-end on the Node/Pi server path:

- ✓ Spotify resolver (track, album) — embed `__NEXT_DATA__` scrape, no auth
- ✓ Apple Music resolver (album with full track list)
- ✓ YouTube Music search + scoring
- ✓ Audio download as proper `.m4a` (verified with `ffprobe`)
- ✓ MP4 atom tagging (title/artist/album/track/disc/cover) via pure-JS atom writer — tags read back correctly by `ffprobe`, audio still decodes
- ✓ Frontend served on `:8787`, all assets reachable

The browser-side end-to-end flow (paste URL → save ZIP) was not exercised by automation; that's the first thing to try when you wake up. See "First run" below.

## Architecture

```
┌──────────────────────────────────────┐   ┌──────────────────────────────┐
│  Browser tab (almost everything)     │   │  Worker (CF or Pi-hosted)    │
│                                      │   │                              │
│  - URL paste, drive job              │──▶│  POST /resolve               │
│  - Resolve flow orchestration        │   │     Spotify embed scrape OR  │
│  - Match scoring (rapidfuzz-in-JS)   │   │     Apple Music SSR scrape   │
│  - Per-track parallel pipeline       │──▶│  POST /match                 │
│  - MP4 atom tagging + cover embed    │   │     YouTube Music search     │
│  - JSZip in-memory                   │◀──│  GET  /audio/:videoId        │
│  - File save (anchor download)       │   │     yt-dlp → remuxed m4a     │
└──────────────────────────────────────┘   │     (youtubei.js fallback)   │
                                           └──────────────────────────────┘
```

No state, no queue, no DB. The Worker exists because of three origins that block CORS for browsers (Spotify, Apple, YouTube/googlevideo) plus YouTube's signature cipher. Everything else — concurrency, retries, scoring, tagging, zipping — runs in the user's tab.

## Why the architecture is two-tier

A pure-browser version is impossible. CORS blocks any webpage from fetching Spotify, Apple Music, YouTube Music, or `googlevideo`. The Worker exists solely to bridge those origins. Everything else lives in the tab so refresh = lose progress is the only cost of "no server state."

## Deployment

### Pi / Node — the one that works today

```sh
cd worker
npm install
npm run serve-node
# → http://localhost:8787
```

**Requires `yt-dlp` on PATH.** YouTube's mid-2026 po_token enforcement leaves pure-JS clients (youtubei.js, ytdl-core, etc.) with empty audio URLs. The Worker detects yt-dlp at startup and uses it as the primary audio fetcher. The `youtubei.js` path remains as a fallback but is currently non-functional against YouTube's anti-bot. `ffmpeg` is also required (for yt-dlp's `--remux-video m4a`).

The same Pi that runs MusicDown already has both. Just symlink or alias yt-dlp into `node_modules/.bin/` if it's not on PATH, or `export YTDLP_BIN=/path/to/yt-dlp`.

### Cloudflare Workers — partially functional

```sh
cd worker
npx wrangler login
npm run deploy
```

Then set `frontend/config.js`'s `WORKER_URL` to your `https://<name>.workers.dev` and host the `frontend/` directory on Cloudflare Pages / GitHub Pages.

Caveat: `/resolve` and `/match` work; `/audio/:id` currently does NOT, because Workers can't spawn `yt-dlp` and `youtubei.js` is blocked by YouTube's bot detection. CF deployment is therefore "metadata only" right now. The upgrade path is one of:
- a po_token automation service (e.g., `bgutils`) — adds operational complexity
- a JS port of yt-dlp's nsig deciphering when YouTube next rotates the algorithm

## Repo layout

| Path | What it is |
|---|---|
| `worker/src/index.ts` | Flat router — three endpoints + CORS. Same `handle()` runs on CF Workers and Node. |
| `worker/src/cors.ts` | Allow-list CORS helper. Env: `ALLOWED_ORIGINS`. |
| `worker/src/types.ts` | Shared shapes (`Track`, `ResolvedSource`, `YouTubeCandidate`). |
| `worker/src/resolvers/spotify.ts` | `open.spotify.com/embed/<kind>/<id>` → `__NEXT_DATA__` JSON. No credentials. |
| `worker/src/resolvers/apple.ts` | `music.apple.com/...` → `<script id="serialized-server-data">` JSON. No credentials. |
| `worker/src/youtube.ts` | YouTube Music search + audio fetch with yt-dlp/youtubei.js dispatch. |
| `worker/src/youtube-ytdlp.ts` | `child_process.spawn("yt-dlp", ...)` + temp-file remux to m4a. Loaded lazily on Node only. |
| `worker/src/node-server.ts` | Node HTTP server that wraps `handle()` and serves the `frontend/`. |
| `frontend/index.html` | Static shell, vinyl/liner-notes aesthetic. |
| `frontend/style.css` | Mostly lifted from sibling MusicDown for consistency. |
| `frontend/config.js` | `WORKER_URL`, concurrency, match threshold. |
| `frontend/match.js` | Token-set ratio fuzzy match + duration tolerance + noise-word reject. |
| `frontend/mp4-tag.js` | Pure-JS MP4 atom writer for iTunes-style metadata. Patches `stco`/`co64` when moov shifts. |
| `frontend/app.js` | Pipeline orchestrator; semaphore-limited per-track flow; ZIP build. |

## First run

```sh
cd MusicDownWeb/worker
npm install
npm run serve-node
```

Then open `http://localhost:8787`, paste:
- A Spotify track (e.g. `https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8`)
- A Spotify album (returns full track list)
- An Apple Music album (full track list with cover art)

Hit Go. Watch tracks resolve, match, download, tag, ready. Click "Download ZIP" when all are done, or the `↧` next to a single row to save just that track.

## Smoke tests (validated)

```sh
# Health
curl http://localhost:8787/health

# Resolve a Spotify track
curl -X POST http://localhost:8787/resolve -H "Content-Type: application/json" \
  -d '{"url":"https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8"}'

# Search YouTube Music
curl -X POST http://localhost:8787/match -H "Content-Type: application/json" \
  -d '{"title":"Come Together","artist":"The Beatles","duration_ms":258947}'

# Download tagged m4a (requires yt-dlp)
curl -o test.m4a http://localhost:8787/audio/oolpPmuK2I8
ffprobe -show_entries format_tags test.m4a
```

## Known limitations

- **Spotify playlists may truncate** — the `embed/playlist/<id>` page is the only credential-free source. Tracks and albums always complete. If a user reports truncation, the upgrade is a `pathfinder` GraphQL client like the sibling MusicDown's Python `spotapi`.
- **No URL-based job persistence** — refresh loses progress (deliberate — no server state).
- **Browser memory** — all completed tracks live as `Uint8Array` in JS until ZIP. A 50-track album sits at ~200 MB resident. Fine on desktop, watch on mobile.
- **CF Workers deployment can't currently fetch audio.** See Deployment > Cloudflare.
- **Cover art** — fetched cross-origin (Spotify CDN and Apple CDN both allow CORS). If a CDN ever returns no CORS headers, those tracks get tagged without cover.
