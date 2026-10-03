/**
 * The drawer: draws the flow's current screen in the app's page, inside a
 * shadow root so neither side's styles leak into the other.
 */
import type { Challenge } from "./api.js";
import type { DepositFlow, Screen, Source } from "./flow.js";
import type { Cluster } from "./wallet.js";

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(18, 18, 18, 0.45);
  font-family: Jost, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #121212;
  animation: fade 0.15s ease-out;
}
.card {
  width: 100%; max-width: 380px; margin: 16px;
  background: #fafafa; border-radius: 20px; padding: 20px;
  box-shadow: 0 16px 48px rgba(18, 18, 18, 0.25);
  animation: rise 0.2s ease-out;
}
@media (max-width: 480px) {
  .backdrop { align-items: flex-end; }
  .card {
    max-width: none; margin: 0; border-radius: 20px 20px 0 0;
    padding-bottom: calc(20px + env(safe-area-inset-bottom));
  }
}
@keyframes fade { from { opacity: 0; } }
@keyframes rise { from { transform: translateY(12px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .backdrop, .card, .spinner { animation: none; } }
.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.brand { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; }
.close {
  border: 0; background: transparent; color: #121212; cursor: pointer;
  width: 32px; height: 32px; border-radius: 16px; font-size: 20px; line-height: 1;
}
.close:hover { background: rgba(18, 18, 18, 0.06); }
.amount { font-size: 36px; font-weight: 600; line-height: 1.1; margin: 4px 0; }
.amount small { font-size: 16px; font-weight: 500; opacity: 0.6; }
.to { font-size: 15px; opacity: 0.7; margin: 0 0 20px; }
h2 { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
p { font-size: 14px; line-height: 1.45; margin: 0 0 16px; opacity: 0.75; }
.note {
  font-size: 13px; line-height: 1.4; margin: 0 0 14px; padding: 10px 12px;
  border-radius: 12px; background: rgba(18, 18, 18, 0.06); opacity: 1;
}
button.main, button.second, button.option {
  width: 100%; border-radius: 14px; font: inherit; font-size: 15px; font-weight: 600;
  padding: 14px 16px; cursor: pointer; margin-top: 8px;
}
button.main { border: 0; background: #121212; color: #fafafa; }
button.main:hover { background: #2a2a2a; }
button.main:disabled { opacity: 0.45; cursor: default; }
button.second { border: 1px solid rgba(18, 18, 18, 0.15); background: transparent; color: #121212; }
button.second:hover, button.option:hover { background: rgba(18, 18, 18, 0.05); }
button.option {
  display: flex; align-items: center; gap: 12px; text-align: left; font-weight: 500;
  border: 1px solid rgba(18, 18, 18, 0.15); background: transparent; color: #121212;
}
button.option img { width: 28px; height: 28px; border-radius: 8px; }
button:focus-visible, input:focus-visible { outline: 2px solid #121212; outline-offset: 2px; }
.choices { display: flex; gap: 8px; }
.choices button { margin-top: 0; }
.custom { display: flex; gap: 8px; margin-top: 8px; }
.custom input {
  flex: 1; min-width: 0; border-radius: 14px; border: 1px solid rgba(18, 18, 18, 0.15);
  background: #fff; color: #121212; font: inherit; font-size: 15px; padding: 14px 16px;
}
.custom button { width: auto; margin-top: 0; }
.wait { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 20px 0 8px; }
.spinner {
  width: 28px; height: 28px; border-radius: 50%; margin-bottom: 16px;
  border: 3px solid rgba(18, 18, 18, 0.12); border-top-color: #121212;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.tick {
  width: 44px; height: 44px; border-radius: 22px; background: #121212; color: #fafafa;
  display: flex; align-items: center; justify-content: center; font-size: 22px; margin-bottom: 14px;
}
a { color: inherit; }
.small { font-size: 12px; opacity: 0.55; margin: 14px 0 0; text-align: center; }
.from { margin: 0 0 16px; padding: 12px 14px; border-radius: 14px; background: rgba(18, 18, 18, 0.05); }
.from div { display: flex; justify-content: space-between; font-size: 14px; line-height: 1.7; }
.from span:first-child { opacity: 0.6; }
.from .low { font-weight: 600; }
.from .pending { opacity: 0.4; }
button.pick { margin-top: 0; margin-bottom: 8px; }
button.pick:disabled { opacity: 0.5; cursor: default; }
button.pick .dot { width: 16px; height: 16px; border-radius: 8px; border: 2px solid rgba(18, 18, 18, 0.35); flex: none; }
button.pick.on { border-color: #121212; }
button.pick.on .dot { border: 5px solid #121212; }
button.pick .who { display: flex; flex-direction: column; font-weight: 600; }
button.pick small { font-weight: 400; font-size: 12px; opacity: 0.65; margin-top: 2px; }
`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** "12.5" → "12.50"; more decimals are kept as they are. */
export function money(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  return `${Number(whole).toLocaleString("en-US")}.${fraction.padEnd(2, "0")}`;
}

/** What this device calls its unlock: the words the system prompt will use. */
export function unlockName(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/iPhone|iPad/.test(userAgent)) return "Face ID";
  if (/Macintosh/.test(userAgent)) return "Touch ID";
  return "your fingerprint or screen lock";
}

const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const header = (d: Challenge | null) =>
  d
    ? `<div class="amount">${escapeHtml(money(d.amount))} <small>${escapeHtml(d.token)}</small></div>
       <p class="to">Deposit to ${escapeHtml(d.app.name)}</p>`
    : "";

/** The remembered wallet, what it holds, and what Swish may still move from it ("…" until read). */
function sourceRows(wallet: string | null, source: Source | null, amount: number, pending: boolean): string {
  if (!wallet) return "";
  const cell = (value: string | undefined) =>
    value === undefined
      ? `<span class="pending">${pending ? "…" : "not available"}</span>`
      : `<span${Number(value) < amount ? ' class="low"' : ""}>${escapeHtml(money(value))} USDC</span>`;
  const known = source?.wallet === wallet ? source : null;
  return `<div class="from">
    <div><span>From</span><span>${escapeHtml(shortAddress(wallet))}</span></div>
    <div><span>Balance</span>${cell(known?.balance)}</div>
    <div><span>Limit left</span>${cell(known?.left)}</div>
  </div>`;
}

const note = (text?: string) => (text ? `<div class="note">${escapeHtml(text)}</div>` : "");

const wait = (title: string, text = "") =>
  `<div class="wait" role="status"><div class="spinner"></div><h2>${escapeHtml(title)}</h2>${
    text ? `<p>${escapeHtml(text)}</p>` : ""
  }</div>`;

export function explorerUrl(signature: string, cluster: Cluster): string {
  return `https://explorer.solana.com/tx/${signature}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function body(
  screen: Screen,
  details: Challenge | null,
  wallet: string | null,
  source: Source | null,
  pending: boolean,
  cluster: Cluster,
): string {
  const unlock = unlockName();
  const amount = Number(details?.amount ?? 0);
  const depositWith = `Deposit with ${escapeHtml(unlock)}`;
  // While the wallet's numbers are still being read, the button waits: it may turn out the limit is too low.
  const depositButton = `<button class="main" data-do="approve"${pending ? " disabled" : ""}>${depositWith}</button>`;
  const cancelled = `${capital(unlock)} was cancelled. Nothing was taken.`;
  switch (screen.name) {
    case "loading":
      return wait("Loading");
    case "confirm": {
      const said = screen.note ?? (screen.cancelled ? cancelled : undefined);
      if (!wallet) {
        return `${header(details)}${note(said)}
          <button class="main" data-do="approve">Continue with Swish</button>
          <p class="small">${
            screen.cancelled
              ? `No Swish passkey on this device? <a href="#" data-do="setup">Set up once</a>`
              : `First, ${escapeHtml(unlock)} verifies it is you. Nothing is paid at that step.`
          }</p>`;
      }
      // Until the balance and limit are read, nothing is called low.
      const read = source?.wallet === wallet ? source : null;
      const limitLow = read !== null && Number(read.left) < amount;
      const balanceLow = read !== null && Number(read.balance) < amount;
      const short = limitLow
        ? "Your limit is lower than this deposit. Add to it first."
        : balanceLow
          ? "This wallet holds less than this deposit. Add USDC to it, or use another wallet."
          : undefined;
      return `${header(details)}${sourceRows(wallet, source, amount, pending)}${note(said ?? short)}
        ${limitLow ? `<button class="main" data-do="raise">Add to limit</button>` : depositButton}
        ${
          screen.cancelled
            ? `<p class="small">No Swish passkey on this device? <a href="#" data-do="setup">Set up once</a></p>`
            : ""
        }`;
    }
    // The system's Face ID sheet closes a moment before the browser hands us
    // the result, so these two screens share a title: only the line under it changes.
    case "approving":
      return screen.purpose === "verify"
        ? `${header(details)}${wait("Verifying it is you", `Waiting for ${unlock}. Nothing is paid at this step.`)}`
        : `${header(details)}${wait("Making your deposit", `Waiting for ${unlock}.`)}`;
    case "sending":
      return screen.purpose === "verify"
        ? `${header(details)}${wait("Verifying it is you", "Finding your wallets.")}`
        : `${header(details)}${wait("Making your deposit", "Sending it now.")}`;
    case "source": {
      const none = screen.selected === null;
      return `${header(details)}
        <h2>Pay from</h2>
        ${screen.wallets
          .map(
            (w) => `<button class="option pick${w.wallet === screen.selected ? " on" : ""}" data-pick="${escapeHtml(w.wallet)}"${
              w.enough ? "" : " disabled"
            } aria-pressed="${w.wallet === screen.selected}">
              <span class="dot"></span>
              <span class="who">${escapeHtml(shortAddress(w.wallet))}
                <small>Balance ${escapeHtml(money(w.balance))} · limit left ${escapeHtml(money(w.left))} USDC${
                  w.enough ? "" : " · not enough"
                }</small></span>
            </button>`,
          )
          .join("")}
        ${none ? note("None of your wallets can cover this deposit. Add to a limit, or add USDC to a wallet.") : ""}
        ${screen.cancelled ? note(cancelled) : ""}
        ${
          none
            ? `<button class="main" data-do="raise">Add to limit</button>`
            : `<button class="main" data-do="pay">${depositWith}</button>`
        }
        <p class="small">Nothing has moved yet.</p>`;
    }
    case "not_found":
      return `${header(details)}${note(screen.note)}
        <h2>New to Swish on this device?</h2>
        <p>${escapeHtml(capital(unlock))} was cancelled, or there is no Swish passkey here yet. Set up once with your wallet; after that every deposit is one approval, in any app with Swish.</p>
        <button class="main" data-do="setup">Set up once</button>
        <button class="second" data-do="approve">I have a passkey, try again</button>`;
    case "wallets": {
      const title = screen.purpose === "setup" ? "Choose your wallet" : "Connect your wallet";
      if (!screen.wallets.length) {
        return `<h2>No Solana wallet found</h2>
          <p>Install a wallet such as Phantom in this browser, add USDC to it, then come back.</p>
          <button class="second" data-do="wallets">Look again</button>`;
      }
      return `<h2>${title}</h2>${note(screen.note)}
        <p>The wallet your deposits will come from. It signs once now, not on every deposit.</p>
        ${screen.wallets
          .map(
            (w) =>
              `<button class="option" data-wallet="${escapeHtml(w.name)}"><img alt="" src="${escapeHtml(w.icon)}">${escapeHtml(w.name)}</button>`,
          )
          .join("")}`;
    }
    case "connecting":
      return wait(`Connecting ${screen.wallet}`, "Approve the connection in your wallet.");
    case "limit": {
      const raise = screen.purpose === "raise";
      const row = (label: string, value: string) => `<div><span>${label}</span><span>${value}</span></div>`;
      return `<h2>${raise ? "Add to your limit" : "Set a spending limit"}</h2>
        <p>${
          raise
            ? "This deposit needs more than your limit has left. How much do you want to add?"
            : "The most Swish can ever move from this wallet, across all deposits. Only you can approve a deposit, and you can change this any time."
        }</p>
        <div class="from">
          ${row("Wallet", escapeHtml(shortAddress(screen.wallet)))}
          ${screen.balance === undefined ? "" : row("Balance", `${escapeHtml(money(screen.balance))} USDC`)}
          ${raise ? row("Limit left", `${escapeHtml(money(screen.left ?? "0"))} USDC`) : ""}
        </div>
        <div class="choices">${screen.choices
          .map((c) => `<button class="second" data-limit="${escapeHtml(c)}">${raise ? "+" : ""}${escapeHtml(money(c))}</button>`)
          .join("")}</div>
        <form class="custom" data-form="limit">
          <input name="amount" inputmode="decimal" autocomplete="off" placeholder="Other amount (USDC)" aria-label="Other amount in USDC">
          <button class="second" type="submit">Set</button>
        </form>
        <div data-error></div>
        <p class="small">Not the wallet you want? Switch account in your wallet, then <a href="#" data-do="wallets">choose again</a>.</p>`;
    }
    case "passkey":
      return `<h2>Create your Swish passkey</h2>${note(screen.note)}
        <p>Your passkey is your Swish ID. It stays on your devices, and it is what approves each deposit.</p>
        <button class="main" data-do="passkey">Create passkey</button>`;
    case "creating":
      return wait("Creating your passkey", "Follow the prompt from your device.");
    case "signing":
      return wait(
        `Approve in ${screen.wallet}`,
        screen.total > 1
          ? `Signature ${screen.done + 1} of ${screen.total}. Swish pays the network fees.`
          : "One signature. Swish pays the network fees.",
      );
    case "ready":
      return `${header(details)}
        <h2>${screen.added ? "Wallet added" : screen.purpose === "setup" ? "You are set up" : "Limit updated"}</h2>
        ${sourceRows(wallet, source, amount, pending)}
        ${depositButton}`;
    case "succeeded": {
      const { result } = screen;
      return `<div class="wait"><div class="tick">✓</div>
        <h2>${escapeHtml(money(result.amount))} ${escapeHtml(result.token)} deposited</h2>
        <p>${details ? `It is in your ${escapeHtml(details.app.name)} account.` : ""}${
          source
            ? `<br>From ${escapeHtml(shortAddress(source.wallet))} · limit left ${escapeHtml(money(source.left))} USDC`
            : ""
        }</p></div>
        <button class="main" data-do="close">Done</button>
        ${
          result.signature
            ? `<p class="small"><a href="${escapeHtml(explorerUrl(result.signature, cluster))}" target="_blank" rel="noopener noreferrer">View transaction</a></p>`
            : ""
        }`;
    }
    case "failed":
      return `<h2>Something went wrong</h2><p>${escapeHtml(screen.message)}</p>
        ${screen.retry ? `<button class="main" data-do="retry">Try again</button>` : ""}
        <button class="second" data-do="close">Close</button>`;
  }
}

/** Screens where closing would abandon something the wallet or chain is doing. */
const BUSY = new Set<Screen["name"]>(["sending", "signing"]);

export interface Drawer {
  close(): void;
}

export function openDrawer(flow: DepositFlow, cluster: Cluster, onClose: () => void): Drawer {
  const host = document.createElement("div");
  host.setAttribute("data-swish-deposit", "");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  root.append(style, backdrop);
  document.body.append(host);

  // The card is made once, so its entrance animation plays once: only what
  // is inside it changes from screen to screen.
  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Deposit with Swish");
  backdrop.append(card);

  const render = (screen: Screen) => {
    card.innerHTML = `<div class="top"><span class="brand">Swish</span>${
      BUSY.has(screen.name) ? "" : `<button class="close" data-do="close" aria-label="Close">×</button>`
    }</div>
      ${body(screen, flow.details, flow.knownWallet, flow.source, flow.sourcePending, cluster)}`;
    card.querySelector<HTMLElement>("button.main:not(:disabled), button.option:not(:disabled), button.second")?.focus();
  };

  const close = () => {
    stop();
    document.removeEventListener("keydown", onKey);
    host.remove();
    onClose();
  };

  const limitError = (text: string) => {
    const slot = backdrop.querySelector("[data-error]");
    if (slot) slot.innerHTML = note(text);
  };

  const chooseLimit = (amount: string) => {
    const screen = flow.screen;
    if (screen.name !== "limit") return;
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) return limitError("Enter an amount in USDC, for example 250.");
    if (Number(amount) < Number(screen.minimum)) {
      return limitError(`This deposit needs at least ${money(screen.minimum)} USDC.`);
    }
    void flow.chooseLimit(amount);
  };

  backdrop.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target === backdrop && !BUSY.has(flow.screen.name)) return close();
    const button = target.closest<HTMLElement>("button, a[data-do]");
    if (!button) return;
    if (button.tagName === "A") e.preventDefault();
    const wallet = button.dataset.wallet;
    if (wallet) return void flow.pickWallet(wallet);
    const limit = button.dataset.limit;
    if (limit) return chooseLimit(limit);
    const pick = button.dataset.pick;
    if (pick) return flow.selectWallet(pick);
    switch (button.dataset.do) {
      case "approve":
        return void flow.approve();
      case "raise":
        return flow.addToLimit();
      case "pay":
        return void flow.payFrom();
      case "change":
        return void flow.verify();
      case "add":
        return flow.addWallet();
      case "setup":
        return flow.setUp();
      case "wallets":
        return flow.listWallets();
      case "passkey":
        return void flow.createPasskey();
      case "retry":
        return flow.retry();
      case "close":
        return close();
    }
  });

  backdrop.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    if (form.dataset.form === "limit") chooseLimit(new FormData(form).get("amount")?.toString().trim() ?? "");
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !BUSY.has(flow.screen.name)) close();
  };
  document.addEventListener("keydown", onKey);

  const stop = flow.onChange(render);
  render(flow.screen);
  return { close };
}
