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
 * The widget opens over your page in a frame served by Swish: the user's
 * passkey and wallet never touch your page. Your server learns the result
 * from the `deposit.succeeded` webhook; treat that, not the browser, as the
 * source of truth.
 */
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
