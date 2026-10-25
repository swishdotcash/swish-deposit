import { getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { PROGRAM_ID, paymentCommitment, sha256 } from "../src/chain/program.js";
import { decodeDepositReceipt } from "../src/chain/receipt.js";

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));

describe("payment receipt evidence", () => {
  function receipt() {
    const data = Buffer.alloc(145);
    data.set(sha256(Buffer.from("account:DepositReceipt")).subarray(0, 8));
    data.set(getAddressEncoder().encode(addr(1)), 16);
    data.set(new Uint8Array(32).fill(7), 49);
    data.set(getAddressEncoder().encode(addr(2)), 81);
    data.set(getAddressEncoder().encode(addr(3)), 113);
    return data;
  }

  it("decodes the commitment and actual payer from the exact contract layout", () => {
    expect(decodeDepositReceipt(PROGRAM_ID, receipt())).toEqual({
      rentPayer: addr(1), commitment: new Uint8Array(32).fill(7), wallet: addr(2), swishId: addr(3),
    });
  });

  it("rejects system-owned impostors, bad discriminators and legacy or truncated receipts", () => {
    expect(() => decodeDepositReceipt(addr(0), receipt())).toThrow(/owner or layout/);
    for (const size of [0, 49, 144, 146]) {
      expect(() => decodeDepositReceipt(PROGRAM_ID, Buffer.alloc(size))).toThrow(/owner or layout/);
    }
    const bad = receipt();
    bad[0] = bad[0]! ^ 1;
    expect(() => decodeDepositReceipt(PROGRAM_ID, bad)).toThrow(/owner or layout/);
  });

  it("binds every requested payment field", () => {
    const payment = { clusterTag: new Uint8Array(32).fill(1), programId: PROGRAM_ID, depositId: new Uint8Array(16).fill(5), appId: new Uint8Array(16).fill(6), mint: addr(3), destination: addr(4), amount: 12_500_000n };
    const expected = paymentCommitment(payment);
    expect(Buffer.from(expected).toString("hex")).toBe("dcfaf7c4fb9620b1091ff3895428c902dac310426c2a9f3bd215b928cae732ef");
    for (const changed of [
      { clusterTag: new Uint8Array(32).fill(2) }, { programId: addr(9) },
      { depositId: new Uint8Array(16).fill(9) }, { appId: new Uint8Array(16).fill(9) },
      { mint: addr(9) }, { destination: addr(9) }, { amount: 1n },
    ]) {
      expect(paymentCommitment({ ...payment, ...changed })).not.toEqual(expected);
    }
  });
});
