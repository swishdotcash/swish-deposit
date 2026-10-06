// The playground's server: serves the built page (dist/) and plays the part of
// the demo app's own backend. It holds the secret key, creates deposits, and
// tells the page what it sees, including the webhook Swish sends.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const PORT = Number(process.env.PORT ?? 5183);
const API_URL = (process.env.SWISH_API_URL ?? "https://api.swish.cash").replace(/\/+$/, "");
const FRAME_URL = (process.env.SWISH_FRAME_URL ?? "https://pay.swish.cash").replace(/\/+$/, "");
const CLUSTER = process.env.SWISH_CLUSTER ?? "devnet";
const PUBLISHABLE_KEY = required("SWISH_PUBLISHABLE_KEY");
const SECRET_KEY = required("SWISH_SECRET_KEY");
// The demo app's account: every deposit made here lands in it.
const DESTINATION = process.env.SWISH_DEMO_DESTINATION ?? "NG5dUukC6hjXcbr9mxyPdYoEzGkfinJP7ceVVNtrzeG";

const MIN_AMOUNT = 1;
// Test USDC is scarce: a small cap keeps one visitor's faucet money going.
const MAX_AMOUNT = 5;
const WATCH_FOR_MS = 150_000;
const KEEP_FOR_MS = 10 * 60_000;
const WEBHOOK_GRACE_MS = 4_000;
const WEBHOOK_MAX_AGE_S = 300;
const CREATES_PER_MINUTE = 20;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** This server talking to Swish with its secret key. */
async function swish(path, body) {
  const res = await fetch(API_URL + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${SECRET_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/** What this server has seen of each deposit, for the page's log. */
const deposits = new Map();

function say(id, kind, text) {
  const d = deposits.get(id);
  if (!d) return;
  const event = { kind, text, at: Date.now() };
  d.events.push(event);
  for (const res of d.listeners) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Reads the deposit until it is finished, as an app without webhooks would. */
function watch(id) {
  const d = deposits.get(id);
  const started = Date.now();
  let last = "created";
  d.timer = setInterval(async () => {
    if (Date.now() - started > WATCH_FOR_MS) return clearInterval(d.timer);
    try {
      const { status, body } = await swish(`/v1/deposits/${id}`);
      if (status !== 200 || body.status === last) return;
      last = body.status;
      if (last === "submitted") return say(id, "pending", "status · submitted");
      clearInterval(d.timer);
      // The webhook says it first when one is set up; this is the fallback.
      setTimeout(() => {
        if (!d.webhook) say(id, last === "succeeded" ? "success" : "error", `status · ${last}`);
      }, WEBHOOK_GRACE_MS);
    } catch {
      // Read again on the next tick.
    }
  }, 1000);
  setTimeout(() => {
    clearInterval(d.timer);
    for (const res of d.listeners) res.end();
    deposits.delete(id);
  }, KEEP_FOR_MS);
}

/** `Swish-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, keyed with sha256(secret key) as hex. */
function signedBySwish(header, body) {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > WEBHOOK_MAX_AGE_S) return false;
  const key = createHash("sha256").update(SECRET_KEY).digest("hex");
  const expected = Buffer.from(createHmac("sha256", key).update(`${t}.${body}`).digest("hex"));
  const given = Buffer.from(parts.v1);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const creates = new Map();
function tooMany(ip) {
  const now = Date.now();
  const recent = (creates.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  creates.set(ip, recent);
  return recent.length > CREATES_PER_MINUTE;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const path = normalize(decodeURIComponent(url.pathname));
    if (path === "/health") return json(res, 200, { ok: true });

    if (req.method === "GET" && path === "/api/config") {
      return json(res, 200, { publishableKey: PUBLISHABLE_KEY, apiUrl: API_URL, cluster: CLUSTER, frameUrl: FRAME_URL });
    }

    if (req.method === "POST" && path === "/api/deposits") {
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
      if (tooMany(ip)) return json(res, 429, { error: { code: "slow_down", message: "Too many deposits started. Try again in a minute." } });
      const { amount } = JSON.parse((await readBody(req)) || "{}");
      const value = Number(amount);
      if (!/^\d+(\.\d{1,6})?$/.test(String(amount)) || value < MIN_AMOUNT || value > MAX_AMOUNT) {
        return json(res, 400, { error: { code: "bad_amount", message: `Enter an amount between ${MIN_AMOUNT} and ${MAX_AMOUNT} USDC.` } });
      }
      const created = await swish("/v1/deposits", { amount: String(amount), token: "USDC", destination: DESTINATION });
      if (created.status >= 300) return json(res, created.status, created.body);
      const { id, client_secret } = created.body;
      deposits.set(id, { events: [], listeners: new Set(), webhook: false, timer: null });
      say(id, "sent", "POST /v1/deposits · created");
      watch(id);
      return json(res, 201, { id, client_secret });
    }

    const events = /^\/api\/deposits\/([0-9a-f-]{36})\/events$/.exec(path)?.[1];
    if (req.method === "GET" && events) {
      const d = deposits.get(events);
      if (!d) return json(res, 404, { error: { code: "not_found", message: "Not found" } });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      for (const event of d.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      d.listeners.add(res);
      req.on("close", () => d.listeners.delete(res));
      return;
    }

    if (req.method === "POST" && path === "/api/webhooks/swish") {
      const body = await readBody(req);
      if (!signedBySwish(req.headers["swish-signature"], body)) return json(res, 401, { error: { code: "bad_signature", message: "Not signed by Swish" } });
      const { type, data } = JSON.parse(body);
      const d = deposits.get(data?.id);
      if (d) {
        d.webhook = true;
        say(data.id, type === "deposit.succeeded" ? "success" : "error", `webhook · ${type}`);
      }
      return json(res, 200, { received: true });
    }

    if (path.startsWith("/api/")) return json(res, 404, { error: { code: "not_found", message: "Not found" } });

    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
    const hashed = file.includes(`${dist}/assets/`);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(file).pipe(res);
  } catch (e) {
    console.error("[playground]", e);
    json(res, 500, { error: { code: "internal", message: "Something went wrong" } });
  }
}).listen(PORT, "::", () => console.log(`swish-deposit playground on :${PORT} → ${API_URL} (${CLUSTER})`));
