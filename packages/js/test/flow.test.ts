import { describe, expect, it } from "vitest";

import {
  ApiError,
  type Approval,
  type Challenge,
  type DepositApi,
  type DepositResult,
  type SetupStep,
  type WalletChoice,
} from "../src/api.js";
import { money, unlockName } from "../src/format.js";
import { fromBase64, fromBase64Url, toBase64, toBase64Url } from "../src/encoding.js";
import { DepositFlow, limitChoices, type Screen } from "../src/flow.js";
import { PasskeyDismissed, PasskeyUnsupported, type Passkeys } from "../src/passkey.js";
import { WalletRejected, type Wallets } from "../src/wallet.js";

const DEPOSIT = { id: "d1", clientSecret: "swishcs_x" };
const WALLET = "CG1gKGxUuRHKAnYiTzVbf6aWkFJUyBtCqy5MSFLoHhFk";
const OTHER_WALLET = "9GeTUgtsXahBnXBYgVbx31yUpbnKuda6ySrjnv3aEDAh";
const NOW = 1_800_000_000_000;
/** This browser has seen the user deposit before. */
const KNOWN = { credentialId: "cred-1", wallet: WALLET };
const choice = (wallet: string, balance: string, left: string, enough: boolean): WalletChoice => ({ wallet, balance, left, enough });

const result = (status: DepositResult["status"], wallet?: string): DepositResult => ({
  ...(wallet ? { wallet } : {}),
  id: "d1",
  status,
  amount: "12.5",
  token: "USDC",
  destination: WALLET,
  reference: null,
  signature: status === "succeeded" ? "sig" : null,
  error: null,
});

const tx = (label: string) => toBase64(new TextEncoder().encode(label));

/** A fake of everything outside the flow; tests script it and read `calls`. */
function world(opts: { sourceWaitMs?: number; allowanceDelayMs?: number } = {}) {
  const calls: string[] = [];
  let challenges = 0;
  const script = {
    /** Each submit takes the next entry: a result or an error to throw. */
    submits: [] as (DepositResult | ApiError)[],
    sources: [] as (WalletChoice[] | ApiError)[],
    prepares: [] as (SetupStep | ApiError)[],
    limits: [] as (SetupStep | ApiError)[],
    left: "0",
    balance: "1000",
    remembered: null as { credentialId: string; wallet: string } | null,
    approve: [] as (Approval | Error)[],
    create: [] as ({ credentialId: string; publicKey: string } | Error)[],
    connect: [] as (true | Error)[],
    sign: [] as (true | Error)[],
    challengeLife: 90_000,
    walletNames: ["Phantom"],
  };
  const next = <T>(queue: T[], what: string): Exclude<T, Error> => {
    const item = queue.shift();
    if (item === undefined) throw new Error(`unexpected ${what}`);
    if (item instanceof Error) throw item;
    return item as Exclude<T, Error>;
  };

  const api: DepositApi = {
    async challenge() {
      challenges++;
      calls.push("challenge");
      const c: Challenge = {
        challenge: `challenge-${challenges}`,
        rp_id: "localhost",
        expires_at: new Date(NOW + script.challengeLife).toISOString(),
        amount: "12.5",
        token: "USDC",
        app: { name: "Arena", website: "https://arena.example" },
      };
      return c;
    },
    async sources(_d, approval) {
      calls.push(`sources:${approval.credentialId}`);
      return next(script.sources, "sources");
    },
    async submit(_d, approval, wallet) {
      calls.push(`submit:${approval.credentialId}:${approval.signature}${wallet ? `:${wallet}` : ""}`);
      return next(script.submits, "submit");
    },
    async registerPasskey(credentialId) {
      calls.push(`register:${credentialId}`);
    },
    async prepareWallet(_d, credentialId, wallet, allowance) {
      calls.push(`prepare:${credentialId}:${wallet}:${allowance}`);
      return next(script.prepares, "prepare");
    },
    async addToLimit(_d, credentialId, wallet, add) {
      calls.push(`limit:${credentialId}:${wallet}:${add}`);
      return next(script.limits, "limit");
    },
    async allowance() {
      calls.push("allowance");
      if (opts.allowanceDelayMs) await new Promise((r) => setTimeout(r, opts.allowanceDelayMs));
      return { left: script.left, balance: script.balance };
    },
    async unlinkWallet() {
      throw new Error("not in these tests");
    },
    async submitWalletTransaction(transaction, token) {
      calls.push(`send:${new TextDecoder().decode(fromBase64(transaction))}:${token}`);
    },
  };

  const passkeys: Passkeys = {
    async approve(challenge) {
      calls.push(`faceid:${challenge}`);
      const a = next(script.approve, "Face ID");
      return { ...a, signature: `signed(${challenge})` };
    },
    async create() {
      calls.push("create-passkey");
      return next(script.create, "passkey creation");
    },
  };

  const wallets: Wallets = {
    list: () => script.walletNames.map((name) => ({ name, icon: "data:," })),
    async connect(name) {
      calls.push(`connect:${name}`);
      next(script.connect, "connect");
      return {
        name,
        address: WALLET,
        async sign(transaction) {
          next(script.sign, "wallet signature");
          return new TextEncoder().encode(`${new TextDecoder().decode(transaction)}+signed`);
        },
      };
    },
  };

  const memory = {
    load: () => script.remembered,
    save: (r: { credentialId: string; wallet: string }) => void (script.remembered = r),
    clear: () => void (script.remembered = null),
  };
  const flow = new DepositFlow(DEPOSIT, { api, passkeys, wallets, memory, now: () => NOW, sourceWaitMs: opts.sourceWaitMs });
  const seen: Screen["name"][] = [];
  flow.onChange((s) => seen.push(s.name));
  return { flow, calls, script, seen };
}

const approval = (credentialId = "cred-1"): Approval => ({
  credentialId,
  authenticatorData: "auth",
  clientDataJson: "client",
  signature: "",
});

describe("a user this browser knows", () => {
  it("sees their wallet on open and deposits with one Face ID", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.left = "98";
    w.script.balance = "18";
    w.script.approve.push(approval());
    w.script.submits.push(result("succeeded"));
    await w.flow.start();
    // The drawer opens already knowing the wallet's numbers: one screen, no swap.
    expect(w.flow.screen).toEqual({ name: "confirm" });
    expect(w.flow.details?.app.name).toBe("Arena");
    expect(w.flow.knownWallet).toBe(WALLET);
    expect(w.flow.source).toEqual({ wallet: WALLET, left: "98", balance: "18" });
    expect(w.flow.sourcePending).toBe(false);
    expect(w.seen).toEqual(["confirm"]);

    await w.flow.approve();
    expect(w.flow.screen).toEqual({ name: "succeeded", result: result("succeeded") });
    // The challenge fetched on open is the one signed: nothing awaited before
    // Face ID. The deposit comes from the wallet the first screen showed.
    expect(w.calls).toEqual(["challenge", "allowance", "faceid:challenge-1", `submit:cred-1:signed(challenge-1):${WALLET}`]);
    expect(w.seen).toEqual(["confirm", "approving", "sending", "succeeded"]);
    w.flow.dispose();
  });

  it("opens without the numbers when the chain is slow, and fills them in when they arrive", async () => {
    const w = world({ sourceWaitMs: 20, allowanceDelayMs: 80 });
    w.script.remembered = KNOWN;
    w.script.left = "1";
    await w.flow.start();
    expect(w.flow.screen).toEqual({ name: "confirm" });
    // Still reading: the drawer keeps its button inactive rather than guess.
    expect(w.flow.sourcePending).toBe(true);
    expect(w.flow.source).toBeNull();
    await expect.poll(() => w.flow.source).toMatchObject({ left: "1" });
    expect(w.flow.sourcePending).toBe(false);
    expect(w.seen).toEqual(["confirm", "confirm"]);
    w.flow.dispose();
  });

  it("asks for a new challenge when the cached one is about to expire", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.challengeLife = 20_000;
    w.script.approve.push(approval());
    w.script.submits.push(result("succeeded"));
    await w.flow.start();
    await w.flow.approve();
    expect(w.calls.slice(0, 4)).toEqual(["challenge", "allowance", "challenge", "faceid:challenge-2"]);
    w.flow.dispose();
  });

  it("treats a closed Face ID sheet as a cancel, not as a missing passkey", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.approve.push(new PasskeyDismissed(), approval());
    w.script.submits.push(result("succeeded", WALLET));
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toEqual({ name: "confirm", cancelled: true });
    // The same challenge is still good for the second try.
    await w.flow.approve();
    expect(w.flow.screen.name).toBe("succeeded");
    expect(w.calls.filter((c) => c.startsWith("faceid"))).toEqual(["faceid:challenge-1", "faceid:challenge-1"]);
    w.flow.dispose();
  });

  it("is told when the transaction failed, with no retry on a finished deposit", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.approve.push(approval());
    w.script.submits.push(result("failed"));
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toMatchObject({ name: "failed", retry: false });
    w.flow.dispose();
  });

  it("can try again after an approval that expired", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.approve.push(approval(), approval());
    w.script.submits.push(new ApiError(409, "expired", "the approval expired"), result("succeeded"));
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen.name).toBe("confirm");
    await w.flow.approve();
    expect(w.flow.screen.name).toBe("succeeded");
    // The second Face ID signs a new challenge, not the expired one.
    expect(w.calls.filter((c) => c.startsWith("faceid"))).toEqual(["faceid:challenge-1", "faceid:challenge-2"]);
    w.flow.dispose();
  });

  it("stops on a deposit that is already finished", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.approve.push(approval());
    w.script.submits.push(new ApiError(409, "not_open", "this deposit is succeeded"));
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toEqual({ name: "failed", message: "This deposit is already finished.", retry: false });
    w.flow.dispose();
  });

  it("can pick another wallet: Face ID to list them, Face ID to pay", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.approve.push(approval(), approval());
    w.script.sources.push([choice(WALLET, "16", "6", true), choice(OTHER_WALLET, "250", "94", true)]);
    w.script.submits.push(result("succeeded", OTHER_WALLET));
    await w.flow.start();
    await w.flow.verify();
    // The wallet used last time is preselected.
    expect(w.flow.screen).toMatchObject({ name: "source", selected: WALLET });
    w.flow.selectWallet(OTHER_WALLET);
    await w.flow.payFrom();
    expect(w.calls).toContain(`submit:cred-1:signed(challenge-2):${OTHER_WALLET}`);
    expect(w.script.remembered).toEqual({ credentialId: "cred-1", wallet: OTHER_WALLET });
    w.flow.dispose();
  });

  it("adds a second wallet under the same passkey: no new passkey is made", async () => {
    const w = world();
    const first = { credentialId: "cred-1", wallet: OTHER_WALLET };
    w.script.remembered = first;
    w.script.connect.push(true);
    w.script.prepares.push({ done: false, step: "allow", transaction: tx("allow"), token: "t1" }, { done: true });
    w.script.sign.push(true);
    await w.flow.start();
    w.flow.addWallet();
    expect(w.flow.screen).toMatchObject({ name: "wallets", purpose: "setup" });
    // Still known to this browser while the new wallet is being linked.
    expect(w.script.remembered).toEqual(first);
    await w.flow.pickWallet("Phantom");
    await w.flow.chooseLimit("100");
    expect(w.flow.screen).toEqual({ name: "ready", purpose: "setup", added: true });
    // The wallet just added is the one this browser opens with next.
    expect(w.script.remembered).toEqual({ credentialId: "cred-1", wallet: WALLET });
    expect(w.calls).toContain(`prepare:cred-1:${WALLET}:100`);
    expect(w.calls).not.toContain("create-passkey");
    expect(w.calls.filter((c) => c.startsWith("register"))).toEqual([]);
    w.flow.dispose();
  });

  it("says so when the wallet connects the account that is already linked", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.connect.push(true);
    await w.flow.start();
    w.flow.addWallet();
    await w.flow.pickWallet("Phantom");
    expect(w.flow.screen).toMatchObject({ name: "wallets", purpose: "setup" });
    expect((w.flow.screen as { note?: string }).note).toContain("Switch to another account in Phantom");
    expect(w.calls.filter((c) => c.startsWith("prepare"))).toEqual([]);
    w.flow.dispose();
  });

  it("will not add to the limit of a wallet that is not theirs on Swish", async () => {
    const w = world();
    // This browser knows them by another wallet than the one the wallet app is on.
    w.script.remembered = { credentialId: "cred-1", wallet: OTHER_WALLET };
    w.script.left = "0";
    w.script.connect.push(true);
    await w.flow.start();
    w.flow.addToLimit();
    await w.flow.pickWallet("Phantom");
    expect(w.flow.screen).toMatchObject({ name: "wallets", purpose: "raise" });
    expect((w.flow.screen as { note?: string }).note).toBe(
      "Phantom is on CG1g…HhFk, which is not linked to your Swish ID. Switch to 9GeT…EDAh in Phantom, then choose it again.",
    );
    // Nothing was prepared for the stray wallet: no limit change, no link.
    expect(w.calls.filter((c) => c.startsWith("limit") || c.startsWith("prepare"))).toEqual([]);
    w.flow.dispose();
  });

  it("can add to the limit before any Face ID is spent", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.left = "1";
    w.script.connect.push(true);
    w.script.limits.push({ done: false, step: "limit", transaction: tx("limit"), token: "t9" });
    w.script.sign.push(true);
    await w.flow.start();
    w.flow.addToLimit();
    expect(w.flow.screen).toMatchObject({ name: "wallets", purpose: "raise" });
    await w.flow.pickWallet("Phantom");
    await w.flow.chooseLimit("100");
    expect(w.flow.screen).toEqual({ name: "ready", purpose: "raise" });
    expect(w.calls.filter((c) => c.startsWith("faceid"))).toEqual([]);
    expect(w.calls).toContain(`limit:cred-1:${WALLET}:100`);
    w.flow.dispose();
  });

  it("is offered the fix when the wallet turns out short at the last moment", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.approve.push(approval());
    w.script.submits.push(new ApiError(402, "no_funds", "That wallet does not have enough"));
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toMatchObject({ name: "wallets", purpose: "raise" });
    w.flow.dispose();
  });

  it("is forgotten when setup starts over", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    await w.flow.start();
    w.flow.setUp();
    expect(w.script.remembered).toBeNull();
    expect(w.flow.source).toBeNull();
    w.flow.dispose();
  });

  it("still opens when the balance read fails", async () => {
    const w = world();
    w.script.remembered = KNOWN;
    w.script.left = undefined as never;
    await w.flow.start();
    expect(w.flow.screen).toEqual({ name: "confirm" });
    w.flow.dispose();
  });
});

describe("a Swish user on a browser that does not know them", () => {
  it("verifies with Face ID, sees their wallets, then deposits with a second Face ID", async () => {
    const w = world();
    w.script.approve.push(approval(), approval());
    w.script.sources.push([choice(WALLET, "16", "6", true)]);
    w.script.submits.push(result("succeeded", WALLET));
    w.script.left = "4";
    await w.flow.start();
    expect(w.flow.source).toBeNull();

    await w.flow.approve();
    expect(w.flow.screen).toEqual({ name: "source", wallets: [choice(WALLET, "16", "6", true)], selected: WALLET });
    // The first Face ID only said who this is: nothing was sent.
    expect(w.calls).toEqual(["challenge", "faceid:challenge-1", "sources:cred-1", "challenge"]);

    await w.flow.payFrom();
    expect(w.flow.screen.name).toBe("succeeded");
    // The second Face ID signs a new challenge, and that approval pays.
    expect(w.calls.slice(4, 6)).toEqual(["faceid:challenge-2", `submit:cred-1:signed(challenge-2):${WALLET}`]);
    expect(w.seen).toEqual(["confirm", "approving", "sending", "source", "approving", "sending", "succeeded", "succeeded"]);
    // From now on this browser knows them.
    expect(w.script.remembered).toEqual({ credentialId: "cred-1", wallet: WALLET });
    expect(w.flow.source).toMatchObject({ wallet: WALLET, left: "4" });
    w.flow.dispose();
  });

  it("picks among several wallets, but not one that cannot pay", async () => {
    const w = world();
    w.script.approve.push(approval(), approval());
    const wallets = [choice(WALLET, "0.5", "50", false), choice(OTHER_WALLET, "250", "94", true)];
    w.script.sources.push(wallets);
    w.script.submits.push(result("succeeded", OTHER_WALLET));
    await w.flow.start();
    await w.flow.approve();
    // The first wallet that can pay is preselected.
    expect(w.flow.screen).toEqual({ name: "source", wallets, selected: OTHER_WALLET });
    w.flow.selectWallet(WALLET);
    expect(w.flow.screen).toMatchObject({ selected: OTHER_WALLET });
    await w.flow.payFrom();
    expect(w.calls).toContain(`submit:cred-1:signed(challenge-2):${OTHER_WALLET}`);
    w.flow.dispose();
  });

  it("stays on their wallets when the second Face ID is cancelled", async () => {
    const w = world();
    w.script.approve.push(approval(), new PasskeyDismissed());
    w.script.sources.push([choice(WALLET, "16", "6", true)]);
    await w.flow.start();
    await w.flow.approve();
    await w.flow.payFrom();
    expect(w.flow.screen).toMatchObject({ name: "source", selected: WALLET, cancelled: true });
    expect(w.calls.filter((c) => c.startsWith("submit"))).toEqual([]);
    w.flow.dispose();
  });

  it("says so when the browser has no passkeys at all", async () => {
    const w = world();
    w.script.approve.push(new PasskeyUnsupported("This browser does not support passkeys."));
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toEqual({ name: "failed", message: "This browser does not support passkeys.", retry: false });
    w.flow.dispose();
  });

  it("is told when a passkey on the device is unknown to Swish", async () => {
    const w = world();
    w.script.approve.push(approval("orphan"));
    w.script.sources.push(new ApiError(404, "no_swish_id", "No Swish passkey found."));
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toEqual({ name: "not_found", note: "That passkey is not set up with Swish yet." });
    w.flow.dispose();
  });
});

describe("a first-time user", () => {
  it("sets up once (wallet, limit, passkey, two wallet signatures) then deposits with one Face ID", async () => {
    const w = world();
    w.script.approve.push(new PasskeyDismissed(), approval("new-cred"));
    w.script.connect.push(true);
    w.script.create.push({ credentialId: "new-cred", publicKey: "spki" });
    w.script.prepares.push(
      { done: false, step: "authorize", transaction: tx("authorize"), token: "t1" },
      { done: false, step: "allow", transaction: tx("allow"), token: "t2" },
      { done: true },
    );
    w.script.sign.push(true, true);
    w.script.submits.push(result("succeeded"));

    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toEqual({ name: "not_found" });

    w.flow.setUp();
    expect(w.flow.screen).toMatchObject({ name: "wallets", purpose: "setup", wallets: [{ name: "Phantom" }] });
    await w.flow.pickWallet("Phantom");
    expect(w.flow.screen).toEqual({
      name: "limit",
      purpose: "setup",
      wallet: WALLET,
      balance: "1000",
      choices: ["100", "250", "500"],
      minimum: "12.5",
    });
    await w.flow.chooseLimit("250");
    expect(w.flow.screen).toEqual({ name: "passkey" });
    await w.flow.createPasskey();
    expect(w.flow.screen).toEqual({ name: "ready", purpose: "setup" });
    await w.flow.approve();
    expect(w.flow.screen.name).toBe("succeeded");

    expect(w.calls).toEqual([
      "challenge",
      "faceid:challenge-1",
      "connect:Phantom",
      // the wallet's balance, shown on the limit screen
      "allowance",
      "create-passkey",
      "register:new-cred",
      `prepare:new-cred:${WALLET}:250`,
      "send:authorize+signed:t1",
      `prepare:new-cred:${WALLET}:250`,
      "send:allow+signed:t2",
      `prepare:new-cred:${WALLET}:250`,
      // A new challenge after setup: the first one has aged. Setup told this
      // browser who they are, so their wallet is read and no verify is needed.
      "challenge",
      "allowance",
      "faceid:challenge-2",
      `submit:new-cred:signed(challenge-2):${WALLET}`,
    ]);
    expect(w.seen.filter((s) => s === "signing")).toHaveLength(2);
    w.flow.dispose();
  });

  it("is offered another wallet when this one holds too little", async () => {
    const w = world();
    w.script.approve.push(new PasskeyDismissed());
    w.script.connect.push(true);
    w.script.create.push({ credentialId: "new-cred", publicKey: "spki" });
    w.script.prepares.push(new ApiError(402, "not_enough_usdc", "This wallet holds less than the 12.5 USDC this deposit needs."));
    await w.flow.start();
    await w.flow.approve();
    w.flow.setUp();
    await w.flow.pickWallet("Phantom");
    await w.flow.chooseLimit("100");
    await w.flow.createPasskey();
    expect(w.flow.screen).toMatchObject({
      name: "wallets",
      note: "This wallet holds less than the 12.5 USDC this deposit needs.",
    });
    w.flow.dispose();
  });

  it("keeps the passkey when the wallet signature is refused, and retries only the wallet part", async () => {
    const w = world();
    w.script.approve.push(new PasskeyDismissed());
    w.script.connect.push(true);
    w.script.create.push({ credentialId: "new-cred", publicKey: "spki" });
    w.script.prepares.push(
      { done: false, step: "allow", transaction: tx("allow"), token: "t1" },
      { done: false, step: "allow", transaction: tx("allow"), token: "t1" },
      { done: true },
    );
    w.script.sign.push(new WalletRejected("You closed the wallet request."), true);
    await w.flow.start();
    await w.flow.approve();
    w.flow.setUp();
    await w.flow.pickWallet("Phantom");
    await w.flow.chooseLimit("100");
    await w.flow.createPasskey();
    expect(w.flow.screen).toEqual({ name: "failed", message: "You closed the wallet request.", retry: true });

    w.flow.retry();
    await expect.poll(() => w.flow.screen.name).toBe("ready");
    expect(w.calls.filter((c) => c === "create-passkey")).toHaveLength(1);
    w.flow.dispose();
  });

  it("goes back to the passkey step when its prompt is closed", async () => {
    const w = world();
    w.script.approve.push(new PasskeyDismissed());
    w.script.connect.push(true);
    w.script.create.push(new PasskeyDismissed());
    await w.flow.start();
    await w.flow.approve();
    w.flow.setUp();
    await w.flow.pickWallet("Phantom");
    await w.flow.chooseLimit("100");
    await w.flow.createPasskey();
    expect(w.flow.screen).toMatchObject({ name: "passkey", note: "The passkey was not created. If a password manager opened, save the passkey there or pick its option to use this device, then try again." });
    w.flow.dispose();
  });

  it("returns to the wallet list when the connection is refused", async () => {
    const w = world();
    w.script.approve.push(new PasskeyDismissed());
    w.script.connect.push(new WalletRejected("You closed the wallet request."));
    await w.flow.start();
    await w.flow.approve();
    w.flow.setUp();
    await w.flow.pickWallet("Phantom");
    expect(w.flow.screen).toMatchObject({ name: "wallets", note: "You closed the wallet request." });
    w.flow.dispose();
  });
});

describe("a limit that is too low", () => {
  it("adds to the limit with one wallet signature, then deposits", async () => {
    const w = world();
    w.script.approve.push(approval(), approval());
    w.script.sources.push([choice(WALLET, "16", "2.5", false)]);
    w.script.submits.push(result("succeeded", WALLET));
    w.script.left = "2.5";
    w.script.connect.push(true);
    w.script.limits.push({ done: false, step: "limit", transaction: tx("limit"), token: "t9", left_now: "2.5", new_limit: "102.5" });
    w.script.sign.push(true);

    await w.flow.start();
    await w.flow.approve();
    // The wallet is listed, and nothing can be sent from it yet.
    expect(w.flow.screen).toMatchObject({ name: "source", selected: null });
    await w.flow.payFrom();
    expect(w.flow.screen.name).toBe("source");

    w.flow.addToLimit();
    expect(w.flow.screen).toMatchObject({ name: "wallets", purpose: "raise" });
    await w.flow.pickWallet("Phantom");
    expect(w.flow.screen).toEqual({
      name: "limit",
      purpose: "raise",
      wallet: WALLET,
      balance: "1000",
      left: "2.5",
      choices: ["100", "250", "500"],
      minimum: "10",
    });
    await w.flow.chooseLimit("100");
    expect(w.flow.screen).toEqual({ name: "ready", purpose: "raise" });
    // The limit change told this browser who they are: one Face ID pays.
    await w.flow.approve();
    expect(w.flow.screen.name).toBe("succeeded");
    expect(w.calls).toContain(`limit:cred-1:${WALLET}:100`);
    expect(w.calls).toContain("send:limit+signed:t9");
    expect(w.calls.filter((c) => c.startsWith("submit"))).toHaveLength(1);
    w.flow.dispose();
  });

  it("says the wallet is short when the limit already covers the deposit", async () => {
    const w = world();
    w.script.approve.push(approval());
    w.script.sources.push([choice(WALLET, "1", "500", false)]);
    w.script.left = "500";
    w.script.connect.push(true);
    await w.flow.start();
    await w.flow.approve();
    w.flow.addToLimit();
    await w.flow.pickWallet("Phantom");
    expect(w.flow.screen).toMatchObject({ name: "failed", retry: false });
    expect((w.flow.screen as { message: string }).message).toContain("does not hold the 12.5 USDC");
    w.flow.dispose();
  });

  it("finishes the setup when the passkey has no wallet behind it yet", async () => {
    const w = world();
    w.script.approve.push(approval());
    w.script.sources.push([]);
    w.script.connect.push(true);
    w.script.limits.push(new ApiError(400, "not_set_up", "Set this wallet up with this Swish ID first."));
    w.script.prepares.push({ done: false, step: "allow", transaction: tx("allow"), token: "t1" }, { done: true });
    w.script.sign.push(true);
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toMatchObject({ name: "wallets", purpose: "raise" });
    await w.flow.pickWallet("Phantom");
    await w.flow.chooseLimit("100");
    expect(w.flow.screen).toEqual({ name: "ready", purpose: "raise" });
    expect(w.calls).toContain(`prepare:cred-1:${WALLET}:100`);
    w.flow.dispose();
  });
});

describe("small things", () => {
  it("offers limits that cover what is needed", () => {
    expect(limitChoices(12.5)).toEqual(["100", "250", "500"]);
    expect(limitChoices(300)).toEqual(["500", "1000", "2500"]);
    expect(limitChoices(20000.5)).toEqual(["20001"]);
  });

  it("shows money with at least two decimals", () => {
    expect(money("12.5")).toBe("12.50");
    expect(money("1000")).toBe("1,000.00");
    expect(money("0.123456")).toBe("0.123456");
  });

  it("names the unlock the way the device does", () => {
    expect(unlockName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140")).toBe("Touch ID");
    expect(unlockName("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)")).toBe("Face ID");
    expect(unlockName("Mozilla/5.0 (Linux; Android 16) Chrome/140")).toBe("your fingerprint or screen lock");
  });

  it("round-trips the API's encodings", () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255, 62, 63]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});
