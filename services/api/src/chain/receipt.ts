import { getAddressDecoder, type Address } from "@solana/kit";

import { PROGRAM_ID, sha256 } from "./program.js";

export interface DepositReceipt {
  rentPayer: Address;
  commitment: Uint8Array;
  wallet: Address;
  swishId: Address;
}

export class InvalidReceiptError extends Error {}

/** Reject spoofed accounts and legacy receipts that cannot prove a payment. */
export function decodeDepositReceipt(owner: Address, data: Uint8Array): DepositReceipt {
  // discriminator · expires_at · rent_payer · bump · commitment · wallet · swish_id
  const discriminator = sha256(Buffer.from("account:DepositReceipt")).subarray(0, 8);
  if (owner !== PROGRAM_ID || data.length !== 145 || !discriminator.every((b, i) => data[i] === b)) {
    throw new InvalidReceiptError("receipt has an invalid owner or layout; payment requires investigation");
  }
  const addressAt = (offset: number) => getAddressDecoder().decode(data.subarray(offset, offset + 32));
  return { rentPayer: addressAt(16), commitment: new Uint8Array(data.subarray(49, 81)), wallet: addressAt(81), swishId: addressAt(113) };
}
