// Node/Bun entrypoint — same `handle()` as the CF Worker, served over plain HTTP.
// Use this when self-hosting on a Pi (or anywhere). It also serves the
// `frontend/` directory as static files, so a single port (default 8787)
// gives you both the UI and the API on the same origin — no CORS at all.
//
//   npm run serve-node     # tsx src/node-server.ts
//
// Env:
//   PORT                  default 8787
//   ALLOWED_ORIGINS       default "*" (single-origin self-host has no CORS need)
//   FRONTEND_DIR          default "../frontend"
//   AUTO_OPEN             default unset (set to "1" to open the browser)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./index.js";

const PORT = parseInt(process.env.PORT ?? "8787", 10);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?? "*";
const HERE = fileURLToPath(new URL(".", import.meta.url).toString());
const FRONTEND_DIR = resolvePath(
  process.env.FRONTEND_DIR ?? join(HERE, "..", "..", "frontend"),
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

async function nodeToWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const proto = "http";
  const url = `${proto}://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else if (typeof v === "string") headers.set(k, v);
  }

  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

async function writeWebResponse(res: ServerResponse, web: Response): Promise<void> {
  res.statusCode = web.status;
  web.headers.forEach((v, k) => res.setHeader(k, v));
  if (!web.body) { res.end(); return; }
  // Stream the body.
  const reader = web.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

async function serveStatic(reqPath: string, res: ServerResponse): Promise<boolean> {
  // Normalise + prevent path escape from FRONTEND_DIR.
  let rel = decodeURIComponent(reqPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const safe = normalize(rel).replace(/^([/\\]+)/, "");
  const full = join(FRONTEND_DIR, safe);
  if (!full.startsWith(FRONTEND_DIR + sep) && full !== FRONTEND_DIR) return false;

  try {
    const s = await stat(full);
    if (!s.isFile()) return false;
    const data = await readFile(full);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[extname(full).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Cache-Control", "no-cache");
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const API_PATHS = new Set(["/resolve", "/match", "/health"]);
function isApiRequest(pathname: string): boolean {
  return API_PATHS.has(pathname) || pathname.startsWith("/audio/");
}

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (isApiRequest(pathname) || req.method === "OPTIONS") {
      const webReq = await nodeToWebRequest(req);
      const webRes = await handle(webReq, { ALLOWED_ORIGINS });
      await writeWebResponse(res, webRes);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const served = await serveStatic(pathname, res);
      if (served) return;
      // SPA fallback: any unknown GET → index.html (lets us add /j/{id} later)
      const fellBack = await serveStatic("/index.html", res);
      if (fellBack) return;
    }
    res.statusCode = 404;
    res.end("not found");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.statusCode = 500;
    res.end(`server error: ${msg}`);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`musicdownweb listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`  frontend dir: ${FRONTEND_DIR}`);
});
