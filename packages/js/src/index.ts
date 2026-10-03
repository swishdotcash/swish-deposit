/**
 * Swish Deposit for the browser.
 *
 *   const outcome = await openDeposit({
 *     publishableKey: "swishpub_…",
 *     depositId,        // from your server: POST /v1/deposits with your secret key
 *     clientSecret,
 *   });
 *   if (outcome.status === "succeeded") …
 *
 * Your server learns the result from the `deposit.succeeded` webhook; treat
 * that, not the browser, as the source of truth.
 */
import { DEFAULT_API_URL, createApi, type DepositResult } from "./api.js";
import { openDrawer } from "./drawer.js";
import { DepositFlow, type Memory, type Remembered } from "./flow.js";
import { fromBase64, toBase64 } from "./encoding.js";
import { browserPasskeys } from "./passkey.js";
import { browserWallets, type Cluster } from "./wallet.js";

export interface OpenDepositOptions {
  /** Your app's publishable key (`swishpub_…`). Safe to ship in the page. */
  publishableKey: string;
  /** The deposit your server created, and its client secret. */
  depositId: string;
  clientSecret: string;
  /** Defaults to mainnet. Use "devnet" with test keys. */
  cluster?: Cluster;
  apiUrl?: string;
  /** Called as soon as the deposit lands, before the user closes the drawer. */
  onSuccess?: (deposit: DepositResult) => void;
}

export type DepositOutcome = { status: "succeeded"; deposit: DepositResult } | { status: "closed" };

const MEMORY_KEY = "swish-deposit";

/** Remembers the last wallet in this browser. Losing it costs nothing: the passkey is the identity. */
function browserMemory(): Memory {
  return {
    load() {
      try {
        const r = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null") as Partial<Remembered> | null;
        return r && typeof r.credentialId === "string" && typeof r.wallet === "string"
          ? { credentialId: r.credentialId, wallet: r.wallet }
          : null;
      } catch {
        return null;
      }
    },
    save(r) {
      try {
        localStorage.setItem(MEMORY_KEY, JSON.stringify(r));
      } catch {
        // Private windows may refuse storage; the widget works without it.
      }
    },
    clear() {
      try {
        localStorage.removeItem(MEMORY_KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

export interface UnlinkWalletOptions {
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
export async function unlinkWallet(options: UnlinkWalletOptions): Promise<string> {
  const api = createApi(options.publishableKey, options.apiUrl ?? DEFAULT_API_URL);
  const wallet = await browserWallets(options.cluster ?? "mainnet").connect(options.wallet);
  const step = await api.unlinkWallet(wallet.address);
  if (!step.done) {
    const signed = await wallet.sign(fromBase64(step.transaction));
    await api.submitWalletTransaction(toBase64(signed), step.token);
  }
  const memory = browserMemory();
  if (memory.load()?.wallet === wallet.address) memory.clear();
  return wallet.address;
}

let open = false;

/** Opens the deposit drawer. Resolves when the user closes it. */
export function openDeposit(options: OpenDepositOptions): Promise<DepositOutcome> {
  if (open) return Promise.reject(new Error("A Swish deposit is already open."));
  open = true;
  const cluster = options.cluster ?? "mainnet";
  const flow = new DepositFlow(
    { id: options.depositId, clientSecret: options.clientSecret },
    {
      api: createApi(options.publishableKey, options.apiUrl ?? DEFAULT_API_URL),
      passkeys: browserPasskeys(),
      wallets: browserWallets(cluster),
      memory: browserMemory(),
    },
  );
  return new Promise((resolve) => {
    flow.onChange((screen) => {
      if (screen.name === "succeeded") options.onSuccess?.(screen.result);
    });
    openDrawer(flow, cluster, () => {
      const last = flow.screen;
      flow.dispose();
      open = false;
      resolve(last.name === "succeeded" ? { status: "succeeded", deposit: last.result } : { status: "closed" });
    });
    void flow.start();
  });
}

export { ApiError, createApi, type Challenge, type DepositApi, type DepositRef, type DepositResult } from "./api.js";
export { DepositFlow, type FlowDeps, type Memory, type Purpose, type Remembered, type Screen, type Source } from "./flow.js";
export { PasskeyDismissed, PasskeyUnsupported, browserPasskeys, type Passkeys } from "./passkey.js";
export { WalletRejected, browserWallets, type Cluster, type ConnectedWallet, type WalletOption, type Wallets } from "./wallet.js";
