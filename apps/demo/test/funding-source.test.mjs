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
it("takes the bank key from a variable when there is no file", async () => {
  createSolanaRpc.mockReturnValue({
    getGenesisHash: () => send("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
    getBalance: () => send({ value: 0n }),
    getAccountInfo: () => send({ value: null }),
    getMinimumBalanceForRentExemption: () => send(2039280n),
  });
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const seed = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).slice(-32);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const source = createFundingSource({
    rpcUrl: "https://devnet.invalid",
    keypairPath: "/does/not/exist",
    keypair: JSON.stringify([...seed, ...pub]),
  });
  const status = await source.status();
  expect(status.available).toBe(true);
  expect(status.ready).toBe(false);
  expect(status.sourceAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});
it("says funding needs configuration when there is neither a variable nor a readable file", async () => {
  createSolanaRpc.mockReturnValue({});
  const source = createFundingSource({ rpcUrl: "https://devnet.invalid", keypairPath: "/does/not/exist" });
  await expect(source.status()).rejects.toMatchObject({ code: "funding_unavailable" });
});
