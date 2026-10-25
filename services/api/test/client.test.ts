import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { ChainError, SolanaChain } from "../src/chain/client.js";

async function client() {
  const sponsor = await generateKeyPairSigner();
  const chain = new SolanaChain("https://rpc.invalid", sponsor);
  const rpc = {
    getLatestBlockhash: vi.fn(() => ({ send: async () => ({ value: { blockhash: sponsor.address, lastValidBlockHeight: 100n } }) })),
    sendTransaction: vi.fn(() => ({ send: async () => {} })),
    getSignatureStatuses: vi.fn(() => ({ send: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }) })),
    getBlockHeight: vi.fn(() => ({ send: async () => 101n })),
  };
  Object.defineProperty(chain, "rpc", { value: rpc });
  return { chain, rpc };
}

describe("broadcast persistence and settlement evidence", () => {
  it("does not broadcast when saving the signed transaction fails", async () => {
    const { chain, rpc } = await client();
    await expect(chain.send([], async () => { throw new Error("database unavailable"); })).rejects.toThrow("database unavailable");
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("saves the signature and lifetime before broadcasting, and preserves identity on transport failure", async () => {
    const { chain, rpc } = await client();
    let saved = "";
    rpc.sendTransaction.mockImplementation(() => ({ send: async () => {
      expect(saved).not.toBe("");
      throw new TypeError("reply lost after send");
    } }));
    const failed = chain.send([], async ({ signature, lastValidBlockHeight }) => {
      expect(rpc.sendTransaction).not.toHaveBeenCalled();
      expect(lastValidBlockHeight).toBe(100n);
      saved = signature;
    });
    await expect(failed).rejects.toBeInstanceOf(ChainError);
    await expect(failed).rejects.toMatchObject({ signature: saved });
    await expect(failed).rejects.toMatchObject({ cause: expect.any(TypeError) });
  });

  it("never treats a processed error as settled failure", async () => {
    const { chain, rpc } = await client();
    rpc.getSignatureStatuses.mockReturnValue({ send: async () => ({ value: [{ err: "error", confirmationStatus: "processed" }] }) } as never);
    expect(await chain.transactionStatus("signature", 100n)).toBe("pending");
    expect(rpc.getBlockHeight).not.toHaveBeenCalled();
  });

  it("checks historical status again after finalized expiry to catch a late landing", async () => {
    const { chain, rpc } = await client();
    rpc.getSignatureStatuses
      .mockReturnValueOnce({ send: async () => ({ value: [null] }) } as never)
      .mockReturnValueOnce({ send: async () => ({ value: [{ err: null, confirmationStatus: "finalized" }] }) });
    expect(await chain.transactionStatus("signature", 100n)).toBe("confirmed");
    expect(rpc.getSignatureStatuses).toHaveBeenCalledWith(["signature"], { searchTransactionHistory: true });
  });

  it("establishes expiry only when finalized height passed the lifetime and history is still empty", async () => {
    const { chain, rpc } = await client();
    rpc.getSignatureStatuses.mockReturnValue({ send: async () => ({ value: [null] }) } as never);
    expect(await chain.transactionStatus("signature", null)).toBe("pending");
    expect(await chain.transactionStatus("signature", 100n)).toBe("expired");
  });
});
