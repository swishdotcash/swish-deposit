// A dedicated devnet bank. The browser never receives its key.
import { readFile, stat } from "node:fs/promises";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import { DemoError } from "./http.mjs";

export const DEVNET_USDC = address(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const PAYOUT = Object.freeze({
  usdc: "10",
  sol: "0.02",
  usdcUnits: 10_000_000n,
  solLamports: 20_000_000n,
});

export function walletAddress(value) {
  try {
    if (typeof value !== "string") throw new Error();
    return address(value);
  } catch {
    throw new DemoError(
      400,
      "bad_wallet",
      "Enter a valid Solana wallet address.",
    );
  }
}

// `keypair` is the bank key itself (the JSON byte array `solana-keygen` writes),
// for hosts that keep secrets in variables and have no file to point at.
export function createFundingSource({ rpcUrl, keypairPath, keypair }) {
  const rpc = createSolanaRpc(rpcUrl);
  let signerPromise;
  let checkedNetwork;
  async function devnet() {
    checkedNetwork ??= rpc
      .getGenesisHash()
      .send()
      .then((hash) => {
        if (hash !== DEVNET_GENESIS)
          throw new DemoError(
            503,
            "wrong_network",
            "Test funding is available only on Solana Devnet.",
          );
      })
      .catch((e) => {
        checkedNetwork = undefined;
        throw e;
      });
    await checkedNetwork;
  }
  async function signer() {
    signerPromise ??= (async () => {
      try {
        if (!keypair && (await stat(keypairPath)).mode & 0o077)
          throw new Error("permissions");
        const data = JSON.parse(
          keypair ?? (await readFile(keypairPath, "utf8")),
        );
        if (
          !Array.isArray(data) ||
          data.length !== 64 ||
          !data.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
        )
          throw new Error("format");
        const bytes = Uint8Array.from(data);
        data.fill(0);
        try {
          return await createKeyPairSignerFromBytes(bytes);
        } finally {
          bytes.fill(0);
        }
      } catch {
        throw new DemoError(
          503,
          "funding_unavailable",
          "Test funding is not available. The demo funding wallet needs configuration.",
        );
      }
    })().catch((e) => {
      signerPromise = undefined;
      throw e;
    });
    return signerPromise;
  }
  async function balances(wallet) {
    await devnet();
    const owner = walletAddress(wallet);
    const [ata] = await findAssociatedTokenPda({
      owner,
      mint: DEVNET_USDC,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [sol, account] = await Promise.all([
      rpc.getBalance(owner, { commitment: "confirmed" }).send(),
      rpc
        .getAccountInfo(ata, { commitment: "confirmed", encoding: "base64" })
        .send(),
    ]);
    const token = account.value
      ? await rpc
          .getTokenAccountBalance(ata, { commitment: "confirmed" })
          .send()
      : null;
    if (
      account.value &&
      (account.value.owner !== TOKEN_PROGRAM_ADDRESS ||
        token?.value.decimals !== 6)
    )
      throw new Error("Unexpected token account");
    return {
      solLamports: sol.value,
      usdcUnits: token ? BigInt(token.value.amount) : 0n,
    };
  }
  async function status() {
    const bank = await signer();
    const [funds, rent] = await Promise.all([
      balances(bank.address),
      rpc.getMinimumBalanceForRentExemption(165n).send(),
    ]);
    return {
      available: true,
      ready:
        funds.usdcUnits >= PAYOUT.usdcUnits &&
        funds.solLamports >= PAYOUT.solLamports + rent + 10_000_000n,
      sourceAddress: bank.address,
      usdc: PAYOUT.usdc,
      sol: PAYOUT.sol,
      network: "solana-devnet",
    };
  }
  async function prepare(wallet) {
    await devnet();
    const bank = await signer();
    const recipient = walletAddress(wallet);
    if (recipient === bank.address)
      throw new DemoError(
        400,
        "source_wallet",
        "Use a different wallet for the demo.",
      );
    if (!(await status()).ready)
      throw new DemoError(
        503,
        "funding_empty",
        "The test funding wallet needs more funds. Try again later.",
      );
    const [source] = await findAssociatedTokenPda({
      owner: bank.address,
      mint: DEVNET_USDC,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destination] = await findAssociatedTokenPda({
      owner: recipient,
      mint: DEVNET_USDC,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const create = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: bank,
      owner: recipient,
      mint: DEVNET_USDC,
    });
    const transfer = getTransferCheckedInstruction({
      source,
      destination,
      mint: DEVNET_USDC,
      authority: bank,
      amount: PAYOUT.usdcUnits,
      decimals: 6,
    });
    const sol = getTransferSolInstruction({
      source: bank,
      destination: recipient,
      amount: PAYOUT.solLamports,
    });
    const { value: blockhash } = await rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(bank, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([create, transfer, sol], m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(tx);
    const simulated = await rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: true,
      })
      .send();
    if (simulated.value.err)
      throw new DemoError(
        503,
        "funding_simulation",
        "Test funding could not be prepared. No funds were sent.",
      );
    return {
      wire,
      signature: getSignatureFromTransaction(tx),
      lastValidBlockHeight: String(blockhash.lastValidBlockHeight),
    };
  }
  async function send(payout) {
    await devnet();
    await rpc
      .sendTransaction(payout.wire, {
        encoding: "base64",
        preflightCommitment: "confirmed",
        skipPreflight: false,
      })
      .send();
  }
  async function inspect(payout) {
    await devnet();
    const { value } = await rpc
      .getSignatureStatuses([payout.signature], {
        searchTransactionHistory: true,
      })
      .send();
    if (value[0]?.err) return "failed";
    if (["confirmed", "finalized"].includes(value[0]?.confirmationStatus))
      return "confirmed";
    // Do not replace an uncertain transfer. Wait until its blockhash is past finality.
    if (
      !value[0] &&
      (await rpc.getBlockHeight({ commitment: "finalized" }).send()) >
        BigInt(payout.lastValidBlockHeight)
    )
      return "failed";
    return "pending";
  }
  return { status, balances, prepare, send, inspect };
}
