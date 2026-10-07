/**
 * What the app's page and the Swish frame say to each other (postMessage).
 * The page never sees the passkey or the wallet; the frame never trusts a
 * page the app did not register (the API checks the page's origin).
 */
import type { DepositResult } from "./api.js";
import type { Cluster } from "./wallet.js";

export type Theme = "light" | "dark";

export type ToFrame =
  | {
      swish: "open";
      publishableKey: string;
      depositId: string;
      clientSecret: string;
      cluster: Cluster;
      apiUrl: string;
      theme: Theme;
    }
  /** Which wallet does this browser remember? */
  | { swish: "known" }
  | { swish: "unlink"; publishableKey: string; wallet: string; cluster: Cluster; apiUrl: string };

export type FromFrame =
  | { swish: "ready" }
  | { swish: "succeeded"; deposit: DepositResult }
  | { swish: "closed"; deposit: DepositResult | null }
  /** The answer to "known", and sent unasked once a passkey has shown whose browser this is. */
  | { swish: "known"; wallet: string | null }
  | { swish: "unlinked"; address: string }
  | { swish: "unlink_failed"; message: string };

export const isMessage = (data: unknown): data is { swish: string } =>
  typeof data === "object" && data !== null && typeof (data as { swish?: unknown }).swish === "string";
