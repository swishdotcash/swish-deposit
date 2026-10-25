// Serves the built frame (dist/). Any site may embed it: the API decides
// which pages may use which app's key.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
const PORT = Number(process.env.PORT ?? 5174);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  let path;
  try {
    path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    if (path.includes("\0")) throw new URIError("invalid path");
  } catch {
    return res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid request path");
  }
  if (path === "/health") return res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  let file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  const hashed = file.includes(`${dist}/assets/`);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    // The button in an app's page is set in this font.
    ...(path.startsWith("/fonts/") ? { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" } : {}),
  });
  createReadStream(file).pipe(res);
});
server.listen(PORT, "::", () => console.log(`swish-deposit frame on :${server.address().port}`));
