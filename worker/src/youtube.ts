// YouTube wrapper — search via YouTube Music + cipher-decoded audio URLs.
//
// We use `youtubei.js` (InnerTube client). It handles:
//   - YouTube Music search (filter=songs, like ytmusicapi)
//   - Player JS download + signature cipher decoding
//   - Format selection (bestaudio[ext=m4a]/bestaudio equivalent)
//
// The Innertube instance is a singleton per process — it caches the player
// JS, which is expensive to fetch and parse. On CF Workers this rebuilds
// on cold start; on the Pi/Node server it stays warm.

import { Innertube, UniversalCache } from "youtubei.js";
// The Node platform shim ships a stub `eval` that throws. We install a real
// one using node:vm so signature/n-param cipher decoding actually runs.
// This is done at module import time because youtubei.js latches the shim
// the first time it loads the player.
import vm from "node:vm";
import { Platform } from "youtubei.js";
import type { YouTubeCandidate, AudioStreamInfo } from "./types.js";

(() => {
  const shim: any = (Platform as any).shim;
  if (!shim) return;
  // Replace the throwing stub. youtubei.js calls this as
  // `eval(data, eval_args)` where data.output is a complete JS program that
  // computes the transformed sig/n via variables named after `eval_args`.
  shim.eval = (data: any, eval_args: any) => {
    const ctx = vm.createContext({});
    vm.runInContext(String(data.output ?? ""), ctx, { timeout: 5_000 });
    const result: any = {};
    // youtubei.js documents that the program writes outputs under whichever
    // top-level names match the keys of `eval_args`. Copy those back.
    for (const k of Object.keys(eval_args ?? {})) {
      if (k in ctx) result[k] = (ctx as any)[k];
    }
    // Also surface any explicitly exported names from the build script.
    for (const name of data.exported ?? []) {
      if (name in ctx && !(name in result)) result[name] = (ctx as any)[name];
    }
    return result;
  };
})();

let _yt: Innertube | null = null;
let _ytPromise: Promise<Innertube> | null = null;

async function client(): Promise<Innertube> {
  if (_yt) return _yt;
  if (_ytPromise) return _ytPromise;
  _ytPromise = Innertube.create({
    retrieve_player: true,
    cache: new UniversalCache(false),
    generate_session_locally: true,
  }).then(yt => {
    _yt = yt;
    _ytPromise = null;
    return yt;
  });
  return _ytPromise;
}

function parseDurationSeconds(d: unknown): number | null {
  if (typeof d === "number") return d;
  if (typeof d !== "string") return null;
  // "3:42" or "1:03:42"
  const parts = d.split(":").map(s => parseInt(s, 10));
  if (parts.some(isNaN)) return null;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}

export async function searchYouTubeMusic(query: string, limit = 8): Promise<YouTubeCandidate[]> {
  const yt = await client();
  const res: any = await yt.music.search(query, { type: "song" });

  // youtubei.js shape varies a little by version. Look for the songs section.
  const songs: any[] =
    res?.songs?.contents ??
    res?.contents?.find?.((s: any) => s?.title === "Songs")?.contents ??
    [];

  const out: YouTubeCandidate[] = [];
  for (const item of songs) {
    const videoId: string | undefined = item?.id ?? item?.video_id;
    if (!videoId) continue;
    const title: string = item?.title?.text ?? item?.title ?? "";
    const artists: string[] = (item?.artists ?? [])
      .map((a: any) => a?.name)
      .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);
    const album: string | null = item?.album?.name ?? null;
    const durationSec: number | null = parseDurationSeconds(
      item?.duration?.seconds ?? item?.duration?.text ?? item?.duration ?? null,
    );
    out.push({
      video_id: videoId,
      title,
      artists,
      album,
      duration_seconds: durationSec,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface AudioFetchResult {
  info: AudioStreamInfo;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
}

// Clients to try in order. IOS/ANDROID return progressive (non-ciphered) URLs
// that we can fetch directly; WEB usually requires signature decoding and is
// the fallback when the mobile clients refuse a given video.
const CLIENT_FALLBACK = ["IOS", "ANDROID", "WEB"] as const;

// On Node/Bun we prefer yt-dlp because YouTube's po_token enforcement (mid-
// 2026 onward) leaves pure-JS clients without playable URLs. yt-dlp keeps
// up with the anti-bot churn. CF Workers can't spawn processes — detection
// happens once at first call and falls through to youtubei.js there.
let _preferYtDlp: boolean | null = null;
let _ytdlpFetch: ((id: string) => Promise<AudioFetchResult>) | null = null;

async function detectYtDlp(): Promise<void> {
  if (_preferYtDlp !== null) return;
  const isNode =
    typeof (globalThis as any).process !== "undefined" &&
    !!(globalThis as any).process?.versions?.node;
  if (!isNode) { _preferYtDlp = false; return; }
  try {
    const mod = await import("./youtube-ytdlp.js");
    const ok = await mod.probeYtDlp();
    if (ok) {
      _ytdlpFetch = mod.fetchAudioYtDlp;
      _preferYtDlp = true;
    } else {
      _preferYtDlp = false;
    }
  } catch {
    _preferYtDlp = false;
  }
}

export async function fetchAudioStream(videoId: string): Promise<AudioFetchResult> {
  await detectYtDlp();
  if (_preferYtDlp && _ytdlpFetch) {
    try {
      return await _ytdlpFetch(videoId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("yt-dlp fetch failed, falling back to youtubei.js:", (e as Error).message);
    }
  }
  return fetchAudioStreamYtJs(videoId);
}

async function fetchAudioStreamYtJs(videoId: string): Promise<AudioFetchResult> {
  const yt = await client();

  let chosen: any = null;
  let info: any = null;
  let lastErr: unknown = null;
  for (const c of CLIENT_FALLBACK) {
    try {
      info = await yt.getInfo(videoId, c as any);
      try {
        chosen = info.chooseFormat({ type: "audio", quality: "best", format: "mp4" });
      } catch {
        chosen = info.chooseFormat({ type: "audio", quality: "best" });
      }
      if (chosen && (chosen.url || chosen.signature_cipher)) break;
      chosen = null;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!chosen) {
    const reason = lastErr instanceof Error ? lastErr.message : "no playable format";
    throw new Error(`No audio format available for ${videoId}: ${reason}`);
  }

  // IOS/ANDROID often hand us a ready-to-fetch URL. If we ended up with the
  // WEB format, decipher signs it via the player JS we loaded.
  let url: string = chosen.url ?? "";
  if (!url) {
    try {
      url = chosen.decipher(yt.session.player);
    } catch (e) {
      throw new Error(`decipher failed for ${videoId}: ${(e as Error).message}`);
    }
  }
  if (!url) throw new Error(`No valid URL for ${videoId} after decipher`);

  const mime: string = chosen.mime_type ?? "audio/mp4";
  const bitrate: number | null =
    typeof chosen.bitrate === "number" ? chosen.bitrate : null;
  const approxSize: number | null =
    typeof chosen.content_length === "number" ? chosen.content_length
    : (typeof chosen.contentLength === "string" ? parseInt(chosen.contentLength, 10) : null);

  // Stream the actual bytes through. googlevideo CDN doesn't allow CORS from
  // browsers, so this proxy is the load-bearing reason the Worker exists.
  const r = await fetch(url, {
    headers: {
      // YouTube serves slightly different bytes / availability per UA. WEB
      // player UA matches what `youtubei.js` deciphered against.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!r.ok) throw new Error(`googlevideo returned ${r.status} for ${videoId}`);
  if (!r.body) throw new Error(`googlevideo returned empty body for ${videoId}`);

  const headerLen = r.headers.get("Content-Length");
  const contentLength = headerLen ? parseInt(headerLen, 10) : approxSize;

  return {
    info: { url, mime, bitrate, approx_size_bytes: approxSize },
    body: r.body,
    contentLength,
  };
}
