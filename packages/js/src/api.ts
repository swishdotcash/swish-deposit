/**
 * The widget's calls to the Swish Deposit API. Every call carries the app's
 * publishable key; the ones that touch a deposit also carry its client
 * secret, which your server handed to the page.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The deposit the widget was opened for. */
export interface DepositRef {
  id: string;
  clientSecret: string;
}

export interface Challenge {
  /** base64url; what Face ID signs. */
  challenge: string;
  rp_id: string;
  expires_at: string;
  amount: string;
  token: string;
  app: { name: string; website: string };
}

/** A passkey approval, as the browser returned it (all base64url). */
export interface Approval {
  credentialId: string;
  authenticatorData: string;
  clientDataJson: string;
  signature: string;
}

export interface DepositResult {
  id: string;
  status: "created" | "submitted" | "succeeded" | "failed";
  amount: string;
  token: string;
  destination: string;
  reference: string | null;
  signature: string | null;
  error: string | null;
  /** Which of the user's wallets paid. */
  wallet?: string | null;
}

/** What Swish may still move from a wallet, and what the wallet holds (USDC). */
export interface WalletStanding {
  left: string;
  balance: string;
  /** The limit as last set; absent for a wallet set up before Swish kept it. */
  limit?: string;
}

/** A setup transaction for the wallet to sign, or `done`. */
export type SetupStep =
  | { done: true }
  | {
      done: false;
      step: "authorize" | "allow" | "limit" | "unlink";
      /** Unsigned, base64. */
      transaction: string;
      token: string;
      left_now?: string;
      new_limit?: string;
    };

/** One of the user's linked wallets, as it stands for this deposit. */
export interface WalletChoice extends WalletStanding {
  wallet: string;
  /** Holds the deposit's amount and has that much limit left. */
  enough: boolean;
}

export interface DepositApi {
  challenge(deposit: DepositRef): Promise<Challenge>;
  /** The user's linked wallets, against their approval of this deposit. Moves nothing. */
  sources(deposit: DepositRef, approval: Approval): Promise<WalletChoice[]>;
  /** Sends the deposit, from `wallet` when given, else from any linked wallet that can pay. */
  submit(deposit: DepositRef, approval: Approval, wallet?: string): Promise<DepositResult>;
  registerPasskey(credentialId: string, publicKey: string): Promise<void>;
  prepareWallet(deposit: DepositRef, credentialId: string, wallet: string, allowance: string): Promise<SetupStep>;
  addToLimit(deposit: DepositRef, credentialId: string, wallet: string, add: string): Promise<SetupStep>;
  allowance(credentialId: string, wallet: string): Promise<WalletStanding>;
  /** One transaction that unlinks the wallet from its Swish ID and cancels its limit. */
  unlinkWallet(wallet: string): Promise<SetupStep>;
  submitWalletTransaction(transaction: string, token: string): Promise<void>;
}

export const DEFAULT_API_URL = "https://api.swish.cash";

/** `appOrigin`: set by the Swish frame, naming the app page that opened it. */
export function createApi(publishableKey: string, apiUrl: string = DEFAULT_API_URL, appOrigin?: string): DepositApi {
  const base = apiUrl.replace(/\/+$/, "");

  async function post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Swish-Key": publishableKey,
          ...(appOrigin ? { "X-Swish-App-Origin": appOrigin } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "network", "Could not reach Swish. Check your connection and try again.");
    }
    const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (!res.ok) {
      throw new ApiError(res.status, json?.error?.code ?? "unknown", json?.error?.message ?? "Something went wrong");
    }
    return json as T;
  }

  const approved = (d: DepositRef, a: Approval) => ({
    client_secret: d.clientSecret,
    credential_id: a.credentialId,
    authenticator_data: a.authenticatorData,
    client_data_json: a.clientDataJson,
    signature: a.signature,
  });

  const forDeposit = (d: DepositRef) => ({ deposit_id: d.id, client_secret: d.clientSecret });

  return {
    challenge: (d) => post(`/v1/deposits/${d.id}/challenge`, { client_secret: d.clientSecret }),
    sources: async (d, a) =>
      (await post<{ wallets: WalletChoice[] }>(`/v1/deposits/${d.id}/sources`, approved(d, a))).wallets,
    submit: (d, a, wallet) => post(`/v1/deposits/${d.id}/submit`, { ...approved(d, a), ...(wallet ? { wallet } : {}) }),
    registerPasskey: async (credentialId, publicKey) => {
      await post("/v1/setup/passkey", { credential_id: credentialId, public_key: publicKey });
    },
    prepareWallet: (d, credentialId, wallet, allowance) =>
      post("/v1/setup/wallet/prepare", { credential_id: credentialId, wallet, allowance, ...forDeposit(d) }),
    addToLimit: (d, credentialId, wallet, add) =>
      post("/v1/setup/wallet/limit", { credential_id: credentialId, wallet, add, ...forDeposit(d) }),
    allowance: (credentialId, wallet) => post("/v1/setup/wallet/allowance", { credential_id: credentialId, wallet }),
    unlinkWallet: (wallet) => post("/v1/setup/wallet/unlink", { wallet }),
    submitWalletTransaction: async (transaction, token) => {
      await post("/v1/setup/wallet/submit", { transaction, token });
    },
  };
}
