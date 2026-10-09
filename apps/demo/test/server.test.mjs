import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createFunding } from "../server/funding.mjs";
import { createHandoffs } from "../server/handoffs.mjs";
import { demoRoutes } from "../server/routes.mjs";

const wallet = "CG1gKGxUuRHKAnYiTzVbf6aWkFJUyBtCqy5MSFLoHhFk";
const other = "9GeTUgtsXahBnXBYgVbx31yUpbnKuda6ySrjnv3aEDAh";
const dirs = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function bank() {
  const dir = await mkdtemp(join(tmpdir(), "swish-demo-test-"));
  dirs.push(dir);
  const journalPath = join(dir, "claims.json");
  const source = {
    status: vi.fn(),
    balances: vi.fn(),
    prepare: vi.fn(async () => ({
      signature: randomUUID(),
      wire: "signed-wire",
      lastValidBlockHeight: "100",
    })),
    send: vi.fn(async (r) => {
      expect(
        JSON.parse(await readFile(journalPath, "utf8"))[r.id].signature,
      ).toBe(r.signature);
    }),
    inspect: vi.fn(async () => "confirmed"),
  };
  return {
    source,
    journalPath,
    funding: createFunding({ source, journalPath }),
  };
}
describe("open devnet funding", () => {
  it("saves before broadcast and replays one request without another transfer", async () => {
    const { funding, source } = await bank();
    const id = randomUUID();
    const [a, b] = await Promise.all([
      funding.claim(wallet, id),
      funding.claim(wallet, id),
    ]);
    expect(a).toEqual(b);
    expect(a.status).toBe("confirmed");
    expect(source.prepare).toHaveBeenCalledTimes(1);
    expect(source.send).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveProperty("wire");
  });
  it("allows another request from the same wallet without an invite", async () => {
    const { funding, source } = await bank();
    await funding.claim(wallet, randomUUID());
    await funding.claim(wallet, randomUUID());
    expect(source.send).toHaveBeenCalledTimes(2);
  });
  it("keeps an uncertain transfer pending through a restart and a new request ID", async () => {
    const { funding, source, journalPath } = await bank();
    source.send.mockRejectedValue(new Error("reply lost"));
    source.inspect.mockResolvedValue("pending");
    const first = await funding.claim(wallet, randomUUID());
    const restarted = createFunding({ source, journalPath });
    expect(await restarted.claim(wallet, randomUUID())).toEqual(first);
    source.inspect.mockResolvedValue("confirmed");
    expect((await restarted.get(first.id)).status).toBe("confirmed");
    expect(source.prepare).toHaveBeenCalledTimes(1);
    expect(source.send).toHaveBeenCalledTimes(1);
  });
  it("does not broadcast if preparation fails", async () => {
    const { funding, source } = await bank();
    source.prepare.mockRejectedValue(new Error("empty bank"));
    await expect(funding.claim(wallet, randomUUID())).rejects.toThrow(
      "empty bank",
    );
    expect(source.send).not.toHaveBeenCalled();
  });
  it("does not reuse a request for another wallet", async () => {
    const { funding, source } = await bank();
    const id = randomUUID();
    await funding.claim(wallet, id);
    await expect(funding.claim(other, id)).rejects.toMatchObject({
      code: "request_used",
    });
    expect(source.send).toHaveBeenCalledTimes(1);
  });
  it("allows a new request after a transfer has definitively failed", async () => {
    const { funding, source } = await bank();
    source.inspect.mockResolvedValue("failed");
    await funding.claim(wallet, randomUUID());
    await funding.claim(wallet, randomUUID());
    expect(source.send).toHaveBeenCalledTimes(2);
  });
  it("rejects bad addresses and request IDs before it prepares funds", async () => {
    const { funding, source } = await bank();
    await expect(
      funding.claim("not-a-wallet", randomUUID()),
    ).rejects.toMatchObject({ code: "bad_wallet" });
    await expect(funding.claim(wallet, "invite-code")).rejects.toMatchObject({
      code: "bad_request_id",
    });
    expect(source.prepare).not.toHaveBeenCalled();
  });
});
function handoff() {
  let now = 1000;
  const deposit = {
    id: "deposit-1",
    clientSecret: "secret",
    amount: "5",
    status: "created",
  };
  const readDeposit = vi.fn(async () => ({
    status: 200,
    body: { id: deposit.id, status: deposit.status, amount: "5" },
  }));
  const links = createHandoffs({
    getDeposit: (id) => (id === deposit.id ? deposit : null),
    readDeposit,
    now: () => now,
    lifetimeMs: 100,
  });
  return {
    deposit,
    links,
    readDeposit,
    expire: () => {
      now += 101;
    },
  };
}
describe("device links", () => {
  it("requires the client secret and rejects invalid Unicode without a server error", () => {
    const { links, deposit } = handoff();
    expect(() =>
      links.create({ ...deposit, clientSecret: "wrong!" }),
    ).toThrow();
    expect(() =>
      links.create({ ...deposit, clientSecret: "éééééé" }),
    ).toThrow();
  });
  it("allows only one active device and supports release to another device", async () => {
    const { links, deposit } = handoff();
    const link = links.create(deposit);
    const a = randomUUID();
    const b = randomUUID();
    expect((await links.open(link.token, a)).deposit).toEqual({
      id: deposit.id,
      clientSecret: deposit.clientSecret,
    });
    await expect(links.open(link.token, b)).rejects.toMatchObject({
      code: "link_in_use",
    });
    links.progress(link.token, a, "release");
    await links.open(link.token, b);
    expect((await links.status(link.token, link.ownerKey)).opened).toBe(true);
    expect(() => links.progress(link.token, a, "sending")).toThrow();
  });
  it("does not let the remote device set the deposit result", async () => {
    const { links, deposit } = handoff();
    const link = links.create(deposit);
    const device = randomUUID();
    await links.open(link.token, device);
    expect(() => links.progress(link.token, device, "succeeded")).toThrow();
    expect((await links.status(link.token, link.ownerKey)).result.status).toBe(
      "created",
    );
    deposit.status = "succeeded";
    expect((await links.open(link.token, randomUUID())).result.status).toBe(
      "succeeded",
    );
  });
  it("expires old links and replaces previous links for the same deposit", async () => {
    const { links, deposit, expire } = handoff();
    const old = links.create(deposit);
    const next = links.create(deposit);
    await expect(links.open(old.token, randomUUID())).rejects.toMatchObject({
      code: "link_expired",
    });
    expire();
    await expect(links.open(next.token, randomUUID())).rejects.toMatchObject({
      code: "link_expired",
    });
  });
  it("requires the owner key to read or cancel a link", async () => {
    const { links, deposit } = handoff();
    const link = links.create(deposit);
    await expect(links.status(link.token, "bad")).rejects.toMatchObject({
      code: "not_allowed",
    });
    expect(() => links.cancel(link.token, "bad")).toThrow();
    links.cancel(link.token, link.ownerKey);
    await expect(links.open(link.token, randomUUID())).rejects.toMatchObject({
      code: "link_expired",
    });
  });
});
async function dispatch(handler, path, data, headers = {}) {
  const req = Readable.from(
    data === undefined ? [] : [Buffer.from(JSON.stringify(data))],
  );
  req.method = data === undefined ? "GET" : "POST";
  req.headers = {
    host: "demo.example.com",
    "content-type": "application/json",
    ...headers,
  };
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const handled = await handler(
    req,
    res,
    new URL(path, "https://demo.example.com"),
  );
  return {
    handled,
    status: res.writeHead.mock.calls[0]?.[0],
    body: res.end.mock.calls[0]?.[0] && JSON.parse(res.end.mock.calls[0][0]),
  };
}
describe("isolated demo routes", () => {
  const options = {
    cluster: "devnet",
    getDeposit: () => null,
    readDeposit: vi.fn(),
    env: {},
    funding: { claim: vi.fn(async () => ({ status: "confirmed" })) },
  };
  it("leaves existing API paths to the existing handler", async () => {
    expect(
      (await dispatch(demoRoutes(options), "/api/deposits", {})).handled,
    ).toBe(false);
  });
  it("accepts a funding request without an invite", async () => {
    expect(
      (
        await dispatch(demoRoutes(options), "/api/demo/funding/claims", {
          wallet,
          id: randomUUID(),
        })
      ).status,
    ).toBe(200);
  });
  it("blocks mainnet and cross-site browser requests", async () => {
    expect(
      (
        await dispatch(
          demoRoutes({ ...options, cluster: "mainnet-beta" }),
          "/api/demo/funding/claims",
          {},
        )
      ).body.error.code,
    ).toBe("devnet_only");
    expect(
      (
        await dispatch(
          demoRoutes(options),
          "/api/demo/funding/claims",
          {},
          { origin: "https://other.example", "sec-fetch-site": "cross-site" },
        )
      ).status,
    ).toBe(403);
  });
  it("does not expose private error details", async () => {
    const handler = demoRoutes({
      ...options,
      funding: {
        claim: () => {
          throw new Error("private-key-path");
        },
      },
    });
    const response = await dispatch(handler, "/api/demo/funding/claims", {});
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("private-key-path");
  });
});
