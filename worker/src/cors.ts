// CORS helper. Allow-list is read from env at request time so the same handler
// runs in CF Workers (env injected) and Node (env read from process.env).

export function corsHeaders(req: Request, allowed: string): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const list = allowed.split(",").map(s => s.trim()).filter(Boolean);
  const allow = list.includes("*") || list.includes(origin) ? (origin || "*") : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function preflight(req: Request, allowed: string): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req, allowed) });
}

export function json(body: unknown, status: number, req: Request, allowed: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req, allowed),
    },
  });
}

export function errorJson(message: string, status: number, req: Request, allowed: string): Response {
  return json({ error: message }, status, req, allowed);
}
