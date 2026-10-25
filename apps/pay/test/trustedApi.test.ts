import { describe, expect, it, vi } from "vitest";

import { trustedApiUrl } from "../src/trustedApi";

const { createApi, flow } = vi.hoisted(() => ({
  createApi: vi.fn(() => ({ unlinkWallet: vi.fn(async () => ({ done: true })) })),
  flow: { onChange: vi.fn(), start: vi.fn(async () => {}), dispose: vi.fn() },
}));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: vi.fn() }) }));
vi.mock("core/api", () => ({ createApi }));
vi.mock("core/flow", () => ({ DepositFlow: class { constructor() { return flow; } } }));
vi.mock("core/memory", () => ({ browserMemory: () => ({ load: () => null, clear: vi.fn() }) }));
vi.mock("core/passkey", () => ({ browserPasskeys: vi.fn() }));
vi.mock("core/passkeyWindow", () => ({ windowPasskeys: vi.fn() }));
vi.mock("core/wallet", () => ({ browserWallets: () => ({ connect: async () => ({ address: "wallet" }) }) }));
vi.mock("../src/App", () => ({ App: () => null }));

describe("the hosted widget's trusted API", () => {
  it("uses a deployment origin and rejects insecure or ambiguous production URLs", () => {
    expect(trustedApiUrl(undefined, false)).toBe("https://api.swish.cash");
    expect(trustedApiUrl("https://staging-api.swish.cash", false)).toBe("https://staging-api.swish.cash");
    for (const url of ["http://attacker.example", "https://user:pass@api.swish.cash", "https://api.swish.cash/path", "https://api.swish.cash?redirect=x"]) {
      expect(() => trustedApiUrl(url, false)).toThrow();
    }
    expect(trustedApiUrl("http://localhost:3000", true)).toBe("http://localhost:3000");
  });

  it("ignores an embedding parent's attacker API for both payment and unlink", async () => {
    const parent = { postMessage: vi.fn() };
    let receive!: (event: { source: unknown; origin: string; data: unknown }) => void;
    vi.stubGlobal("window", { parent, addEventListener: (_name: string, handler: typeof receive) => { receive = handler; } });
    vi.stubGlobal("document", { getElementById: () => ({}) });
    vi.stubGlobal("location", { origin: "https://pay.swish.cash" });
    vi.stubEnv("VITE_SWISH_API_URL", "https://api.swish.cash");
    try {
      await import("../src/main");
      const fields = { publishableKey: "pk", cluster: "devnet", apiUrl: "https://attacker.example" };
      receive({ source: parent, origin: "https://merchant.example", data: { ...fields, swish: "open", depositId: "id", clientSecret: "secret", theme: "light" } });
      receive({ source: parent, origin: "https://merchant.example", data: { ...fields, swish: "unlink", wallet: "wallet" } });
      expect(createApi.mock.calls).toEqual([
        ["pk", "https://api.swish.cash", "https://merchant.example"],
        ["pk", "https://api.swish.cash", "https://merchant.example"],
      ]);
      await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith(
        { swish: "unlinked", address: "wallet" }, "https://merchant.example",
      ));
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
