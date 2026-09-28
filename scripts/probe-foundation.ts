/**
 * Probe: the Solana Foundation Subscriptions & Allowances program, end to end,
 * with nothing of ours on chain yet.
 *
 *   sponsor   pays every fee and every rent (Swish, in production)
 *   user      owns the tokens; signs setup once (init authority + allowance)
 *   delegatee the only key allowed to pull (our program's PDA, in production)
 *   app       where a deposit lands
 *
 * Proves: setup with NO expiry, a pull the user does not sign, the allowance
 * going down, and a pull above what is left being refused.
 *
 * Devnet only: it mints its own throwaway token, so no real money moves.
 *   npm run probe:foundation
 */
import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token";
import {
  fetchFixedDelegation,
  fetchSubscriptionAuthority,
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
  getCreateFixedDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getTransferFixedOverlayInstructionAsync,
} from "@solana/subscriptions";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
// A local validator serves websockets one port up (8899 → 8900).
const WS_URL = RPC_URL.replace(/^http/, "ws").replace(/:8899\b/, ":8900");
if (!RPC_URL.includes("devnet") && !RPC_URL.includes("127.0.0.1")) {
  throw new Error("probe-foundation mints its own token and is devnet/local only");
}

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

const DECIMALS = 6;
const units = (n: number) => BigInt(Math.round(n * 10 ** DECIMALS));

async function send(label: string, feePayer: TransactionSigner, ixs: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  const sig = getSignatureFromTransaction(signed);
  console.log(`  ✓ ${label}  ${sig}`);
  return sig;
}

async function balance(ata: Parameters<typeof fetchToken>[1]) {
  return (await fetchToken(rpc, ata)).data.amount;
}

async function main() {
  const [sponsor, user, delegatee, app, mint] = await Promise.all(
    Array.from({ length: 5 }, () => generateKeyPairSigner()),
  );
  console.log("sponsor  ", sponsor.address);
  console.log("user     ", user.address);
  console.log("delegatee", delegatee.address);
  console.log("app      ", app.address);
  console.log("mint     ", mint.address);

  console.log("\n1. fund the sponsor (airdrop)");
  const airdropSig = await rpc.requestAirdrop(sponsor.address, lamports(1_000_000_000n)).send();
  for (let i = 0; i < 30; i++) {
    const { value } = await rpc.getSignatureStatuses([airdropSig]).send();
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("  ✓ 1 SOL");

  console.log("\n2. test token + 100 to the user");
  const [userAta] = await findAssociatedTokenPda({ owner: user.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [appAta] = await findAssociatedTokenPda({ owner: app.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const mintSpace = BigInt(getMintSize());
  const mintRent = await rpc.getMinimumBalanceForRentExemption(mintSpace).send();
  await send("mint + both token accounts + mint 100", sponsor, [
    getCreateAccountInstruction({ payer: sponsor, newAccount: mint, lamports: mintRent, space: mintSpace, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: sponsor.address }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: sponsor, owner: user.address, mint: mint.address }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: sponsor, owner: app.address, mint: mint.address }),
    getMintToInstruction({ mint: mint.address, token: userAta, mintAuthority: sponsor, amount: units(100) }),
  ]);

  console.log("\n3. user setup: authority for this token + a 50-unit allowance, NO expiry");
  await send("init subscription authority (the one SPL approve)", sponsor, [
    await getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner: user,
      payer: sponsor,
      tokenMint: mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      userAta,
    }),
  ]);
  const [authorityPda] = await findSubscriptionAuthorityPda({ user: user.address, tokenMint: mint.address });
  const authority = await fetchSubscriptionAuthority(rpc, authorityPda);
  const userToken = await fetchToken(rpc, userAta);
  console.log(`  token account delegate = ${userToken.data.delegate.__option === "Some" ? userToken.data.delegate.value : "none"} (authority PDA ${authorityPda})`);
  console.log(`  delegated amount       = ${userToken.data.delegatedAmount}`);

  const nonce = 0n;
  await send("create fixed delegation, expiryTs = 0", sponsor, [
    await getCreateFixedDelegationOverlayInstructionAsync({
      delegator: user,
      payer: sponsor,
      delegatee: delegatee.address,
      tokenMint: mint.address,
      amount: units(50),
      expiryTs: 0n,
      nonce,
      expectedSubscriptionAuthorityInitId: authority.data.initId,
    }),
  ]);
  const [delegationPda] = await findFixedDelegationPda({
    subscriptionAuthority: authorityPda,
    delegator: user.address,
    delegatee: delegatee.address,
    nonce,
  });

  const pull = async (amount: bigint) =>
    getTransferFixedOverlayInstructionAsync({
      amount,
      delegatee,
      delegationPda,
      delegator: user.address,
      delegatorAta: userAta,
      receiverAta: appAta,
      tokenMint: mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

  console.log("\n4. deposit: the delegatee pulls 20 → app. The user signs nothing.");
  await send("transfer fixed 20", sponsor, [await pull(units(20))]);
  const left = (await fetchFixedDelegation(rpc, delegationPda)).data.amount;
  console.log(`  user ${await balance(userAta)} · app ${await balance(appAta)} · allowance left ${left}`);

  console.log("\n5. over the limit: pull 40 with 30 left must FAIL");
  try {
    await send("transfer fixed 40", sponsor, [await pull(units(40))]);
    console.log("  ✗ UNEXPECTED: over-limit pull succeeded");
    process.exitCode = 1;
  } catch (e) {
    console.log(`  ✓ refused (${(e as Error).message.split("\n")[0].slice(0, 120)})`);
  }

  console.log("\n6. a stranger key cannot pull");
  const stranger = await generateKeyPairSigner();
  try {
    await send("stranger pulls 1", sponsor, [
      await getTransferFixedOverlayInstructionAsync({
        amount: units(1), delegatee: stranger, delegationPda, delegator: user.address,
        delegatorAta: userAta, receiverAta: appAta, tokenMint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    console.log("  ✗ UNEXPECTED: stranger pull succeeded");
    process.exitCode = 1;
  } catch (e) {
    console.log(`  ✓ refused (${(e as Error).message.split("\n")[0].slice(0, 120)})`);
  }

  console.log(`\nfinal: user ${await balance(userAta)} · app ${await balance(appAta)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
