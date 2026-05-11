// Cloudflare Worker entrypoint — three endpoints, all stateless.
//
//   POST /resolve   { url } → { kind, title, tracks: [...] }
//   POST /match     { title, artist, duration_ms } → { candidates: [...] }
//   GET  /audio/:id                              → audio/mp4 bytes (CORS-friendly)
//
// CORS allow-list is read from env.ALLOWED_ORIGINS (comma-separated).
// Set ALLOWED_ORIGINS to "*" for "open to everyone" — fine for personal use,
// but consider locking it down to your frontend origin once deployed.
//
// The same handler is exported as `handle()` so the Node entrypoint
// (src/node-server.ts) can reuse it on a Pi.

import { corsHeaders, errorJson, json, preflight } from "./cors.js";
import { isAppleUrl, resolveApple } from "./resolvers/apple.js";
import { isSpotifyUrl, resolveSpotify } from "./resolvers/spotify.js";
import { searchYouTubeMusic, fetchAudioStream } from "./youtube.js";

interface Env {
  ALLOWED_ORIGINS?: string;
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const allowed = env.ALLOWED_ORIGINS ?? "*";

  const pre = preflight(req, allowed);
  if (pre) return pre;

  const url = new URL(req.url);
  try {
    if (url.pathname === "/resolve" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { url?: string };
      const target = (body.url ?? "").trim();
      if (!target) return errorJson("missing 'url'", 400, req, allowed);

      let resolved;
      if (isSpotifyUrl(target)) resolved = await resolveSpotify(target);
      else if (isAppleUrl(target)) resolved = await resolveApple(target);
      else return errorJson("only Spotify or Apple Music URLs are supported", 400, req, allowed);
      return json(resolved, 200, req, allowed);
    }

    if (url.pathname === "/match" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as {
        title?: string;
        artist?: string;
        duration_ms?: number;
        limit?: number;
      };
      const title = (body.title ?? "").trim();
      const artist = (body.artist ?? "").trim();
      if (!title) return errorJson("missing 'title'", 400, req, allowed);
      const query = `${artist} ${title}`.trim();
      const candidates = await searchYouTubeMusic(query, body.limit ?? 8);
      return json({ candidates }, 200, req, allowed);
    }

    const audioMatch = /^\/audio\/([\w-]{6,})$/.exec(url.pathname);
    if (audioMatch && req.method === "GET") {
      const videoId = audioMatch[1]!;
      const { body, contentLength, info } = await fetchAudioStream(videoId);
      const headers: Record<string, string> = {
        "Content-Type": info.mime,
        "Cache-Control": "no-store",
        // Surface the size so the browser can show a real progress bar
        ...(contentLength ? { "Content-Length": String(contentLength) } : {}),
        ...corsHeaders(req, allowed),
      };
      return new Response(body, { status: 200, headers });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, name: "musicdownweb-worker" }, 200, req, allowed);
    }

    return errorJson("not found", 404, req, allowed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Resolver errors are user-facing (bad URL, page shape changed). Audio
    // and match errors are usually network/cipher. Either way, surface the
    // message — there is no PII here.
    return errorJson(msg, 502, req, allowed);
  }
}

// Cloudflare Workers expects a default export with `fetch`.
export default {
  fetch: handle,
};
