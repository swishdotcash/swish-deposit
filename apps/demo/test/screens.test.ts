import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ScreenBody,
  waitText,
  type Actions,
  type View,
} from "../src/widget/screens";
import { deviceUrl, fundWallet } from "../src/demo-api";
const wallet = "CG1gKGxUuRHKAnYiTzVbf6aWkFJUyBtCqy5MSFLoHhFk";
const view: View = {
  details: {
    challenge: "x",
    rp_id: "localhost",
    expires_at: "2099-01-01",
    amount: "5",
    token: "USDC",
    app: { name: "Meridian", website: "https://demo.example" },
  },
  wallet,
  source: { wallet, balance: "10", left: "1000", limit: "1000" },
  sourcePending: false,
  cluster: "devnet",
  unlock: "Touch ID",
  walletName: "Demo Wallet",
  chosenLimit: "1000",
  busy: undefined,
};
const a = new Proxy({}, { get: () => () => {} }) as Actions;
describe("widget display states", () => {
  it("keeps setup choices and the allowance summary from the widget", () => {
    const html = renderToStaticMarkup(
      createElement(ScreenBody, {
        v: view,
        a,
        screen: {
          name: "limit",
          purpose: "setup",
          wallet,
          balance: "10",
          choices: ["100", "250", "500"],
          minimum: "5",
        },
      }),
    );
    for (const text of [
      "250",
      "1,000",
      "2,500",
      "995",
      "Covers 200 deposits like this one",
      "Other amount in USDC",
    ])
      expect(html).toContain(text);
  });
  it.each([
    "Creating your passkey",
    "Approve in Demo Wallet",
    "Confirming wallet link",
  ])("shows %s inside the existing button", (busy) => {
    const html = renderToStaticMarkup(
      createElement(ScreenBody, {
        v: { ...view, busy },
        a,
        screen: { name: "passkey" },
      }),
    );
    expect(html).toContain("Create your Swish ID");
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*disabled[^>]*>[\\s\\S]*?${busy}[\\s\\S]*?</button>`,
      ),
    );
  });
  it("shows the deposit loading state in the deposit button", () => {
    const busy = waitText({ name: "sending", purpose: "pay" }, "Touch ID");
    const html = renderToStaticMarkup(
      createElement(ScreenBody, {
        v: { ...view, busy },
        a,
        screen: { name: "ready", purpose: "setup" },
      }),
    );
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*>[\s\S]*?Sending your deposit[\s\S]*?<\/button>/,
    );
    expect(html).toContain("From now on, every deposit is only this step");
  });
  it("uses a URL fragment for the device link", () => {
    const url = new URL(
      deviceUrl("a".repeat(43), "https://demo.example/old?q=old"),
    );
    expect(url.origin).toBe("https://demo.example");
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#deposit=${"a".repeat(43)}`);
  });
  it("reuses the funding request ID after a lost reply", async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => saved.set(k, v),
      removeItem: (k: string) => saved.delete(k),
    });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(async (_url, init) => ({
        ok: true,
        json: async () => ({ ...JSON.parse(init.body), status: "confirmed" }),
      }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(fundWallet(wallet)).rejects.toThrow("offline");
      const before = JSON.parse(fetch.mock.calls[0][1].body).id;
      await fundWallet(wallet);
      expect(JSON.parse(fetch.mock.calls[1][1].body).id).toBe(before);
      expect(saved.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
