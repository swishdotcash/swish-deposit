export class DemoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

export async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new DemoError(415, "use_json", "Use a JSON request.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096)
      throw new DemoError(413, "too_large", "The request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DemoError(400, "bad_json", "The request is not valid JSON.");
  }
}

export function checkOrigin(req, publicOrigin) {
  const origin = req.headers.origin;
  if (req.headers["sec-fetch-site"] === "cross-site")
    throw new DemoError(
      403,
      "wrong_origin",
      "Open the demo to make this request.",
    );
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    /* Refused below. */
  }
  if (origin !== publicOrigin && host !== req.headers.host)
    throw new DemoError(
      403,
      "wrong_origin",
      "Open the demo to make this request.",
    );
}
