# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MusicDownWeb — a browser-first sibling of [MusicDown](../MusicDown/). Same UX (paste Spotify / Apple Music URL → tagged m4a out), but matching, tagging, and zipping run in the user's tab. The backend is a stateless server with three endpoints, deployable to either Cloudflare Workers or a Raspberry Pi via the same source.

Narrative + deploy notes are in [README.md](README.md). What follows is operational guidance for future Claude sessions.

## Commands

```sh
cd worker
npm install                    # one-time
npm run serve-node             # Pi/local — Node HTTP server on :8787 + serves frontend
npm run dev                    # wrangler dev — CF Workers local sim (audio path won't work)
npm run deploy                 # wrangler deploy (needs `wrangler login`)
npm run typecheck              # tsc --noEmit
```

The Node entrypoint serves both the API and the `frontend/` directory on the same origin, so there's no CORS to configure for the Pi setup. Open `http://localhost:8787`.

Frontend has no build step — vanilla JS/HTML/CSS, edit and refresh. `frontend/config.js` holds `WORKER_URL` (empty = same-origin = Pi mode; full origin string = CF Workers mode).

## Architecture

```
Browser tab (does almost everything)         Server (Pi or CF, same `handle()`)
─────────────────────────────────────        ───────────────────────────────────
- UI / paste / render                        POST /resolve   → spotify/apple
- Drive pipeline w/ semaphore = 3            POST /match     → yt music search
- Score (match.js)                           GET  /audio/:id → yt-dlp (Node) OR
- Stream audio from /audio/:id                                 youtubei.js (CF)
- Apply MP4 tags (mp4-tag.js)
- Build ZIP (JSZip), save via <a download>
```

State lives in JS memory: `state.tracks[i]._blob` (Uint8Array). Refresh = lose progress (deliberate). 50 tracks × ~4 MB = ~200 MB resident — fine on desktop, watch on mobile.

Per-track pipeline (`processTrack` in [frontend/app.js](frontend/app.js)): `matching → downloading (with streamed progress) → tagging → done`, mirroring the worker's status enum in sibling MusicDown.

The worker is a flat router — three handlers + CORS preflight — in [worker/src/index.ts](worker/src/index.ts). The same `handle()` is exported both as `default { fetch: handle }` (Cloudflare Workers) and called by `worker/src/node-server.ts` on Node.

## Load-bearing decisions

1. **Spotify uses `open.spotify.com/embed/<kind>/<id>` (`__NEXT_DATA__`), not pathfinder.** Pathfinder needs a TOTP-rotated anonymous token plus persistedQuery hashes that rotate. Embed needs none of that. Trade-off: huge playlists may be returned truncated. Tracks and albums are always complete. If a user reports truncation, the upgrade path is a pathfinder client — the sibling MusicDown's Python `spotapi` is the reference.

2. **YouTube audio is fetched via yt-dlp subprocess on Node, not pure JS.** As of mid-2026, YouTube's `po_token` enforcement returns formats with empty `url` fields to pure-JS clients (verified against `youtubei.js@17` and `@distube/ytdl-core` at scaffold time — both gave "No valid URL to decipher"). The Node server detects `yt-dlp` at startup via `probeYtDlp()` and uses it as the primary audio fetcher. `youtubei.js` remains wired in as a fallback for the CF Workers target but currently does not function against real videos. If YouTube's anti-bot eases or a po_token automation lands, the JS path can be re-promoted to primary — the dispatch logic is in [worker/src/youtube.ts](worker/src/youtube.ts) `detectYtDlp()`.

3. **yt-dlp writes to a temp file, then we stream the file back.** Two reasons: (a) YouTube serves audio as HLS playlists of raw AAC/ADTS — `-o -` gives a raw bitstream with an ID3 prefix, not an MP4 container, which breaks the browser-side tagger. With `--remux-video m4a` + a file path, ffmpeg wraps the AAC in a proper MP4. (b) The file is auto-deleted when the Node read stream closes, including on consumer cancel. See [worker/src/youtube-ytdlp.ts](worker/src/youtube-ytdlp.ts). The yt-dlp dependency means `ffmpeg` is also required.

4. **Build-once, mutate-in-place rendering — same rule as MusicDown.** Track `<li>`s are appended once and mutated thereafter. The CSS staggered entrance animation runs only on first append. Do NOT `innerHTML = template` the track list on each state update — the original project's CLAUDE.md documents why (40+ events per album → flicker storm). `bumpRender()` coalesces multiple state updates per microtask to a single render — call that, not `render()` directly.

5. **MP4 tagger is hand-rolled atoms, not ffmpeg.wasm.** ffmpeg.wasm is ~30 MB to load; we don't need to re-mux, only inject `/moov/udta/meta/ilst`. The tagger in [frontend/mp4-tag.js](frontend/mp4-tag.js) walks the atom tree, replaces or creates `udta`, and patches `stco`/`co64` chunk offsets when the moov size delta shifts `mdat`. **Verified** against a real yt-dlp-output m4a: ffprobe reads back all tags, audio still decodes cleanly. If you change the tagger, do not skip the stco/co64 patch step — the file will appear to play but become unseekable / subtly corrupt.

6. **Cover art fetched cross-origin from the browser, not proxied.** Both Spotify (`i.scdn.co`) and Apple (`mzstatic.com`) serve images with permissive CORS. If a fetch fails (CORS or 4xx), the track is tagged without cover rather than failing the whole pipeline.

7. **`youtubei.js` requires a custom JS evaluator on Node v17+.** The library's Node platform shim ships a stub `eval` that throws "provide your own JavaScript evaluator". We patch `Platform.shim.eval` at module import time using `node:vm`. See top of [worker/src/youtube.ts](worker/src/youtube.ts). On CF Workers there's no `vm`; the shim would need a different evaluator there before audio could ever work.

8. **CORS allow-list from env `ALLOWED_ORIGINS`** (comma-separated; `*` for any). Defaults to `*` in `wrangler.toml`. For Pi self-host this is moot — frontend and API share an origin.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/resolve` | `{url}` → `{kind, title, tracks: [...]}` |
| POST | `/match`   | `{title, artist, duration_ms}` → `{candidates: [...]}` |
| GET  | `/audio/:videoId` | audio/mp4 bytes (yt-dlp remuxed). `Content-Length` populated so the frontend gets a real progress bar. |
| GET  | `/health` | `{ok: true}` |

## What's smoke-tested vs not

**Validated at scaffold time:**
- ✓ `/health`, `/resolve` (Spotify track + album, Apple album), `/match`, `/audio/:id`
- ✓ Tagger output: `file` reports valid M4A; `ffprobe` reads all metadata fields back; audio stream still decodes (44.1 kHz / 128 kbps AAC).
- ✓ Frontend static files served correctly (index.html, app.js, style.css, favicon.svg).

**Not yet validated:**
- Browser end-to-end (open `localhost:8787`, paste URL, get ZIP). Components all worked in isolation; the orchestrator wiring is plausible but unconfirmed.
- Cloudflare Workers deployment of any kind.
- Spotify playlist resolution (only tracks + albums tested).
- Cover-art-embedded m4a (tagging tested without cover bytes; the `covr` atom path is written from spec but not exercised against real cover bytes).

## Sibling project

[../MusicDown/](../MusicDown/) is the working Docker-based predecessor. Its CLAUDE.md / ONBOARDING.md have the canonical rationale for resolver choices, the aesthetic decisions, and the deploy story to a Pi behind a VPS-hosted Caddy. When the resolvers here break, that one's Python implementation is the reference.
