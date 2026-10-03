/**
 * The user's Solana wallet, found through the Wallet Standard (Phantom,
 * Solflare, Backpack and others announce themselves this way). Used only
 * during setup and limit changes: the wallet signs what the API prepared.
 */

export type Cluster = "mainnet" | "devnet";

export interface WalletOption {
  name: string;
  icon: string;
}

export interface ConnectedWallet {
  name: string;
  address: string;
  /** Signs a transaction and returns it, still unsent. */
  sign(transaction: Uint8Array): Promise<Uint8Array>;
}

export interface Wallets {
  list(): WalletOption[];
  connect(name: string): Promise<ConnectedWallet>;
}

/** The wallet's window was closed or the request refused. */
export class WalletRejected extends Error {}

interface StandardAccount {
  address: string;
}

interface StandardWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly StandardAccount[] }>;
}

interface SignTransactionFeature {
  signTransaction(input: {
    account: StandardAccount;
    transaction: Uint8Array;
    chain?: string;
  }): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

const CONNECT = "standard:connect";
const SIGN = "solana:signTransaction";

const usable = (w: StandardWallet) =>
  CONNECT in w.features && SIGN in w.features && w.chains.some((c) => c.startsWith("solana:"));

export function browserWallets(cluster: Cluster): Wallets {
  const found: StandardWallet[] = [];
  const api = Object.freeze({
    register(...wallets: StandardWallet[]) {
      for (const w of wallets) if (!found.includes(w)) found.push(w);
      return () => {};
    },
  });

  if (typeof window !== "undefined") {
    // Wallets loaded after us announce themselves; ones loaded before answer our event.
    window.addEventListener("wallet-standard:register-wallet", (e) => {
      (e as CustomEvent<(a: typeof api) => void>).detail(api);
    });
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  }

  return {
    list: () => found.filter(usable).map(({ name, icon }) => ({ name, icon })),

    async connect(name) {
      const wallet = found.find((w) => w.name === name && usable(w));
      if (!wallet) throw new WalletRejected(`${name} is not available in this browser.`);
      let account: StandardAccount | undefined;
      try {
        const { accounts } = await (wallet.features[CONNECT] as ConnectFeature).connect();
        account = accounts[0] ?? wallet.accounts[0];
      } catch (e) {
        throw new WalletRejected(reason(e, "The wallet did not connect."));
      }
      if (!account) throw new WalletRejected("The wallet did not share an account.");
      const signer = account;
      return {
        name: wallet.name,
        address: signer.address,
        async sign(transaction) {
          try {
            const [signed] = await (wallet.features[SIGN] as SignTransactionFeature).signTransaction({
              account: signer,
              transaction,
              chain: `solana:${cluster}`,
            });
            if (!signed) throw new Error("nothing came back");
            return signed.signedTransaction;
          } catch (e) {
            throw new WalletRejected(reason(e, "The wallet did not sign."));
          }
        },
      };
    },
  };
}

const reason = (e: unknown, fallback: string) =>
  e instanceof Error && /reject|denied|cancel/i.test(e.message) ? "You closed the wallet request." : fallback;
