/**
 * An address lookup table for the accounts every deposit names (config,
 * puller, mint, the programs it calls into). In a transaction each of them
 * then costs one byte instead of 32, which is what keeps a deposit under
 * Solana's 1,232-byte limit: the passkey's client data rides inside it, and
 * browsers pad that at will (Chrome adds ~100 bytes to some of them).
 */
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { findEventAuthorityPda, SUBSCRIPTIONS_PROGRAM_ADDRESS } from "@solana/subscriptions";

import { INSTRUCTIONS_SYSVAR, SYSTEM_PROGRAM, TOKEN_PROGRAM, configPda, pullerPda } from "./program.js";

export const LOOKUP_TABLE_PROGRAM = address("AddressLookupTab1e1111111111111111111111111");
/** A table account starts with this much metadata; addresses follow, 32 bytes each. */
const TABLE_META_SIZE = 56;

const signs = (s: TransactionSigner, role: AccountRole.READONLY_SIGNER | AccountRole.WRITABLE_SIGNER) => ({
  address: s.address,
  role,
  signer: s,
});

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** What every deposit transaction names, whoever the user and the app are. */
export async function depositAddresses(mint: Address): Promise<Address[]> {
  const [eventAuthority] = await findEventAuthorityPda();
  return [
    await configPda(),
    await pullerPda(),
    mint,
    TOKEN_PROGRAM,
    eventAuthority,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
    INSTRUCTIONS_SYSVAR,
    SYSTEM_PROGRAM,
  ];
}

/** A table's address comes from its authority and a recent slot. */
export async function lookupTablePda(authority: Address, recentSlot: bigint): Promise<[Address, number]> {
  const [table, bump] = await getProgramDerivedAddress({
    programAddress: LOOKUP_TABLE_PROGRAM,
    seeds: [getAddressEncoder().encode(authority), u64(recentSlot)],
  });
  return [table, bump];
}

export function createLookupTableInstruction(
  table: Address,
  authority: TransactionSigner,
  recentSlot: bigint,
  bump: number,
): Instruction {
  return {
    programAddress: LOOKUP_TABLE_PROGRAM,
    accounts: [
      { address: table, role: AccountRole.WRITABLE },
      signs(authority, AccountRole.READONLY_SIGNER),
      signs(authority, AccountRole.WRITABLE_SIGNER),
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: Buffer.concat([u32(0), u64(recentSlot), Buffer.from([bump])]),
  };
}

export function extendLookupTableInstruction(table: Address, authority: TransactionSigner, addresses: Address[]): Instruction {
  const encoder = getAddressEncoder();
  return {
    programAddress: LOOKUP_TABLE_PROGRAM,
    accounts: [
      { address: table, role: AccountRole.WRITABLE },
      signs(authority, AccountRole.READONLY_SIGNER),
      signs(authority, AccountRole.WRITABLE_SIGNER),
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: Buffer.concat([u32(2), u64(BigInt(addresses.length)), ...addresses.map((a) => Buffer.from(encoder.encode(a)))]),
  };
}

/** The addresses stored in a table account, in order. */
export function tableAddresses(data: Uint8Array): Address[] {
  const decoder = getAddressDecoder();
  const out: Address[] = [];
  for (let o = TABLE_META_SIZE; o + 32 <= data.length; o += 32) out.push(decoder.decode(data.subarray(o, o + 32)));
  return out;
}
