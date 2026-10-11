import type { DepositRef, DepositResult } from "core/api";
import type { Cluster } from "core/wallet";

export interface Config {
  publishableKey: string;
  apiUrl: string;
  cluster: Cluster;
  publicOrigin?: string | null;
}
export class DemoApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: data === undefined ? "GET" : "POST",
    signal,
    headers:
      data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok)
    throw new DemoApiError(
      json?.error?.code ?? "unavailable",
      json?.error?.message ??
        "The demo could not finish this request. Try again.",
    );
  return json as T;
}
export interface WalletBalance {
  wallet: string;
  usdc: string;
  sol: string;
}
export interface FundingClaim {
  id: string;
  wallet: string;
  status: "pending" | "confirmed" | "failed";
  signature: string;
  usdc: string;
  sol: string;
}
export const readBalance = (wallet: string) =>
  request<WalletBalance>(`/api/demo/wallets/${encodeURIComponent(wallet)}`);

// Keep the request ID through reloads and uncertain replies. Never fund twice on a retry.
export async function fundWallet(
  wallet: string,
  signal?: AbortSignal,
): Promise<FundingClaim> {
  const key = `swish-demo-funding:${wallet}`;
  let id: string;
  try {
    id = localStorage.getItem(key) ?? crypto.randomUUID();
    localStorage.setItem(key, id);
  } catch {
    throw new Error(
      "Allow browser storage to request test funds, so a retry cannot send twice.",
    );
  }
  let claim = await request<FundingClaim>(
    "/api/demo/funding/claims",
    { wallet, id },
    signal,
  );
  localStorage.setItem(key, claim.id);
  for (let count = 0; claim.status === "pending" && count < 30; count++) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 1800);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    claim = await request<FundingClaim>(
      `/api/demo/funding/claims/${claim.id}`,
      undefined,
      signal,
    );
  }
  if (claim.status === "pending")
    throw new Error(
      "Test funding is still being confirmed. Retry to check the same transfer.",
    );
  localStorage.removeItem(key);
  if (claim.status === "failed")
    throw new Error(
      "Test funding did not go through. You can request funds again.",
    );
  return claim;
}

export interface DeviceLink {
  token: string;
  ownerKey: string;
  expiresAt: number;
}
export interface LinkStatus {
  opened: boolean;
  phase: "waiting" | "sending";
  expiresAt: number;
  result: DepositResult;
}
export interface OpenLink {
  deposit?: DepositRef;
  result?: DepositResult;
  amount?: string;
  expiresAt: number;
}
export const createLink = (deposit: DepositRef) =>
  request<DeviceLink>("/api/demo/handoffs", deposit);
export const linkAction = <T>(
  token: string,
  action: "open" | "status" | "progress" | "cancel",
  body: unknown,
) =>
  request<T>(`/api/demo/handoffs/${encodeURIComponent(token)}/${action}`, body);

export function deviceId(): string {
  const key = "swish-demo-device";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

export function deviceUrl(token: string, origin: string): string {
  const url = new URL(origin);
  url.pathname = "/";
  url.search = "";
  url.hash = new URLSearchParams({ deposit: token }).toString();
  return url.href;
}

/**
 * Test funds confirm in a second or two, but the deposit API reads the chain a
 * little behind that, so for a few seconds it still sees an empty wallet and
 * refuses setup. Ask it until it sees the funds, or stop after `tries`.
 */
export async function untilFundsAreSeen(
  read: () => Promise<{ balance?: string | undefined }>,
  amount: number,
  {
    tries = 15,
    waitMs = 2000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = {},
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const seen = await read().catch(() => null);
    if (seen && Number(seen.balance ?? 0) >= amount) return true;
    if (i < tries - 1) await sleep(waitMs);
  }
  return false;
}
