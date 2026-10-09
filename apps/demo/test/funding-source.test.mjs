import { expect, it, vi } from "vitest";
vi.mock("@solana/kit", async (original) => ({
  ...(await original()),
  createSolanaRpc: vi.fn(),
}));
import { createSolanaRpc } from "@solana/kit";
import { createFundingSource } from "../server/funding-source.mjs";
const wallet = "CG1gKGxUuRHKAnYiTzVbf6aWkFJUyBtCqy5MSFLoHhFk";
const send = (value) => ({ send: async () => value });
it("accepts the full Solana Devnet genesis hash", async () => {
  createSolanaRpc.mockReturnValue({
    getGenesisHash: () => send("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
    getBalance: () => send({ value: 20000000n }),
    getAccountInfo: () => send({ value: null }),
  });
  const source = createFundingSource({
    rpcUrl: "https://devnet.invalid",
    keypairPath: "/unused",
  });
  expect(await source.balances(wallet)).toEqual({
    solLamports: 20000000n,
    usdcUnits: 0n,
  });
});
it("rejects another cluster before reading balances or preparing funds", async () => {
  const getBalance = vi.fn();
  createSolanaRpc.mockReturnValue({
    getGenesisHash: () => send("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
    getBalance,
  });
  const source = createFundingSource({
    rpcUrl: "https://mainnet.invalid",
    keypairPath: "/unused",
  });
  await expect(source.balances(wallet)).rejects.toMatchObject({
    code: "wrong_network",
  });
  await expect(source.prepare(wallet)).rejects.toMatchObject({
    code: "wrong_network",
  });
  expect(getBalance).not.toHaveBeenCalled();
});
