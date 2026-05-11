// yt-dlp subprocess fallback. Only loadable on Node/Bun (uses child_process).
//
// This exists because as of mid-2026, YouTube's po_token enforcement
// returns format objects with empty `url` fields to pure-JS clients
// (youtubei.js, @distube/ytdl-core, etc.). yt-dlp is the only library
// that keeps up with YouTube's anti-bot weekly. We shell out to it.
//
// We write to a temp .m4a, then stream the file back. Two reasons over
// `-o -` (stdout):
//   1. YouTube serves audio as HLS playlists of raw AAC/ADTS. With stdout
//      yt-dlp dumps the raw bitstream; with a file + `--remux-video m4a`
//      ffmpeg wraps it in a proper MP4 container (which the tagger needs).
//   2. The file is gone before the response closes, so no leak on cancel.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioFetchResult } from "./youtube.js";

const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

function tempPath(videoId: string): string {
  const safe = videoId.replace(/[^\w-]/g, "");
  return join(tmpdir(), `mdw-${safe}-${process.pid}-${Date.now()}.m4a`);
}

function nodeStreamToWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let closed = false;
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };
      nodeStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try { controller.enqueue(new Uint8Array(chunk)); } catch {}
      });
      nodeStream.on("end", safeClose);
      nodeStream.on("error", (err: Error) => {
        if (closed) return;
        closed = true;
        try { controller.error(err); } catch {}
      });
    },
    cancel() { (nodeStream as any).destroy?.(); },
  });
}

export async function fetchAudioYtDlp(videoId: string): Promise<AudioFetchResult> {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const outPath = tempPath(videoId);
  const args = [
    "-f", "bestaudio[ext=m4a]/bestaudio",
    "--remux-video", "m4a",
    "--no-warnings", "--quiet",
    "--no-playlist",
    "-o", outPath,
    url,
  ];

  // Run yt-dlp to completion. Streaming during download would be cleaner UX
  // but produces an HLS AAC bitstream (no MP4 container), which breaks the
  // browser-side tagger. Temp-file + remux yields a valid m4a.
  const exitCode = await new Promise<number>((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(0);
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().slice(0, 400) || "no stderr"}`));
    });
    proc.on("error", (err) => reject(err));
  });
  if (exitCode !== 0) throw new Error("yt-dlp non-zero exit");

  // Determine size for Content-Length so the frontend gets a real progress bar.
  const stat = await import("node:fs/promises").then(m => m.stat(outPath));
  const contentLength = stat.size;

  const nodeStream = createReadStream(outPath);
  const body = nodeStreamToWebStream(nodeStream);

  // Clean up the temp file after the stream is consumed. `close` fires when
  // the read stream ends OR is destroyed (cancel path).
  nodeStream.on("close", () => {
    unlink(outPath).catch(() => { /* best-effort */ });
  });

  return {
    info: { url: `ytdlp://${videoId}`, mime: "audio/mp4", bitrate: null, approx_size_bytes: contentLength },
    body,
    contentLength,
  };
}

export async function probeYtDlp(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(YTDLP_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let ok = false;
      p.stdout.on("data", () => { ok = true; });
      p.on("close", (code) => resolve(ok && code === 0));
      p.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
