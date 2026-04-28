import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const dst = (process.env.SVC_DST || "").replace(/\/+$/, "");
const pfx = process.env.SVC_PFX || "";

const ignore = new Set([
  "/", "/favicon.ico", "/robots.txt", "/sitemap.xml",
  "/.well-known/security.txt",
  "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png",
]);

const drop = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
]);

function clean(raw) {
  const out = {};
  let ip = null;
  for (const h in raw) {
    if (drop.has(h) || (h[0] === "x" && h.startsWith("x-vercel-"))) continue;
    const v = raw[h];
    if (h === "x-real-ip") { ip = v; continue; }
    if (h === "x-forwarded-for") { ip = ip || v; continue; }
    out[h] = typeof v === "string" ? v : v.join(", ");
  }
  if (ip) out["x-forwarded-for"] = ip;
  return out;
}

export default async function pipe(req, res) {
  if (!dst) return void (res.statusCode = 500, res.end("not configured"));

  const u = req.url;
  const qi = u.indexOf("?");
  const seg = qi < 0 ? u : u.slice(0, qi);

  if (ignore.has(seg)) {
    res.setHeader("cache-control", "public, max-age=86400, immutable");
    return void (res.statusCode = 404, res.end());
  }

  if (pfx && !seg.startsWith(pfx)) {
    res.setHeader("cache-control", "public, max-age=86400, immutable");
    return void (res.statusCode = 404, res.end());
  }

  const ac = new AbortController();
  const stop = () => ac.abort();
  req.once("close", stop);

  try {
    const m = req.method;
    const o = { method: m, headers: clean(req.headers), redirect: "manual", signal: ac.signal };
    if (m !== "GET" && m !== "HEAD") {
      o.body = Readable.toWeb(req);
      o.duplex = "half";
    }

    const r = await fetch(dst + u, o);
    res.once("close", stop);

    res.statusCode = r.status;
    r.headers.forEach((v, k) => {
      if (k !== "transfer-encoding") try { res.setHeader(k, v); } catch {}
    });

    if (r.body) await pipeline(Readable.fromWeb(r.body), res);
    else res.end();
  } catch {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("cache-control", "no-store");
      res.end("Bad Gateway");
    } else {
      try { res.end(); } catch {}
    }
  }
}
