/**
 * The swish-deposit program: addresses, the challenge a passkey signs, and
 * the instructions the API sends. Mirrors programs/swish-deposit exactly;
 * a mismatch here fails on chain, never silently.
 */
import { createHash } from "node:crypto";

import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS, findEventAuthorityPda } from "@solana/subscriptions";

const configuredProgramId = process.env.SWISH_PROGRAM_ID;
if (!configuredProgramId) throw new Error("SWISH_PROGRAM_ID is not set. Set it in services/api/.env.");
export const PROGRAM_ID = address(configuredProgramId);
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
export const SECP256R1_PROGRAM = address("Secp256r1SigVerify1111111111111111111111111");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const PULL_DOMAIN = Buffer.from("swish-deposit/pull/v2");

const addressBytes = (a: Address) => getAddressEncoder().encode(a) as Uint8Array;
export const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

const pda = async (...seeds: (string | Uint8Array)[]) =>
  (await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds })).at(0) as Address;

export const configPda = () => pda("config");
export const pullerPda = () => pda("puller");
export const appPda = (appId: Uint8Array) => pda("app", appId);
export const swishIdPda = (passkey: Uint8Array) => pda("swish_id", sha256(passkey));
export const linkedWalletPda = (wallet: Address) => pda("wallet", addressBytes(wallet));
export const receiptPda = (depositId: Uint8Array) => pda("receipt", depositId);

/** A UUID's 16 bytes: app ids and deposit ids are UUIDs in the database. */
export function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** The cluster tag in Config: sha256 of the 32 raw bytes of the genesis hash. */
export function clusterTag(genesisHashBytes: Uint8Array): Uint8Array {
  return sha256(genesisHashBytes);
}

export interface PullChallenge {
  clusterTag: Uint8Array;
  programId: Address;
  depositId: Uint8Array;
  appId: Uint8Array;
  mint: Address;
  destination: Address;
  amount: bigint;
  expiresAt: bigint;
}

/** What the passkey signs (webauthn.rs `PullChallenge::hash`). */
export function pullChallenge(c: PullChallenge): Uint8Array {
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(c.amount);
  const expiresAt = Buffer.alloc(8);
  expiresAt.writeBigInt64LE(c.expiresAt);
  return sha256(
    PULL_DOMAIN,
    c.clusterTag,
    addressBytes(c.programId),
    c.depositId,
    c.appId,
    addressBytes(c.mint),
    addressBytes(c.destination),
    amount,
    expiresAt,
  );
}

/** Anchor's instruction discriminator. */
const discriminator = (name: string) => sha256(Buffer.from(`global:${name}`)).subarray(0, 8);

const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
const r = (a: Address) => ({ address: a, role: AccountRole.READONLY });
const ws = (s: TransactionSigner) => ({ address: s.address, role: AccountRole.WRITABLE_SIGNER, signer: s });
const rs = (s: TransactionSigner) => ({ address: s.address, role: AccountRole.READONLY_SIGNER, signer: s });

export async function registerAppInstruction(admin: TransactionSigner, appId: Uint8Array): Promise<Instruction> {
  return {
    programAddress: PROGRAM_ID,
    accounts: [ws(admin), r(await configPda()), w(await appPda(appId)), r(SYSTEM_PROGRAM)],
    data: Buffer.concat([discriminator("register_app"), appId]),
  };
}

/** Closes a deposit's receipt once its deadline has passed; the rent goes back to `rentPayer`. */
export async function closeReceiptInstruction(depositId: Uint8Array, rentPayer: Address): Promise<Instruction> {
  return {
    programAddress: PROGRAM_ID,
    accounts: [w(await receiptPda(depositId)), w(rentPayer)],
    data: discriminator("close_receipt"),
  };
}

/**
 * Links `wallet` to the Swish ID of `passkey` (created on first use). The
 * wallet must sign; `payer` (Swish) pays the rent.
 */
export async function linkWalletInstruction(
  wallet: TransactionSigner,
  payer: TransactionSigner,
  passkey: Uint8Array,
): Promise<Instruction> {
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      rs(wallet),
      ws(payer),
      w(await swishIdPda(passkey)),
      w(await linkedWalletPda(wallet.address)),
      r(SYSTEM_PROGRAM),
    ],
    data: Buffer.concat([discriminator("link_wallet"), passkey]),
  };
}

/**
 * Unlinks `wallet` from its Swish ID: deposits can no longer come from it.
 * The wallet must sign; the link's rent goes back to whoever paid it.
 */
export async function unlinkWalletInstruction(
  wallet: TransactionSigner,
  swishId: Address,
  rentPayer: Address,
): Promise<Instruction> {
  return {
    programAddress: PROGRAM_ID,
    accounts: [rs(wallet), w(await linkedWalletPda(wallet.address)), w(swishId), w(rentPayer)],
    data: discriminator("unlink_wallet"),
  };
}

export interface PullAccounts {
  payer: TransactionSigner;
  appId: Uint8Array;
  swishId: Address;
  wallet: Address;
  depositId: Uint8Array;
  delegation: Address;
  subscriptionAuthority: Address;
  source: Address;
  receiver: Address;
  mint: Address;
}

export interface PullArgs {
  depositId: Uint8Array;
  amount: bigint;
  expiresAt: bigint;
  clientDataJson: Uint8Array;
}

/** Only fixed allowances for now (PullKind::Fixed = 0). */
export async function pullInstruction(a: PullAccounts, args: PullArgs): Promise<Instruction> {
  const [eventAuthority] = await findEventAuthorityPda();
  const fixed = Buffer.alloc(8 + 16 + 1 + 8 + 8 + 4);
  let o = 0;
  fixed.set(discriminator("pull"), o);
  o += 8;
  fixed.set(args.depositId, o);
  o += 16;
  fixed.writeUInt8(0, o); // PullKind::Fixed
  o += 1;
  fixed.writeBigUInt64LE(args.amount, o);
  o += 8;
  fixed.writeBigInt64LE(args.expiresAt, o);
  o += 8;
  fixed.writeUInt32LE(args.clientDataJson.length, o);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      ws(a.payer),
      r(await configPda()),
      r(await appPda(a.appId)),
      r(a.swishId),
      r(await linkedWalletPda(a.wallet)),
      w(await receiptPda(a.depositId)),
      r(await pullerPda()),
      w(a.delegation),
      r(a.subscriptionAuthority),
      w(a.source),
      w(a.receiver),
      r(a.mint),
      r(TOKEN_PROGRAM),
      r(eventAuthority),
      r(SUBSCRIPTIONS_PROGRAM_ADDRESS),
      r(INSTRUCTIONS_SYSVAR),
      r(SYSTEM_PROGRAM),
    ],
    data: Buffer.concat([fixed, args.clientDataJson]),
  };
}

/** Compute budget without the extra package (its kit peer is ahead of ours). */
export function computeUnitLimit(units: number): Instruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(units, 1);
  return { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data };
}

export function computeUnitPrice(microLamports: bigint): Instruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(microLamports, 1);
  return { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data };
}

// Account layouts (8-byte Anchor discriminator first).
export const LINKED_WALLET_SIZE = 8 + 32 + 32 + 32 + 1;
/** Offset of `swish_id` inside a LinkedWallet account. */
export const LINKED_WALLET_SWISH_ID_OFFSET = 8 + 32;
export const LINKED_WALLET_RENT_PAYER_OFFSET = LINKED_WALLET_SWISH_ID_OFFSET + 32;
