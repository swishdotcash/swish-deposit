/**
 * Everything the API reads from or sends to the chain, behind one interface
 * so routes can be tested without a validator.
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import { fetchMaybeToken, findAssociatedTokenPda } from "@solana-program/token";
import {
  fetchMaybeFixedDelegation,
  fetchMaybeSubscriptionAuthority,
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
} from "@solana/subscriptions";

import {
  LINKED_WALLET_SIZE,
  LINKED_WALLET_SWISH_ID_OFFSET,
  PROGRAM_ID,
  TOKEN_PROGRAM,
  clusterTag,
  computeUnitLimit,
  computeUnitPrice,
  pullerPda,
} from "./program.js";

/** One linked wallet that can pay a deposit right now. */
export interface Source {
  wallet: Address;
  tokenAccount: Address;
  subscriptionAuthority: Address;
  delegation: Address;
}

/** A transaction for a wallet to sign, and the bytes its signature covers. */
export interface WalletTransaction {
  wire: Uint8Array;
  messageBytes: Uint8Array;
}

export interface Chain {
  sponsor: KeyPairSigner;
  clusterTag(): Promise<Uint8Array>;
  /** The token account a deposit to `owner` lands in (their associated account). */
  destinationFor(owner: Address, mint: Address): Promise<Address>;
  /** The first wallet of this Swish ID with enough balance and allowance. */
  findSource(swishId: Address, mint: Address, amount: bigint): Promise<Source | null>;
  /** The wallet's Foundation authority for this mint, if it has one. */
  subscriptionAuthority(wallet: Address, mint: Address): Promise<{ initId: bigint } | null>;
  /** Whether an account exists. */
  exists(account: Address): Promise<boolean>;
  /** Signs as sponsor, sends, and waits for confirmation. Returns the signature. */
  send(instructions: Instruction[]): Promise<string>;
  /** The same, with another fee payer (e.g. the admin registering an app). */
  sendAs(feePayer: TransactionSigner, instructions: Instruction[]): Promise<string>;
  /** Built with the sponsor as fee payer; the wallet signs it, then we do. */
  buildForWallet(instructions: Instruction[]): Promise<WalletTransaction>;
  /** Decodes a wallet-signed transaction (to check it before we sign). */
  decode(wire: Uint8Array): Transaction;
  /** Adds the sponsor's signature, sends, confirms. */
  sendWalletSigned(tx: Transaction): Promise<string>;
}

const CONFIRM_TIMEOUT_MS = 60_000;
const PRIORITY_MICROLAMPORTS = 10_000n;
const COMPUTE_UNITS = 400_000;

export class ChainError extends Error {
  constructor(
    message: string,
    readonly signature?: string,
  ) {
    super(message);
  }
}

const bigintJson = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

export class SolanaChain implements Chain {
  private readonly rpc: Rpc<SolanaRpcApi>;
  private tag?: Uint8Array;

  constructor(
    rpcUrl: string,
    readonly sponsor: KeyPairSigner,
  ) {
    this.rpc = createSolanaRpc(rpcUrl);
  }

  async clusterTag(): Promise<Uint8Array> {
    if (!this.tag) {
      const genesis = await this.rpc.getGenesisHash().send();
      this.tag = clusterTag(getBase58Encoder().encode(genesis) as Uint8Array);
    }
    return this.tag;
  }

  async destinationFor(owner: Address, mint: Address): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM });
    return ata;
  }

  async findSource(swishId: Address, mint: Address, amount: bigint): Promise<Source | null> {
    const linked = await this.rpc
      .getProgramAccounts(PROGRAM_ID, {
        encoding: "base64",
        filters: [
          { dataSize: BigInt(LINKED_WALLET_SIZE) },
          {
            memcmp: {
              offset: BigInt(LINKED_WALLET_SWISH_ID_OFFSET),
              bytes: swishId as string as Base58EncodedBytes,
              encoding: "base58",
            },
          },
        ],
      })
      .send();
    const puller = await pullerPda();
    for (const { account } of linked) {
      const data = getBase64Encoder().encode(account.data[0]);
      const wallet = getAddressDecoder().decode(data.subarray(8, 40));
      const [tokenAccount] = await findAssociatedTokenPda({ owner: wallet, mint, tokenProgram: TOKEN_PROGRAM });
      const [subscriptionAuthority] = await findSubscriptionAuthorityPda({ user: wallet, tokenMint: mint });
      const [delegation] = await findFixedDelegationPda({
        subscriptionAuthority,
        delegator: wallet,
        delegatee: puller,
        nonce: 0n,
      });
      const [token, allowance] = await Promise.all([
        fetchMaybeToken(this.rpc, tokenAccount),
        fetchMaybeFixedDelegation(this.rpc, delegation),
      ]);
      if (!token.exists || !allowance.exists) continue;
      const expired = allowance.data.expiryTs !== 0n && allowance.data.expiryTs < nowSeconds();
      if (!expired && token.data.amount >= amount && allowance.data.amount >= amount) {
        return { wallet, tokenAccount, subscriptionAuthority, delegation };
      }
    }
    return null;
  }

  async subscriptionAuthority(wallet: Address, mint: Address) {
    const [pda] = await findSubscriptionAuthorityPda({ user: wallet, tokenMint: mint });
    const acc = await fetchMaybeSubscriptionAuthority(this.rpc, pda);
    return acc.exists ? { initId: acc.data.initId } : null;
  }

  async exists(account: Address): Promise<boolean> {
    const { value } = await this.rpc.getAccountInfo(account, { encoding: "base64" }).send();
    return value !== null;
  }

  private async message(instructions: Instruction[], feePayer: TransactionSigner = this.sponsor) {
    const { value: blockhash } = await this.rpc.getLatestBlockhash().send();
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) =>
        appendTransactionMessageInstructions(
          [computeUnitLimit(COMPUTE_UNITS), computeUnitPrice(PRIORITY_MICROLAMPORTS), ...instructions],
          m,
        ),
    );
  }

  async send(instructions: Instruction[]): Promise<string> {
    const tx = await signTransactionMessageWithSigners(await this.message(instructions));
    return this.sendAndConfirm(tx);
  }

  async sendAs(feePayer: TransactionSigner, instructions: Instruction[]): Promise<string> {
    const tx = await signTransactionMessageWithSigners(await this.message(instructions, feePayer));
    return this.sendAndConfirm(tx);
  }

  async buildForWallet(instructions: Instruction[]): Promise<WalletTransaction> {
    // No signatures yet: the wallet signs first, the sponsor last.
    const tx = compileTransaction(await this.message(instructions));
    return {
      wire: new Uint8Array(getTransactionEncoder().encode(tx)),
      messageBytes: new Uint8Array(tx.messageBytes),
    };
  }

  decode(wire: Uint8Array): Transaction {
    return getTransactionDecoder().decode(wire);
  }

  async sendWalletSigned(tx: Transaction): Promise<string> {
    return this.sendAndConfirm(await partiallySignTransaction([this.sponsor.keyPair], tx));
  }

  private async sendAndConfirm(tx: Transaction): Promise<string> {
    const signature = getSignatureFromTransaction(tx);
    await this.rpc
      .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { value } = await this.rpc.getSignatureStatuses([signature]).send();
      const status = value[0];
      if (status?.err) throw new ChainError(`transaction failed: ${JSON.stringify(status.err, bigintJson)}`, signature);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new ChainError("transaction not confirmed in time", signature);
  }
}
