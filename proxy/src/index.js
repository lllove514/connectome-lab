// Minimal Cloudflare Worker that proxies the Connectome Lab tutor to DeepSeek so
// the API key never reaches the browser. No framework, no KV, no Durable Objects.
//
// The key lives only in the DEEPSEEK_API_KEY secret, never in this file or the
// repo. Set it once:
//   npx wrangler secret put DEEPSEEK_API_KEY

const ALLOWED_ORIGIN = "https://lllove514.github.io"; // scheme + host, no trailing slash
const UPSTREAM = "https://api.deepseek.com/chat/completions"; // the only endpoint we forward to
const ALLOWED_MODEL = "deepseek-chat"; // the only model we allow
const MAX_TOKENS = 500; // hard server-side cap, the real cost backstop

// Light, best-effort per-IP limit. In-memory only, so it resets when the isolate
// recycles and is per-colo rather than global. It just trims obvious hammering;
// the real protection is MAX_TOKENS plus the DeepSeek account spending limit.
const RATE_LIMIT = 20; // requests
const RATE_WINDOW_MS = 60 * 1000; // per minute per IP
const hits = new Map(); // ip -> { count, start }

function corsHeaders() {
  // Only ever the one allowed origin. Never "*".
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(ip, { count: 1, start: now });
    return false;
  }
  rec.count++;
  return rec.count > RATE_LIMIT;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    // Preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Only the hosted site may call this.
    if (origin !== ALLOWED_ORIGIN) {
      return jsonError(403, "Origin not allowed.");
    }
    if (request.method !== "POST") {
      return jsonError(405, "Use POST.");
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) {
      return jsonError(429, "Too many requests, give it a moment.");
    }

    if (!env.DEEPSEEK_API_KEY) {
      return jsonError(500, "Server is missing DEEPSEEK_API_KEY.");
    }

    // Parse and validate the body before spending anything upstream.
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "Body must be JSON.");
    }
    if (body.model !== ALLOWED_MODEL) {
      return jsonError(400, `Only the ${ALLOWED_MODEL} model is allowed.`);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return jsonError(400, "A non-empty messages array is required.");
    }

    // Cap max_tokens no matter what the client asked for.
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);

    // Forward with the secret key. When the client asked for stream:true, the
    // upstream body is a stream and passes straight back to the browser.
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.DEEPSEEK_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const headers = corsHeaders();
    const contentType = upstream.headers.get("Content-Type");
    if (contentType) headers["Content-Type"] = contentType;
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
