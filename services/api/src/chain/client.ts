/**
 * Everything the API reads from or sends to the chain, behind one interface
 * so routes can be tested without a validator.
 */
import {
  appendTransactionMessageInstructions,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
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
  type Signature,
  type SolanaRpcApi,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import { fetchMaybeToken, findAssociatedTokenPda } from "@solana-program/token";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  fetchAllMaybeFixedDelegation,
  fetchMaybeSubscriptionAuthority,
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
  getCreateFixedDelegationDiscriminatorBytes,
  getCreateFixedDelegationInstructionDataDecoder,
} from "@solana/subscriptions";

import {
  createLookupTableInstruction,
  extendLookupTableInstruction,
  lookupTablePda,
  tableAddresses,
} from "./lookupTable.js";
import {
  LINKED_WALLET_SIZE,
  LINKED_WALLET_RENT_PAYER_OFFSET,
  LINKED_WALLET_SWISH_ID_OFFSET,
  PROGRAM_ID,
  TOKEN_PROGRAM,
  clusterTag,
  computeUnitLimit,
  computeUnitPrice,
  linkedWalletPda,
  pullerPda,
  receiptPda,
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

/** How many of an allowance's past transactions are read at a time when looking for its creation. */
const LIMIT_READS_AT_ONCE = 6;

/** The limit an allowance was created with, and how far its history has been read. */
export interface LimitSet {
  /** The newest signature in what was read; null when there was nothing new. */
  newest: string | null;
  /** Null when no creation is in what was read. */
  amount: bigint | null;
}

/** A transaction for a wallet to sign, and the bytes its signature covers. */
export interface WalletTransaction {
  wire: Uint8Array;
  messageBytes: Uint8Array;
}

export interface LinkedWallet {
  swishId: Address;
  rentPayer: Address;
}

export interface Chain {
  sponsor: KeyPairSigner;
  clusterTag(): Promise<Uint8Array>;
  /** The token account a deposit to `owner` lands in (their associated account). */
  destinationFor(owner: Address, mint: Address): Promise<Address>;
  /**
   * The first wallet of this Swish ID with enough balance and allowance; with
   * `only`, that wallet or nothing.
   */
  findSource(swishId: Address, mint: Address, amount: bigint, only?: Address): Promise<Source | null>;
  /** Every wallet linked to this Swish ID. */
  linkedWallets(swishId: Address): Promise<Address[]>;
  /** The wallet's allowances naming our puller for this mint (normally one). */
  allowances(wallet: Address, mint: Address): Promise<Allowance[]>;
  /**
   * The limit an allowance was created with, from its history (the account
   * only keeps what is left). `after` is the newest signature already read:
   * only what came later is looked at.
   */
  limitSet(allowance: Address, after?: string): Promise<LimitSet>;
  /** The Swish ID a wallet is linked to, if any. */
  linkedSwishId(wallet: Address): Promise<Address | null>;
  /** A wallet's link: its Swish ID and who paid the link's rent. */
  linkedWallet(wallet: Address): Promise<LinkedWallet | null>;
  /** The wallet's Foundation authority for this mint, if it has one. */
  subscriptionAuthority(wallet: Address, mint: Address): Promise<{ initId: bigint } | null>;
  /** A deposit's receipt: who paid its rent. Null once closed (or never made). */
  receipt(depositId: Uint8Array): Promise<{ rentPayer: Address } | null>;
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

/**
 * RPC providers answer 429 under load, and drop a connection now and then;
 * wait and ask again instead of failing a deposit. Safe for sends too: the
 * same signed transaction is the same transaction.
 */
function retryOnRateLimit(transport: RpcTransport): RpcTransport {
  return (async (config: Parameters<RpcTransport>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(config);
      } catch (e) {
        const limited =
          isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && e.context.statusCode === 429;
        // fetch itself failing (timeout, socket closed) is a TypeError, not an RPC answer.
        const dropped = e instanceof TypeError;
        if (!(limited || dropped) || attempt >= RATE_LIMIT_RETRIES) throw e;
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
  /** Shrinks what the sponsor sends: see lookupTable.ts. */
  private lookup?: { table: Address; addresses: Address[] };

  constructor(
    rpcUrl: string,
    readonly sponsor: KeyPairSigner,
  ) {
    this.rpc = createSolanaRpcFromTransport(retryOnRateLimit(createDefaultRpcTransport({ url: rpcUrl })));
  }

  /**
   * Uses this lookup table for what the sponsor sends, if it is on chain and
   * holds every address in `wanted`. Says whether it does.
   */
  async useLookupTable(table: Address, wanted: Address[]): Promise<boolean> {
    const { value } = await this.rpc.getAccountInfo(table, { encoding: "base64" }).send();
    if (!value) return false;
    const addresses = tableAddresses(getBase64Encoder().encode(value.data[0]) as Uint8Array);
    if (!wanted.every((a) => addresses.includes(a))) return false;
    this.lookup = { table, addresses };
    return true;
  }

  /** Creates a lookup table holding `addresses`; the sponsor pays and owns it. */
  async createLookupTable(addresses: Address[]): Promise<Address> {
    // The table's address includes a recent slot the validator must know. RPC
    // nodes run a little out of step with each other, so try a few.
    for (let attempt = 0; ; attempt++) {
      const recentSlot = await this.rpc.getSlot({ commitment: "finalized" }).send();
      const [table, bump] = await lookupTablePda(this.sponsor.address, recentSlot);
      try {
        await this.send([
          createLookupTableInstruction(table, this.sponsor, recentSlot, bump),
          extendLookupTableInstruction(table, this.sponsor, addresses),
        ]);
        return table;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
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

  async findSource(swishId: Address, mint: Address, amount: bigint, only?: Address): Promise<Source | null> {
    for (const wallet of await this.linkedWallets(swishId)) {
      if (only && wallet !== only) continue;
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

  async linkedWallets(swishId: Address): Promise<Address[]> {
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
    return linked.map(({ account }) => getAddressDecoder().decode(getBase64Encoder().encode(account.data[0]).subarray(8, 40)));
  }

  async limitSet(allowance: Address, after?: string): Promise<LimitSet> {
    const history = await this.rpc
      .getSignaturesForAddress(allowance, { limit: 1000, ...(after ? { until: after as Signature } : {}) })
      .send();
    const newest = history[0]?.signature ?? null;
    const landed = history.filter((h) => h.err === null);
    // Newest first, a few at a time: the creation is one deposit back for each deposit since.
    for (let i = 0; i < landed.length; i += LIMIT_READS_AT_ONCE) {
      const amounts = await Promise.all(
        landed.slice(i, i + LIMIT_READS_AT_ONCE).map((h) => this.createdWith(allowance, h.signature)),
      );
      const amount = amounts.find((a) => a !== null);
      if (amount !== undefined) return { newest, amount };
    }
    return { newest, amount: null };
  }

  /** The amount this transaction created `allowance` with; null when it did not create it. */
  private async createdWith(allowance: Address, signature: Signature): Promise<bigint | null> {
    const tx = await this.rpc.getTransaction(signature, { encoding: "json", maxSupportedTransactionVersion: 0 }).send();
    if (!tx) return null;
    const { message } = tx.transaction;
    const loaded = tx.meta?.loadedAddresses;
    const keys = [...message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
    const created = getCreateFixedDelegationDiscriminatorBytes();
    for (const ix of message.instructions) {
      if (keys[ix.programIdIndex] !== SUBSCRIPTIONS_PROGRAM_ADDRESS) continue;
      // Changing a limit revokes one allowance and creates another in one transaction: only ours counts.
      if (!ix.accounts.some((i) => keys[i] === allowance)) continue;
      const data = getBase58Encoder().encode(ix.data);
      if (!created.every((byte, i) => data[i] === byte)) continue;
      return getCreateFixedDelegationInstructionDataDecoder().decode(data).fixedDelegation.amount;
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
    return (await this.linkedWallet(wallet))?.swishId ?? null;
  }

  async linkedWallet(wallet: Address): Promise<LinkedWallet | null> {
    const { value } = await this.rpc.getAccountInfo(await linkedWalletPda(wallet), { encoding: "base64" }).send();
    if (!value) return null;
    const data = getBase64Encoder().encode(value.data[0]);
    const at = (offset: number) => getAddressDecoder().decode(data.subarray(offset, offset + 32));
    return { swishId: at(LINKED_WALLET_SWISH_ID_OFFSET), rentPayer: at(LINKED_WALLET_RENT_PAYER_OFFSET) };
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

  async receipt(depositId: Uint8Array): Promise<{ rentPayer: Address } | null> {
    const { value } = await this.rpc.getAccountInfo(await receiptPda(depositId), { encoding: "base64" }).send();
    if (!value) return null;
    // DepositReceipt: discriminator (8) · expires_at (8) · rent_payer (32) · bump
    const data = getBase64Encoder().encode(value.data[0]);
    return { rentPayer: getAddressDecoder().decode(data.subarray(16, 48)) };
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
    const message = await this.message(instructions);
    const tx = await signTransactionMessageWithSigners(
      this.lookup
        ? compressTransactionMessageUsingAddressLookupTables(message, { [this.lookup.table]: this.lookup.addresses })
        : message,
    );
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
