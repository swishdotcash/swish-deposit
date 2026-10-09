import { randomBytes, timingSafeEqual } from "node:crypto";
import { DemoError } from "./http.mjs";

const token = () => randomBytes(32).toString("base64url");
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createHandoffs({
  getDeposit,
  readDeposit,
  now = Date.now,
  lifetimeMs = 10 * 60_000,
}) {
  const links = new Map();
  const missing = () =>
    new DemoError(
      410,
      "link_expired",
      "This link is no longer valid. Open a new link from the original screen.",
    );
  function get(key) {
    const link = links.get(key);
    if (!link || link.expiresAt <= now()) {
      links.delete(key);
      throw missing();
    }
    return link;
  }
  function owner(key, ownerKey) {
    const link = get(key);
    if (!same(ownerKey, link.ownerKey))
      throw new DemoError(
        403,
        "not_allowed",
        "This link belongs to another session.",
      );
    return link;
  }
  async function result(link) {
    const response = await readDeposit(link.deposit.id);
    if (response.status !== 200)
      throw new DemoError(
        503,
        "unavailable",
        "The deposit status could not be read. Try again.",
      );
    return response.body;
  }
  return {
    create({ id, clientSecret }) {
      const deposit = getDeposit(id);
      if (!deposit || !same(clientSecret, deposit.clientSecret))
        throw new DemoError(
          404,
          "deposit_not_found",
          "Open a new deposit before you create a link.",
        );
      for (const [key, value] of links)
        if (value.expiresAt <= now() || value.deposit.id === id)
          links.delete(key);
      const key = token();
      const ownerKey = token();
      const expiresAt = now() + lifetimeMs;
      links.set(key, {
        deposit: { id, clientSecret },
        ownerKey,
        expiresAt,
        device: null,
        opened: false,
        phase: "waiting",
      });
      return { token: key, ownerKey, expiresAt };
    },
    async open(key, device) {
      const link = get(key);
      if (typeof device !== "string" || !/^[0-9a-f-]{36}$/i.test(device))
        throw new DemoError(400, "bad_device", "Open the link again.");
      const deposit = await result(link);
      if (deposit.status === "succeeded" || deposit.status === "failed")
        return { result: deposit, expiresAt: link.expiresAt };
      if (link.device && link.device !== device)
        throw new DemoError(
          409,
          "link_in_use",
          "This deposit is open on another device. Return to that device to continue.",
        );
      link.device = device;
      link.opened = true;
      return {
        deposit: link.deposit,
        amount: deposit.amount,
        expiresAt: link.expiresAt,
      };
    },
    async status(key, ownerKey) {
      const link = owner(key, ownerKey);
      return {
        opened: link.opened,
        phase: link.phase,
        expiresAt: link.expiresAt,
        result: await result(link),
      };
    },
    progress(key, device, phase) {
      const link = get(key);
      if (link.device !== device)
        throw new DemoError(
          409,
          "link_in_use",
          "This deposit is open on another device.",
        );
      if (phase === "sending" || phase === "waiting") link.phase = phase;
      else if (phase === "release") {
        link.device = null;
        link.opened = false;
        link.phase = "waiting";
      } else
        throw new DemoError(
          400,
          "bad_phase",
          "This device state is not valid.",
        );
      return { ok: true };
    },
    cancel(key, ownerKey) {
      owner(key, ownerKey);
      links.delete(key);
      return { ok: true };
    },
  };
}
