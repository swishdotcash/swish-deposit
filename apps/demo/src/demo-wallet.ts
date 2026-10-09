import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import {
  browserWallets,
  WalletRejected,
  type ConnectedWallet,
  type Wallets,
} from "core/wallet";
import { fundWallet, readBalance } from "./demo-api";

export const DEMO_WALLET = "Demo Wallet";
export type DemoStage = "creating" | "funding" | "ready" | "failed" | null;
const KEY = "swish-demo-devnet-wallet-v3";
const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><rect width="36" height="36" rx="10" fill="#121212"/><path d="m7 13 4 9 4-5 3 6 3-6 4 5 4-9" fill="none" stroke="#fafafa" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;

async function demoSigner() {
  const stored = localStorage.getItem(KEY);
  if (stored) {
    const value: unknown = JSON.parse(stored);
    if (
      !Array.isArray(value) ||
      value.length !== 64 ||
      !value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    )
      throw new Error(
        "The saved demo wallet could not be read. It was not replaced.",
      );
    const bytes = Uint8Array.from(value);
    try {
      return await createKeyPairSignerFromBytes(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const bytes = new Uint8Array(64);
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    bytes.set(seed);
    bytes.set(
      new Uint8Array(
        await crypto.subtle.exportKey("raw", signer.keyPair.publicKey),
      ),
      32,
    );
    localStorage.setItem(KEY, JSON.stringify(Array.from(bytes)));
    return signer;
  } finally {
    seed.fill(0);
    bytes.fill(0);
  }
}

export function createDemoWallets(options: {
  amount(): number;
  stage(stage: DemoStage): void;
  connected(wallet: ConnectedWallet): void;
  approve(wallet: string): Promise<void>;
  prepare(wallet: ConnectedWallet): Promise<void>;
}): Wallets & { reconnect(name: string): Promise<ConnectedWallet> } {
  const own = browserWallets("devnet");
  let pendingSigner: ReturnType<typeof demoSigner> | undefined;
  async function connect(name: string, prepare = true) {
    if (name !== DEMO_WALLET) {
      options.stage(null);
      const wallet = await own.connect(name);
      options.connected(wallet);
      // Wallet Standard does not expose a reliable active-network setting.
      // This help is dismissible, and explains how to check it in the wallet.
      if (prepare) await options.prepare(wallet);
      return wallet;
    }
    try {
      options.stage("creating");
      pendingSigner ??= demoSigner().catch((e) => {
        pendingSigner = undefined;
        throw e;
      });
      const signer = await pendingSigner;
      const wallet: ConnectedWallet = {
        name: DEMO_WALLET,
        address: signer.address,
        async sign(bytes) {
          await options.approve(signer.address);
          const transaction = getTransactionDecoder().decode(bytes);
          if (!(signer.address in transaction.signatures))
            throw new WalletRejected(
              "This request is not for your Demo Wallet.",
            );
          const signed = await partiallySignTransaction(
            [signer.keyPair],
            transaction,
          );
          return new Uint8Array(getTransactionEncoder().encode(signed));
        },
      };
      options.connected(wallet);
      if (!prepare) return wallet;
      options.stage("funding");
      const balance = await readBalance(signer.address);
      if (Number(balance.usdc) < options.amount() || Number(balance.sol) <= 0)
        await fundWallet(signer.address);
      options.stage("ready");
      // Leave enough time for the success label to be read before step 2.
      await new Promise((resolve) => setTimeout(resolve, 600));
      return wallet;
    } catch (e) {
      options.stage("failed");
      throw new WalletRejected(
        e instanceof Error
          ? e.message
          : "Demo Wallet could not be prepared. Try again.",
      );
    }
  }
  return {
    list: () => [
      { name: DEMO_WALLET, icon },
      ...own.list().filter((w) => w.name !== DEMO_WALLET),
    ],
    connect,
    reconnect: (name) => connect(name, false),
  };
}
