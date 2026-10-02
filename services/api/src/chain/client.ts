/**
 * Everything the API reads from or sends to the chain, behind one interface
 * so routes can be tested without a validator.
 */
import {
  appendTransactionMessageInstructions,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  compileTransaction,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getAddressDecoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  isSolanaError,
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
  type RpcTransport,
  type SolanaRpcApi,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import { fetchMaybeToken, findAssociatedTokenPda } from "@solana-program/token";
import {
  fetchAllMaybeFixedDelegation,
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
  linkedWalletPda,
  pullerPda,
} from "./program.js";

/** One linked wallet that can pay a deposit right now. */
export interface Source {
  wallet: Address;
  tokenAccount: Address;
  subscriptionAuthority: Address;
  delegation: Address;
}

/** A fixed allowance: `amount` is what is LEFT to pull. */
export interface Allowance {
  address: Address;
  nonce: bigint;
  subscriptionAuthority: Address;
  amount: bigint;
  expiryTs: bigint;
}

/**
 * Allowances live at a PDA per nonce. Changing a limit replaces the allowance
 * with one at the next free nonce, so a wallet only ever walks a few of them.
 */
export const MAX_ALLOWANCE_NONCE = 32n;

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
  /** The wallet's allowances naming our puller for this mint (normally one). */
  allowances(wallet: Address, mint: Address): Promise<Allowance[]>;
  /** The Swish ID a wallet is linked to, if any. */
  linkedSwishId(wallet: Address): Promise<Address | null>;
  /** The wallet's Foundation authority for this mint, if it has one. */
  subscriptionAuthority(wallet: Address, mint: Address): Promise<{ initId: bigint } | null>;
  /** The wallet's token balance in base units; null when it has no token account. */
  tokenBalance(wallet: Address, mint: Address): Promise<bigint | null>;
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

const RATE_LIMIT_RETRIES = 5;

/** RPC providers answer 429 under load; wait and ask again instead of failing a deposit. */
function retryOnRateLimit(transport: RpcTransport): RpcTransport {
  return (async (config: Parameters<RpcTransport>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(config);
      } catch (e) {
        const limited =
          isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && e.context.statusCode === 429;
        if (!limited || attempt >= RATE_LIMIT_RETRIES) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }) as RpcTransport;
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
    this.rpc = createSolanaRpcFromTransport(retryOnRateLimit(createDefaultRpcTransport({ url: rpcUrl })));
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
    for (const { account } of linked) {
      const data = getBase64Encoder().encode(account.data[0]);
      const wallet = getAddressDecoder().decode(data.subarray(8, 40));
      const [tokenAccount] = await findAssociatedTokenPda({ owner: wallet, mint, tokenProgram: TOKEN_PROGRAM });
      const [token, allowances] = await Promise.all([fetchMaybeToken(this.rpc, tokenAccount), this.allowances(wallet, mint)]);
      if (!token.exists || token.data.amount < amount) continue;
      const usable = allowances.find(
        (a) => a.amount >= amount && (a.expiryTs === 0n || a.expiryTs >= nowSeconds()),
      );
      if (usable) {
        return { wallet, tokenAccount, subscriptionAuthority: usable.subscriptionAuthority, delegation: usable.address };
      }
    }
    return null;
  }

  async allowances(wallet: Address, mint: Address): Promise<Allowance[]> {
    const [subscriptionAuthority] = await findSubscriptionAuthorityPda({ user: wallet, tokenMint: mint });
    const puller = await pullerPda();
    const nonces = Array.from({ length: Number(MAX_ALLOWANCE_NONCE) }, (_, i) => BigInt(i));
    const addresses = await Promise.all(
      nonces.map(async (nonce) => (await findFixedDelegationPda({ subscriptionAuthority, delegator: wallet, delegatee: puller, nonce }))[0]),
    );
    const accounts = await fetchAllMaybeFixedDelegation(this.rpc, addresses);
    return accounts.flatMap((acc, i) =>
      acc.exists && acc.data.mint === mint
        ? [{ address: addresses[i]!, nonce: nonces[i]!, subscriptionAuthority, amount: acc.data.amount, expiryTs: acc.data.expiryTs }]
        : [],
    );
  }

  async linkedSwishId(wallet: Address): Promise<Address | null> {
    const { value } = await this.rpc.getAccountInfo(await linkedWalletPda(wallet), { encoding: "base64" }).send();
    if (!value) return null;
    const data = getBase64Encoder().encode(value.data[0]);
    return getAddressDecoder().decode(data.subarray(LINKED_WALLET_SWISH_ID_OFFSET, LINKED_WALLET_SWISH_ID_OFFSET + 32));
  }

  async subscriptionAuthority(wallet: Address, mint: Address) {
    const [pda] = await findSubscriptionAuthorityPda({ user: wallet, tokenMint: mint });
    const acc = await fetchMaybeSubscriptionAuthority(this.rpc, pda);
    return acc.exists ? { initId: acc.data.initId } : null;
  }

  async tokenBalance(wallet: Address, mint: Address): Promise<bigint | null> {
    const [ata] = await findAssociatedTokenPda({ owner: wallet, mint, tokenProgram: TOKEN_PROGRAM });
    const token = await fetchMaybeToken(this.rpc, ata);
    return token.exists ? token.data.amount : null;
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
