/**
 * Development only: every screen side by side with made-up numbers, for
 * checking against the design. Open the frame's address directly;
 * `?theme=dark` for dark, `?only=confirm` for one screen.
 */
import type { Root } from "react-dom/client";

import type { Challenge } from "core/api";
import type { Screen } from "core/flow";

import { ScreenBody, type Actions, type View } from "./screens";
import { TopBar } from "./ui";

const WALLET = "7xKXq2mVn8sPz4LdR9wYtHc3JfUa6BeGoN5iTkZ1Bkhe";
const OTHER = "Dq4mT7pLs2XcVb9NwRyK3hJfUa6GeZoH5iAkM1u89vTz";
const SHORT = "3hPaR7pLs2XcVb9NwRyK3hJfUa6GeZoH5iAkM1ukW2e";

const details: Challenge = {
  challenge: "",
  rp_id: "localhost",
  expires_at: new Date(Date.now() + 90_000).toISOString(),
  amount: "250",
  token: "USDC",
  app: { name: "Meridian", website: "https://meridian.example" },
};

const noop = () => {};
const actions: Actions = {
  approve: noop,
  verify: noop,
  setUp: noop,
  addToLimit: noop,
  addWallet: noop,
  listWallets: noop,
  pickWallet: noop,
  chooseLimit: noop,
  createPasskey: noop,
  selectWallet: noop,
  payFrom: noop,
  retry: noop,
  close: noop,
};

const base: View = {
  details,
  wallet: null,
  source: null,
  sourcePending: false,
  cluster: "devnet",
  unlock: "Face ID",
  walletName: "Phantom",
  chosenLimit: "1000",
};
const known: View = { ...base, wallet: WALLET, source: { wallet: WALLET, balance: "1284.4", left: "750" } };
const icon =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="10" fill="#ab9ff2"/></svg>');

const cases: { name: string; screen: Screen; v: View }[] = [
  { name: "welcome", screen: { name: "confirm" }, v: base },
  { name: "welcome-verifying", screen: { name: "confirm" }, v: { ...base, busy: "Waiting for Face ID" } },
  { name: "welcome-not-found", screen: { name: "not_found" }, v: base },
  {
    name: "wallets",
    screen: { name: "wallets", purpose: "setup", wallets: [{ name: "Phantom", icon }, { name: "Solflare", icon }] },
    v: base,
  },
  { name: "wallets-none", screen: { name: "wallets", purpose: "setup", wallets: [] }, v: base },
  {
    name: "limit",
    screen: { name: "limit", purpose: "setup", wallet: WALLET, balance: "1284.4", choices: ["250", "500", "1000"], minimum: "250" },
    v: base,
  },
  {
    name: "limit-over-balance",
    screen: { name: "limit", purpose: "setup", wallet: WALLET, balance: "20", choices: ["250", "500", "1000"], minimum: "2" },
    v: { ...base, details: { ...details, amount: "2" } },
  },
  {
    name: "limit-raise",
    screen: { name: "limit", purpose: "raise", wallet: WALLET, balance: "1284.4", left: "100", choices: ["250", "500", "1000"], minimum: "150" },
    v: known,
  },
  { name: "passkey", screen: { name: "passkey" }, v: base },
  { name: "passkey-signing", screen: { name: "passkey" }, v: { ...base, busy: "Approve in Phantom (1 of 2)" } },
  { name: "ready", screen: { name: "ready", purpose: "setup" }, v: { ...known, source: { wallet: WALLET, balance: "1284.4", left: "1000" } } },
  { name: "confirm", screen: { name: "confirm" }, v: known },
  { name: "confirm-waiting", screen: { name: "confirm" }, v: { ...known, busy: "Waiting for Face ID" } },
  { name: "confirm-cancelled", screen: { name: "confirm", cancelled: true }, v: known },
  { name: "confirm-limit-low", screen: { name: "confirm" }, v: { ...known, source: { wallet: WALLET, balance: "1284.4", left: "100" } } },
  { name: "confirm-reading", screen: { name: "confirm" }, v: { ...known, source: null, sourcePending: true } },
  {
    name: "pay-from",
    screen: {
      name: "source",
      selected: WALLET,
      wallets: [
        { wallet: WALLET, balance: "1284.4", left: "750", enough: true },
        { wallet: OTHER, balance: "612", left: "2500", enough: true },
        { wallet: SHORT, balance: "88.1", left: "40", enough: false },
      ],
    },
    v: known,
  },
  {
    name: "landed",
    screen: {
      name: "succeeded",
      result: { id: "d", status: "succeeded", amount: "250", token: "USDC", destination: OTHER, reference: null, signature: "5sig", error: null, wallet: WALLET },
    },
    v: { ...known, source: { wallet: WALLET, balance: "1034.4", left: "500" } },
  },
  { name: "failed", screen: { name: "failed", message: "The deposit did not go through. Nothing was taken.", retry: true }, v: known },
  { name: "loading", screen: { name: "loading" }, v: { ...base, details: null } },
];

export function preview(root: Root) {
  const query = new URLSearchParams(location.search);
  const theme = query.get("theme") === "dark" ? "dark" : "light";
  const only = query.get("only");
  document.body.style.background = theme === "dark" ? "#0b0b0b" : "#e9e9e9";
  root.render(
    <div style={{ display: "flex", flexWrap: "wrap", gap: 32, padding: 32, alignItems: "flex-start" }}>
      {cases
        .filter((c) => !only || c.name === only)
        .map((c) => (
          <div key={c.name} data-case={c.name}>
            <div style={{ font: "12px system-ui", color: "#888", paddingBottom: 8 }}>{c.name}</div>
            <div className="swish" data-theme={theme} style={{ position: "static", background: "none", display: "block", animation: "none" }}>
              <div className="card" style={{ animation: "none", boxShadow: "none", maxWidth: "none", margin: 0 }}>
                <TopBar onClose={noop} locked={false} />
                <ScreenBody screen={c.screen} v={c.v} a={actions} />
              </div>
            </div>
          </div>
        ))}
    </div>,
  );
}
