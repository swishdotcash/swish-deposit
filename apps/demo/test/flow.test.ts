import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type Challenge,
  type DepositApi,
  type SetupStep,
} from "core/api";
import { PasskeyDismissed } from "core/passkey";
import { WalletRejected } from "core/wallet";
import {
  DepositFlow,
  REFRESH_EVERY_MS,
  type Remembered,
  type Screen,
} from "../src/widget/flow";
const wallet = "CG1gKGxUuRHKAnYiTzVbf6aWkFJUyBtCqy5MSFLoHhFk";
const step: SetupStep = {
  done: false,
  step: "authorize",
  transaction: "AA==",
  token: "token",
};
const flows: DepositFlow[] = [];
afterEach(() => {
  flows.splice(0).forEach((f) => f.dispose());
  vi.useRealTimers();
});
function world(known = false, beforeSetup = vi.fn(async () => {})) {
  let saved: Remembered | null = known
    ? { credentialId: "cred", wallet }
    : null;
  const challenge: Challenge = {
    challenge: "challenge",
    amount: "5",
    token: "USDC",
    rp_id: "localhost",
    expires_at: new Date(Date.now() + 90000).toISOString(),
    app: { name: "Meridian", website: "https://demo.example" },
  };
  const api = {
    challenge: vi.fn(async () => challenge),
    allowance: vi.fn(async () => ({
      balance: "10",
      left: "1000",
      limit: "1000",
    })),
    registerPasskey: vi.fn(async () => {}),
    prepareWallet: vi.fn(async (): Promise<SetupStep> => ({ done: true })),
    addToLimit: vi.fn(async (): Promise<SetupStep> => ({ done: true })),
    submitWalletTransaction: vi.fn(async () => {}),
    unlinkWallet: vi.fn(),
    sources: vi.fn(async () => [
      { wallet, balance: "10", left: "1000", enough: true },
    ]),
    submit: vi.fn(async () => ({
      id: "deposit",
      status: "succeeded" as const,
      wallet,
      amount: "5",
      token: "USDC",
      destination: wallet,
      signature: "sig",
      reference: null,
      error: null,
    })),
  } satisfies DepositApi;
  const passkeys = {
    create: vi.fn(async () => ({ credentialId: "cred", publicKey: "spki" })),
    approve: vi.fn(async () => ({
      credentialId: "cred",
      signature: "signature",
      authenticatorData: "auth",
      clientDataJson: "client",
    })),
  };
  const sign = vi.fn(async (bytes: Uint8Array) => bytes);
  const wallets = {
    list: () => [{ name: "Demo Wallet", icon: "data:," }],
    connect: vi.fn(async () => ({
      name: "Demo Wallet",
      address: wallet,
      sign,
    })),
  };
  const memory = {
    load: () => saved,
    save: (v: Remembered) => {
      saved = v;
    },
    clear: () => {
      saved = null;
    },
  };
  const flow = new DepositFlow(
    { id: "deposit", clientSecret: "secret" },
    { api, passkeys, wallets, memory, beforeSetup },
  );
  flows.push(flow);
  const seen: Screen[] = [];
  flow.onChange((s) => seen.push(s));
  return { flow, api, passkeys, sign, wallets, memory, beforeSetup, seen };
}
async function setup(w: ReturnType<typeof world>) {
  await w.flow.start();
  w.flow.setUp();
  await w.flow.pickWallet("Demo Wallet");
  await w.flow.chooseLimit("1000");
}
describe("embedded demo flow", () => {
  it("links a new wallet through both signatures, then deposits with a passkey", async () => {
    const w = world();
    w.api.prepareWallet
      .mockResolvedValueOnce(step)
      .mockResolvedValueOnce({ ...step, step: "allow" })
      .mockResolvedValueOnce({ done: true });
    await setup(w);
    await w.flow.createPasskey();
    expect(w.beforeSetup).toHaveBeenCalledTimes(1);
    expect(w.sign).toHaveBeenCalledTimes(2);
    expect(
      w.seen.filter((s) => s.name === "signing" && s.phase === "confirming"),
    ).toHaveLength(2);
    expect(w.flow.screen).toEqual({ name: "ready", purpose: "setup" });
    await w.flow.approve();
    expect(w.flow.screen.name).toBe("succeeded");
    expect(w.passkeys.approve).toHaveBeenCalledTimes(1);
  });
  it("keeps the passkey when a wallet signature is cancelled", async () => {
    const w = world();
    w.api.prepareWallet
      .mockResolvedValueOnce(step)
      .mockResolvedValueOnce(step)
      .mockResolvedValueOnce({ done: true });
    w.sign.mockRejectedValueOnce(new WalletRejected("Cancelled"));
    await setup(w);
    await w.flow.createPasskey();
    expect(w.flow.screen).toMatchObject({
      name: "setup_retry",
      reason: "wallet",
    });
    w.flow.retry();
    await expect.poll(() => w.flow.screen.name).toBe("ready");
    expect(w.passkeys.create).toHaveBeenCalledTimes(1);
    expect(w.api.registerPasskey).toHaveBeenCalledTimes(1);
  });
  it("keeps the passkey through low funds and uncertain confirmation", async () => {
    const w = world();
    w.api.prepareWallet.mockRejectedValueOnce(
      new ApiError(402, "not_enough_usdc", "low"),
    );
    await setup(w);
    await w.flow.createPasskey();
    expect(w.flow.screen).toMatchObject({
      name: "setup_retry",
      reason: "funds",
    });
    w.api.prepareWallet.mockResolvedValueOnce(step);
    w.api.submitWalletTransaction.mockRejectedValueOnce(
      new Error("lost reply"),
    );
    w.flow.retry();
    await expect
      .poll(() => w.flow.screen)
      .toMatchObject({ name: "setup_retry", reason: "confirmation" });
    w.flow.retry();
    await expect.poll(() => w.flow.screen.name).toBe("ready");
    expect(w.passkeys.create).toHaveBeenCalledTimes(1);
  });
  it("stays at the passkey step when its prompt is cancelled", async () => {
    const w = world();
    w.passkeys.create.mockRejectedValueOnce(new PasskeyDismissed());
    await setup(w);
    await w.flow.createPasskey();
    expect(w.flow.screen.name).toBe("passkey");
    expect(w.api.prepareWallet).not.toHaveBeenCalled();
  });
  it("uses no wallet connection for a returning user", async () => {
    const w = world(true);
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen.name).toBe("succeeded");
    expect(w.wallets.connect).not.toHaveBeenCalled();
    expect(w.passkeys.approve).toHaveBeenCalledTimes(1);
  });
  it("finds a wallet on another device before a separate deposit approval", async () => {
    const w = world();
    await w.flow.start();
    await w.flow.verify();
    expect(w.flow.screen.name).toBe("source");
    expect(w.api.submit).not.toHaveBeenCalled();
    await w.flow.payFrom();
    expect(w.flow.screen.name).toBe("succeeded");
    expect(w.passkeys.approve).toHaveBeenCalledTimes(2);
    expect(w.wallets.connect).not.toHaveBeenCalled();
  });
  it("does not submit after a cancelled deposit prompt", async () => {
    const w = world(true);
    w.passkeys.approve.mockRejectedValueOnce(new PasskeyDismissed());
    await w.flow.start();
    await w.flow.approve();
    expect(w.flow.screen).toMatchObject({ name: "confirm", cancelled: true });
    expect(w.api.submit).not.toHaveBeenCalled();
  });
  it("does not sign after the screen closes during funding", async () => {
    let release!: () => void;
    const w = world(
      false,
      vi.fn(
        () =>
          new Promise<void>((r) => {
            release = r;
          }),
      ),
    );
    await setup(w);
    const creation = w.flow.createPasskey();
    await expect.poll(() => !!release).toBe(true);
    w.flow.dispose();
    release();
    await creation;
    expect(w.api.prepareWallet).not.toHaveBeenCalled();
    expect(w.sign).not.toHaveBeenCalled();
  });
  it("does not send a wallet signature after the screen closes", async () => {
    const w = world();
    let release!: (bytes: Uint8Array) => void;
    w.api.prepareWallet.mockResolvedValueOnce(step);
    w.sign.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    await setup(w);
    const creation = w.flow.createPasskey();
    await expect.poll(() => !!release).toBe(true);
    w.flow.dispose();
    release(new Uint8Array([0]));
    await creation;
    expect(w.api.submitWalletTransaction).not.toHaveBeenCalled();
  });
  it("waits for a pending challenge and stops refresh before sharing", async () => {
    vi.useFakeTimers();
    const w = world(true);
    await w.flow.start();
    let release!: (c: Challenge) => void;
    const current = w.flow.details!;
    w.api.challenge.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS);
    let paused = false;
    const stop = w.flow.suspend().then(() => {
      paused = true;
    });
    await Promise.resolve();
    expect(paused).toBe(false);
    release(current);
    await stop;
    await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS * 3);
    expect(w.api.challenge).toHaveBeenCalledTimes(2);
  });
});

it("updates the source choices after test funds arrive", async () => {
  const w = world();
  w.api.sources.mockResolvedValueOnce([
    { wallet, balance: "0", left: "1000", enough: false },
  ]);
  await w.flow.start();
  await w.flow.verify();
  expect(w.flow.screen).toMatchObject({ name: "source", selected: null });
  await w.flow.refreshSource();
  expect(w.flow.screen).toMatchObject({
    name: "source",
    selected: wallet,
    wallets: [{ wallet, balance: "10", enough: true }],
  });
});

it("does not send a known wallet with a different passkey", async () => {
  const w = world(true);
  w.passkeys.approve.mockResolvedValueOnce({
    credentialId: "older-passkey",
    signature: "sig",
    authenticatorData: "auth",
    clientDataJson: "client",
  });
  await w.flow.start();
  await w.flow.approve();
  expect(w.api.submit).not.toHaveBeenCalled();
  expect(w.flow.screen).toMatchObject({
    name: "confirm",
    note: expect.stringContaining("same passkey"),
  });
  expect(w.memory.load()?.credentialId).toBe("cred");
});

it("requests the linked credential for a known wallet's deposit", async () => {
  const w = world(true);
  await w.flow.start();
  await w.flow.approve();
  expect(w.passkeys.approve).toHaveBeenCalledWith(
    "challenge",
    "localhost",
    "cred",
  );
});

it("does not send a funded wallet to limit setup after a source lookup fails", async () => {
  const w = world(true);
  w.api.submit.mockRejectedValueOnce(
    new ApiError(402, "no_funds", "No source found"),
  );
  await w.flow.start();
  await w.flow.approve();
  expect(w.flow.screen).toMatchObject({
    name: "confirm",
    note: expect.stringContaining("funds and a spending limit"),
  });
  expect(w.flow.source).toMatchObject({ balance: "10", left: "1000" });
  expect(w.wallets.connect).not.toHaveBeenCalled();
});
it("goes back one step at a time through setup, and not past something already signed", async () => {
  const w = world();
  await w.flow.start();
  expect(w.flow.canGoBack).toBe(false);
  w.flow.setUp();
  expect(w.flow.screen.name).toBe("wallets");
  expect(w.flow.canGoBack).toBe(true);
  await w.flow.pickWallet("Demo Wallet");
  expect(w.flow.screen.name).toBe("limit");
  await w.flow.chooseLimit("1000");
  expect(w.flow.screen.name).toBe("passkey");

  w.flow.back();
  expect(w.flow.screen.name).toBe("limit");
  w.flow.back();
  expect(w.flow.screen.name).toBe("wallets");
  w.flow.back();
  expect(w.flow.screen.name).toBe("confirm");
  expect(w.flow.canGoBack).toBe(false);
  w.flow.back();
  expect(w.flow.screen.name).toBe("confirm");

  // Forward again works from where "back" left off.
  w.flow.setUp();
  await w.flow.pickWallet("Demo Wallet");
  await w.flow.chooseLimit("1000");
  await w.flow.createPasskey();
  expect(w.flow.screen.name).toBe("ready");
  expect(w.flow.canGoBack).toBe(false);
  expect(w.api.registerPasskey).toHaveBeenCalledTimes(1);
});
