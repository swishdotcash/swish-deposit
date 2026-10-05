/**
 * The part of Swish Deposit that runs in the app's page: it puts the Swish
 * frame over the page and talks to it. Passkeys, wallets and what this
 * browser remembers all live inside the frame.
 */
import { DEFAULT_API_URL, type DepositResult } from "./api.js";
import { isMessage, type FromFrame, type Theme, type ToFrame } from "./protocol.js";
import type { Cluster } from "./wallet.js";

export const DEFAULT_FRAME_URL = "https://pay.swish.cash";

export interface FrameOptions {
  /** Where the Swish frame is served. Only change it for local development. */
  frameUrl?: string;
}

interface Frame {
  origin: string;
  element: HTMLIFrameElement;
  ready: Promise<void>;
  listeners: Set<(m: FromFrame) => void>;
}

const frames = new Map<string, Frame>();

function frameFor(frameUrl: string = DEFAULT_FRAME_URL): Frame {
  const origin = new URL(frameUrl).origin;
  const existing = frames.get(origin);
  if (existing) return existing;

  const element = document.createElement("iframe");
  element.src = `${origin}/`;
  element.title = "Swish Deposit";
  element.allow = "publickey-credentials-get; publickey-credentials-create";
  element.setAttribute("data-swish-deposit", "");
  element.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;display:none;" +
    "background:transparent;color-scheme:normal;z-index:2147483000";

  const listeners = new Set<(m: FromFrame) => void>();
  let isReady!: () => void;
  const ready = new Promise<void>((resolve) => (isReady = resolve));
  window.addEventListener("message", (e) => {
    if (e.origin !== origin || e.source !== element.contentWindow || !isMessage(e.data)) return;
    const message = e.data as FromFrame;
    if (message.swish === "ready") isReady();
    for (const l of [...listeners]) l(message);
  });
  document.body.append(element);

  const frame = { origin, element, ready, listeners };
  frames.set(origin, frame);
  return frame;
}

async function send(frame: Frame, message: ToFrame): Promise<void> {
  await frame.ready;
  frame.element.contentWindow?.postMessage(message, frame.origin);
}

/** Loads the frame ahead of the first tap, so the widget opens at once. */
export function prepare(options: FrameOptions = {}): void {
  frameFor(options.frameUrl);
}

/** The wallet this browser's last deposit came from, for a button that shows it. Null when there is none. */
export function knownWallet(options: FrameOptions = {}): Promise<string | null> {
  const frame = frameFor(options.frameUrl);
  return new Promise((resolve) => {
    const listen = (m: FromFrame) => {
      if (m.swish !== "known") return;
      frame.listeners.delete(listen);
      resolve(m.wallet);
    };
    frame.listeners.add(listen);
    void send(frame, { swish: "known" });
  });
}

export interface OpenDepositOptions extends FrameOptions {
  /** Your app's publishable key (`swishpub_…`). Safe to ship in the page. */
  publishableKey: string;
  /** The deposit your server created, and its client secret. */
  depositId: string;
  clientSecret: string;
  /** Defaults to mainnet. Use "devnet" with test keys. */
  cluster?: Cluster;
  apiUrl?: string;
  /** Defaults to light. */
  theme?: Theme;
  /** Called as soon as the deposit lands, before the user closes the widget. */
  onSuccess?: (deposit: DepositResult) => void;
}

export type DepositOutcome = { status: "succeeded"; deposit: DepositResult } | { status: "closed" };

let open = false;

/** Opens the deposit widget over the page. Resolves when the user closes it. */
export function openDeposit(options: OpenDepositOptions): Promise<DepositOutcome> {
  if (open) return Promise.reject(new Error("A Swish deposit is already open."));
  open = true;
  const frame = frameFor(options.frameUrl);
  const focused = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    const listen = (m: FromFrame) => {
      if (m.swish === "succeeded") options.onSuccess?.(m.deposit);
      if (m.swish !== "closed") return;
      frame.listeners.delete(listen);
      frame.element.style.display = "none";
      focused?.focus?.();
      open = false;
      resolve(m.deposit ? { status: "succeeded", deposit: m.deposit } : { status: "closed" });
    };
    frame.listeners.add(listen);
    frame.element.style.display = "block";
    void send(frame, {
      swish: "open",
      publishableKey: options.publishableKey,
      depositId: options.depositId,
      clientSecret: options.clientSecret,
      cluster: options.cluster ?? "mainnet",
      apiUrl: options.apiUrl ?? DEFAULT_API_URL,
      theme: options.theme ?? "light",
    }).then(() => frame.element.focus());
  });
}

export interface UnlinkWalletOptions extends FrameOptions {
  publishableKey: string;
  /** The wallet's name as the browser lists it, e.g. "Phantom". */
  wallet: string;
  cluster?: Cluster;
  apiUrl?: string;
}

/**
 * Unlinks a wallet from its Swish ID and cancels its limit: the wallet
 * connects and signs once. Returns the address that was unlinked.
 */
export function unlinkWallet(options: UnlinkWalletOptions): Promise<string> {
  const frame = frameFor(options.frameUrl);
  return new Promise((resolve, reject) => {
    const listen = (m: FromFrame) => {
      if (m.swish !== "unlinked" && m.swish !== "unlink_failed") return;
      frame.listeners.delete(listen);
      if (m.swish === "unlinked") resolve(m.address);
      else reject(new Error(m.message));
    };
    frame.listeners.add(listen);
    void send(frame, {
      swish: "unlink",
      publishableKey: options.publishableKey,
      wallet: options.wallet,
      cluster: options.cluster ?? "mainnet",
      apiUrl: options.apiUrl ?? DEFAULT_API_URL,
    });
  });
}
