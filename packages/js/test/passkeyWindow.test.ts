import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "../src/api.js";
import type { Passkeys } from "../src/passkey.js";
import { PasskeyWindowBlocked, windowPasskeys } from "../src/passkeyWindow.js";

afterEach(() => vi.unstubAllGlobals());

describe("passkey approval window", () => {
  it("opens the passkey site on the first approval tap", async () => {
    const approval: Approval = {
      credentialId: "credential",
      authenticatorData: "authenticator",
      clientDataJson: "client-data",
      signature: "signature",
    };
    const opened = { closed: false };
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const open = vi.fn((_url: string, _name: string, _features: string) => opened);
    vi.stubGlobal("window", {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 800,
      open,
      addEventListener: (name: string, listener: (event: MessageEvent) => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    vi.stubGlobal("location", { origin: "http://localhost:5174" });
    const inFrame: Passkeys = {
      approve: vi.fn(async () => { throw new Error("approval must open in the window"); }),
      create: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const passkeys = windowPasskeys(inFrame, "http://localhost:5174/passkey.html", "light");

    const next = passkeys.approve("fresh-challenge", "localhost");
    expect(open).toHaveBeenCalledOnce();
    expect(inFrame.approve).not.toHaveBeenCalled();
    const url = new URL(open.mock.calls[0]![0]);
    expect(url.searchParams.get("action")).toBe("approve");
    expect(url.searchParams.get("rp")).toBe("localhost");
    expect(url.searchParams.get("challenge")).toBe("fresh-challenge");
    const nonce = url.searchParams.get("nonce");

    listeners.get("message")?.({ origin: "http://other.test", source: opened, data: { swishPasskey: "approved", nonce, ...approval } } as never);
    listeners.get("message")?.({ origin: "http://localhost:5174", source: opened, data: { swishPasskey: "approved", nonce: "wrong", ...approval } } as never);
    expect(listeners.has("message")).toBe(true);
    listeners.get("message")?.({ origin: "http://localhost:5174", source: opened, data: { swishPasskey: "approved", nonce, ...approval } } as never);
    await expect(next).resolves.toEqual(approval);
    expect(listeners.has("message")).toBe(false);
  });

  it("reports a blocked window without asking inside the frame", async () => {
    vi.stubGlobal("window", { screenX: 0, screenY: 0, outerWidth: 1200, outerHeight: 800, open: () => null });
    const inFrame: Passkeys = { approve: vi.fn(), create: vi.fn() };
    const passkeys = windowPasskeys(inFrame, "http://localhost:5174/passkey.html", "light");

    await expect(passkeys.approve("challenge", "localhost")).rejects.toBeInstanceOf(PasskeyWindowBlocked);
    expect(inFrame.approve).not.toHaveBeenCalled();
  });
});
