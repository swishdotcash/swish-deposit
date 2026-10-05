/** How the widget writes amounts, addresses and the device's unlock. */
import type { Cluster } from "./wallet.js";

/** "12.5" → "12.50"; more decimals are kept as they are. */
export function money(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  return `${Number(whole).toLocaleString("en-US")}.${fraction.padEnd(2, "0")}`;
}

/** Like `money`, without the cents when there are none: "250", "1,000", "12.50". */
export function round(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  return /^0*$/.test(fraction) ? Number(whole).toLocaleString("en-US") : money(amount);
}

/** What this device calls its unlock: the words the system prompt will use. */
export function unlockName(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/iPhone|iPad/.test(userAgent)) return "Face ID";
  if (/Macintosh/.test(userAgent)) return "Touch ID";
  return "your fingerprint or screen lock";
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function explorerUrl(signature: string, cluster: Cluster): string {
  return `https://explorer.solana.com/tx/${signature}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}
