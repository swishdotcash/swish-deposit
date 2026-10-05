/**
 * Swish Deposit for the browser: the button and the widget it opens.
 *
 *   mountDepositButton("#deposit", {
 *     publishableKey: "swishpub_…",
 *     // your server: POST /v1/deposits with your secret key
 *     createDeposit: () => fetch("/deposits", { method: "POST" }).then((r) => r.json()),
 *     onSuccess: (deposit) => …,
 *   });
 *
 * With your own button, call `openDeposit({ publishableKey, depositId,
 * clientSecret })` instead. Either way the widget opens over your page in a
 * frame served by Swish: the user's passkey and wallet never touch your page. Your server learns the result
 * from the `deposit.succeeded` webhook; treat that, not the browser, as the
 * source of truth.
 */
export {
  mountDepositButton,
  type CreatedDeposit,
  type DepositButton,
  type DepositButtonOptions,
} from "./button.js";
export {
  DEFAULT_FRAME_URL,
  knownWallet,
  openDeposit,
  prepare,
  unlinkWallet,
  type DepositOutcome,
  type FrameOptions,
  type OpenDepositOptions,
  type UnlinkWalletOptions,
} from "./loader.js";
export type { DepositResult } from "./api.js";
export type { Theme } from "./protocol.js";
export type { Cluster } from "./wallet.js";
