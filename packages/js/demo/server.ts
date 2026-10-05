/**
 * A stand-in for an app that uses Swish Deposit, for trying the widget with
 * a real passkey and wallet:
 *
 *   npm run demo        (from packages/js; reads demo/.env)
 *
 * Its server side holds the secret key and creates deposits; its page holds
 * the publishable key and opens the widget. Open http://localhost:5173 —
 * `localhost`, not 127.0.0.1: the passkey belongs to that exact site.
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, ".env") });

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (packages/js/demo/.env)`);
  return value;
};

const PORT = Number(process.env.PORT ?? 5173);
const API_URL = (process.env.SWISH_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");
const CLUSTER = process.env.SWISH_CLUSTER ?? "devnet";
const PUBLISHABLE_KEY = required("SWISH_PUBLISHABLE_KEY");
const SECRET_KEY = required("SWISH_SECRET_KEY");

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

/** The app's server talking to Swish with its secret key. */
async function swish(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(API_URL + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${SECRET_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const HOSTED = process.env.NODE_ENV === "production";
let bundled: Promise<string> | undefined;

async function bundle(): Promise<string> {
  const out = await build({
    entryPoints: [join(here, "../src/index.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
  });
  return out.outputFiles[0]!.text;
}

/**
 * The widget, bundled from source: on every load locally so edits show on
 * refresh, once when hosted.
 */
function widget(): Promise<string> {
  if (!HOSTED) return bundle();
  bundled ??= bundle().catch((e) => {
    bundled = undefined;
    throw e;
  });
  return bundled;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await readFile(join(here, "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/widget.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await widget());
    }
    if (req.method === "GET" && url.pathname === "/config") {
      return json(res, 200, { publishableKey: PUBLISHABLE_KEY, apiUrl: API_URL, cluster: CLUSTER });
    }
    if (req.method === "POST" && url.pathname === "/deposits") {
      const { amount, destination } = await readJson(req);
      const created = await swish("/v1/deposits", { amount, token: "USDC", destination });
      return json(res, created.status, created.body);
    }
    const id = /^\/deposits\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1];
    if (req.method === "GET" && id) {
      const found = await swish(`/v1/deposits/${id}`);
      return json(res, found.status, found.body);
    }
    json(res, 404, { error: { code: "not_found", message: "Not found" } });
  } catch (e) {
    console.error("[demo]", e);
    json(res, 500, { error: { code: "internal", message: (e as Error).message } });
  }
}).listen(PORT, () => {
  console.log(`demo app on http://localhost:${PORT} → Swish API ${API_URL} (${CLUSTER})`);
});
