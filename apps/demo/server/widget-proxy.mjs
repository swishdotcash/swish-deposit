import { body, checkOrigin, DemoError, json } from "./http.mjs";

// Expose only the browser widget endpoints through the demo's HTTPS origin.
// Never forward cookies, bearer credentials, or the demo server's secret key.
export function widgetProxy({
  apiUrl,
  publishableKey,
  publicOrigin,
  fetcher = fetch,
}) {
  const allowed =
    /^\/v1\/(?:deposits\/[0-9a-f-]{36}\/(?:challenge|sources|submit)|setup\/(?:passkey|wallet\/(?:prepare|limit|allowance|unlink|submit)))$/i;
  return async (req, res, url) => {
    if (!url.pathname.startsWith("/api/swish/")) return false;
    try {
      checkOrigin(req, publicOrigin);
      const path = url.pathname.slice("/api/swish".length);
      if (req.method !== "POST" || !allowed.test(path) || url.search)
        throw new DemoError(
          404,
          "not_found",
          "This widget route was not found.",
        );
      const input = await body(req);
      const origin = req.headers.origin ?? publicOrigin;
      const response = await fetcher(apiUrl.replace(/\/+$/, "") + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Swish-Key": publishableKey,
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(90000),
        redirect: "error",
      });
      json(res, response.status, await response.json());
    } catch (e) {
      json(res, e instanceof DemoError ? e.status : 502, {
        error: {
          code: e instanceof DemoError ? e.code : "upstream_unavailable",
          message:
            e instanceof DemoError
              ? e.message
              : "The deposit API could not be reached. Try again.",
        },
      });
    }
    return true;
  };
}
