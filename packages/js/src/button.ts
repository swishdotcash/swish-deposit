/**
 * The Swish button, drawn in the app's page: "Deposit with Swish" the first
 * time, and "Deposit" with the user's wallet once this browser knows it.
 * A tap asks the app's server for a deposit, then opens the widget.
 */
import type { DepositResult } from "./api.js";
import { shortAddress } from "./format.js";
import { DEFAULT_FRAME_URL, knownWallet, openDeposit, prepare, type DepositOutcome, type FrameOptions } from "./loader.js";
import type { Theme } from "./protocol.js";
import type { Cluster } from "./wallet.js";

/** What your server's `POST /v1/deposits` answered; either spelling works. */
export type CreatedDeposit = { depositId: string; clientSecret: string } | { id: string; client_secret: string };

export interface DepositButtonOptions extends FrameOptions {
  /** Your app's publishable key (`swishpub_…`). */
  publishableKey: string;
  /** Asks your server to create the deposit. Called on every tap. */
  createDeposit: () => Promise<CreatedDeposit>;
  /** Defaults to mainnet. Use "devnet" with test keys. */
  cluster?: Cluster;
  apiUrl?: string;
  /** Your page's theme: a dark button on a light page, a light one on a dark page. Defaults to light. */
  theme?: Theme;
  /** Called as soon as the deposit lands, before the user closes the widget. */
  onSuccess?: (deposit: DepositResult) => void;
  /** Called when the widget closes, with or without a deposit. */
  onClose?: (outcome: DepositOutcome) => void;
  /** Called when `createDeposit` fails. */
  onError?: (error: unknown) => void;
}

export interface DepositButton {
  /** Changes the theme. */
  setTheme(theme: Theme): void;
  /** Looks again for the wallet this browser knows (after an unlink, say). */
  refresh(): void;
  destroy(): void;
}

const FONT = "Swish Jost";
const WALLET_KEY = "swish-deposit-button";

/** Values from the "Entry buttons" artboard in Paper. */
const CSS = `
:host { display: block; }
button {
  --fg: #fafafa; --bg: #121212;
  all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 10px;
  width: 100%; height: 52px; border-radius: 9999px; background: var(--bg); color: var(--fg); cursor: pointer;
  font-family: "${FONT}", "Jost", system-ui, sans-serif; font-size: 16px; line-height: 24px; font-weight: 600;
  font-synthesis: none; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  -webkit-tap-highlight-color: transparent; user-select: none; transition: opacity 0.12s ease;
}
button[data-theme="dark"] { --fg: #121212; --bg: #fafafa; }
button[data-known] { justify-content: space-between; padding: 0 20px; }
button:hover { opacity: 0.92; }
button:active { opacity: 0.85; }
button:focus-visible { outline: 2px solid color-mix(in srgb, var(--bg) 60%, transparent); outline-offset: 2px; }
button[aria-busy="true"] { cursor: default; opacity: 0.7; }
.lead, .from { display: flex; align-items: center; }
.lead { gap: 10px; }
.from { gap: 8px; font-size: 14px; line-height: 20px; font-weight: 500; color: color-mix(in srgb, var(--fg) 70%, transparent); }
.from::before { content: ""; width: 1px; height: 20px; background: color-mix(in srgb, var(--fg) 20%, transparent); }
.logo { width: 28px; height: 14px; flex-shrink: 0; }
.wallet { width: 16px; height: 12px; flex-shrink: 0; }
`;

const LOGO = `<svg class="logo" viewBox="0 0 289 148" fill="none" aria-hidden="true"><path d="M24.0052 24.0052L60.2824 96.5595C62.1139 100.223 66.9958 101.015 69.8916 98.1189L98.6645 69.346C101.395 66.6152 105.957 67.138 107.999 70.4157L139.349 120.73C141.713 124.524 147.247 124.493 149.569 120.673L180.038 70.5344C182.057 67.2105 186.657 66.6574 189.408 69.4077L218.119 98.1189C221.015 101.015 225.897 100.223 227.728 96.5595L264.005 24.0052" stroke="currentColor" stroke-width="48" stroke-miterlimit="3.99393" stroke-linecap="round"/></svg>`;
const WALLET = `<svg class="wallet" viewBox="0 0 34 24" fill="none" aria-hidden="true"><rect x="2" y="2" width="28" height="20" rx="2" stroke="currentColor" stroke-width="4"/><path d="M27 12H32" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;

/** The font has to be declared by the page itself; a button's own styles cannot bring one. */
function loadFont(frameUrl: string): void {
  if (document.querySelector("style[data-swish-deposit-font]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-swish-deposit-font", "");
  style.textContent = `@font-face{font-family:"${FONT}";src:url("${new URL(frameUrl).origin}/fonts/jost.woff2") format("woff2");font-weight:100 900;font-display:swap}`;
  document.head.append(style);
}

/** The wallet shown last time, so the button does not change a moment after the page loads. */
const lastShown = {
  get(): string | null {
    try {
      return localStorage.getItem(WALLET_KEY);
    } catch {
      return null;
    }
  },
  set(wallet: string | null) {
    try {
      if (wallet) localStorage.setItem(WALLET_KEY, wallet);
      else localStorage.removeItem(WALLET_KEY);
    } catch {
      // Private windows may refuse storage; the button asks the frame each time.
    }
  },
};

/** Puts the Swish button inside `target` (an element, or a selector for one). */
export function mountDepositButton(target: string | HTMLElement, options: DepositButtonOptions): DepositButton {
  const host = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!host) throw new Error(`Swish Deposit: nothing matches ${String(target)}`);
  const frameUrl = options.frameUrl ?? DEFAULT_FRAME_URL;
  loadFont(frameUrl);
  prepare({ frameUrl });

  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style><button type="button"></button>`;
  const button = root.querySelector("button")!;
  let theme: Theme = options.theme ?? "light";
  let wallet = lastShown.get();
  let busy = false;
  let alive = true;

  const draw = () => {
    button.dataset.theme = theme;
    button.toggleAttribute("data-known", wallet !== null);
    button.setAttribute("aria-busy", String(busy));
    if (wallet) {
      button.setAttribute("aria-label", `Deposit with Swish from wallet ${shortAddress(wallet)}`);
      button.innerHTML = `<span class="lead">${LOGO}<span>Deposit</span></span><span class="from">${WALLET}<span></span></span>`;
      // The address is set as text, never as markup.
      button.querySelector(".from span")!.textContent = shortAddress(wallet);
    } else {
      button.removeAttribute("aria-label");
      button.innerHTML = `${LOGO}<span>Deposit with Swish</span>`;
    }
  };

  const refresh = () => {
    void knownWallet({ frameUrl }).then((known) => {
      if (!alive) return;
      lastShown.set(known);
      if (known === wallet) return;
      wallet = known;
      draw();
    });
  };

  const tap = async () => {
    if (busy) return;
    busy = true;
    draw();
    try {
      let created: CreatedDeposit;
      try {
        created = await options.createDeposit();
      } catch (e) {
        options.onError?.(e);
        return;
      }
      const outcome = await openDeposit({
        frameUrl,
        publishableKey: options.publishableKey,
        depositId: "id" in created ? created.id : created.depositId,
        clientSecret: "client_secret" in created ? created.client_secret : created.clientSecret,
        theme,
        ...(options.cluster ? { cluster: options.cluster } : {}),
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        ...(options.onSuccess ? { onSuccess: options.onSuccess } : {}),
      });
      options.onClose?.(outcome);
    } finally {
      busy = false;
      if (alive) {
        draw();
        // Setup or a first deposit here means the browser now knows a wallet.
        refresh();
      }
    }
  };

  button.addEventListener("click", () => void tap());
  draw();
  refresh();

  return {
    setTheme(next) {
      theme = next;
      draw();
    },
    refresh,
    destroy() {
      alive = false;
      root.innerHTML = "";
    },
  };
}
