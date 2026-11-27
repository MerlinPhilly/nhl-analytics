// Cloudflare Worker: read-only relay for the NHL's live score feed.
// The NHL feed doesn't allow other websites to read it from the browser (CORS),
// so this passes it through for merlinphilly.github.io only, cached 15 seconds.
const ALLOWED_ORIGIN = "https://merlinphilly.github.io";
const PATHS = /^\/v1\/(score\/(now|\d{4}-\d{2}-\d{2})|gamecenter\/\d+\/(landing|boxscore))$/;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = { "access-control-allow-origin": ALLOWED_ORIGIN, "vary": "origin" };
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...cors, "access-control-allow-methods": "GET" } });
    if (request.method !== "GET" || !PATHS.test(url.pathname)) return new Response("Not found", { status: 404, headers: cors });
    const upstream = await fetch("https://api-web.nhle.com" + url.pathname, { cf: { cacheTtl: 15, cacheEverything: true } });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=15" },
    });
  },
};
