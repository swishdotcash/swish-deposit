import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { widgetProxy } from "../server/widget-proxy.mjs";
async function send(path, headers = {}) {
  const fetcher = vi.fn(async () => ({
    status: 200,
    json: async () => ({ ok: true }),
  }));
  const handler = widgetProxy({
    apiUrl: "http://localhost:4190",
    publishableKey: "swishpub_demo",
    publicOrigin: "https://demo.trycloudflare.com",
    fetcher,
  });
  const req = Readable.from([Buffer.from('{"wallet":"wallet"}')]);
  req.method = "POST";
  req.headers = {
    host: "localhost:5183",
    origin: "https://demo.trycloudflare.com",
    "content-type": "application/json",
    ...headers,
  };
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const handled = await handler(
    req,
    res,
    new URL(path, "https://demo.trycloudflare.com"),
  );
  return { fetcher, handled, status: res.writeHead.mock.calls[0]?.[0] };
}
it("proxies browser requests using only the configured publishable key", async () => {
  const { fetcher, status } = await send(
    "/api/swish/v1/setup/wallet/allowance",
    {
      authorization: "Bearer private",
      cookie: "session=private",
      "x-swish-key": "another-key",
    },
  );
  expect(status).toBe(200);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe("http://localhost:4190/v1/setup/wallet/allowance");
  expect(init.headers).toEqual({
    "Content-Type": "application/json",
    "X-Swish-Key": "swishpub_demo",
    Origin: "https://demo.trycloudflare.com",
  });
});
it.each([
  "/api/swish/v1/deposits",
  "/api/swish/admin",
  "/api/swish/v1/setup/passkey?redirect=https://other.example",
])("does not proxy unlisted routes: %s", async (path) => {
  const { fetcher, status } = await send(path);
  expect(status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
});
it("refuses another browser origin", async () => {
  const { fetcher, status } = await send("/api/swish/v1/setup/passkey", {
    origin: "https://other.example",
  });
  expect(status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
it("leaves other demo routes to their existing handlers", async () => {
  const { handled, fetcher } = await send("/api/deposits");
  expect(handled).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
