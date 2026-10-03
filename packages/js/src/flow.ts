/**
 * What the widget does, without any drawing: one screen at a time, moved
 * along by the user's taps. The drawer renders `screen` and calls back in.
 *
 *   browser that knows the user: their wallet on open → Face ID → sent → succeeded
 *   any other browser: Face ID (who is this?) → pay from which wallet? → Face ID → sent
 *     no passkey found → set up once: wallet → limit → passkey → wallet signs → Face ID
 *     limit or balance too low → wallet → add to limit → wallet signs → Face ID
 */
import {
  ApiError,
  type Approval,
  type Challenge,
  type DepositApi,
  type DepositRef,
  type DepositResult,
  type SetupStep,
  type WalletChoice,
  type WalletStanding,
} from "./api.js";
import { fromBase64, toBase64 } from "./encoding.js";
import { PasskeyDismissed, PasskeyUnsupported, type Passkeys } from "./passkey.js";
import { WalletRejected, type ConnectedWallet, type WalletOption, type Wallets } from "./wallet.js";

export type Purpose = "setup" | "raise";

export type Screen =
  | { name: "loading" }
  /** `cancelled`: a known user closed the Face ID sheet. */
  | { name: "confirm"; note?: string; cancelled?: boolean }
  /** The Face ID sheet is up: to say who this is, or to make the deposit. */
  | { name: "approving"; purpose: "verify" | "pay" }
  /** The user is verified and sees their wallets. Nothing has moved. */
  | { name: "source"; wallets: WalletChoice[]; selected: string | null; cancelled?: boolean }
  /** Face ID is done; the API is answering: the wallets (verify) or the deposit itself (pay). */
  | { name: "sending"; purpose: "verify" | "pay" }
  /** Face ID was closed or found no Swish passkey: the browser does not say which. */
  | { name: "not_found"; note?: string }
  | { name: "wallets"; purpose: Purpose; wallets: WalletOption[]; note?: string }
  | { name: "connecting"; wallet: string }
  /** `balance`: what the wallet holds, when it could be read. */
  | { name: "limit"; purpose: Purpose; wallet: string; balance?: string; left?: string; choices: string[]; minimum: string }
  | { name: "passkey"; note?: string }
  | { name: "creating" }
  /** Waiting for the wallet to sign transaction `done + 1` of `total`. */
  | { name: "signing"; wallet: string; done: number; total: number }
  /** Setup or the limit change is finished: one Face ID left. */
  | { name: "ready"; purpose: Purpose; added?: boolean }
  | { name: "succeeded"; result: DepositResult }
  | { name: "failed"; message: string; retry: boolean };

/** Who used Swish in this browser last: lets the first screen show their wallet. */
export interface Remembered {
  credentialId: string;
  wallet: string;
}

export interface Memory {
  load(): Remembered | null;
  save(r: Remembered): void;
  clear(): void;
}

/** The wallet a deposit comes from, as far as this browser knows. */
export interface Source extends WalletStanding {
  wallet: string;
}

export interface FlowDeps {
  api: DepositApi;
  passkeys: Passkeys;
  wallets: Wallets;
  memory?: Memory;
  now?: () => number;
  /** How long a screen waits for the wallet's numbers before showing without them. */
  sourceWaitMs?: number;
}

/** Long enough for a healthy chain read, short enough that a slow one does not hold the drawer shut. */
const SOURCE_WAIT_MS = 1200;

/** An approval must still have this long to live when Face ID opens. */
const FRESH_FOR_MS = 30_000;
/** How often an idle screen asks for a new challenge (they live 90 s). */
export const REFRESH_EVERY_MS = 45_000;
const LIMIT_CHOICES = [100, 250, 500, 1000, 2500, 5000, 10000];
/** A first-time wallet signs twice; anything past this is a loop gone wrong. */
const MAX_SETUP_STEPS = 4;

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Limits to offer: the first few round numbers that cover `need`. */
export function limitChoices(need: number): string[] {
  const fit = LIMIT_CHOICES.filter((c) => c >= need).slice(0, 3);
  return (fit.length ? fit : [Math.ceil(need)]).map(String);
}

export class DepositFlow {
  private current: Screen = { name: "loading" };
  private listeners = new Set<(s: Screen) => void>();
  private challenge: Challenge | null = null;
  private loading: Promise<Challenge> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private credentialId: string | null = null;
  private wallet: ConnectedWallet | null = null;
  private purpose: Purpose = "setup";
  /** Setup: the wallet's limit. Raise: what to add to it. */
  private chosen: string | null = null;
  private again: (() => void) | null = null;
  private from: Source | null = null;
  private reading = false;
  /** The wallets linked to this Swish ID, once a verify has listed them. */
  private linked: string[] | null = null;
  /** Linking one more wallet to a Swish ID that already exists. */
  private adding = false;
  private readonly now: () => number;

  constructor(
    private readonly deposit: DepositRef,
    private readonly deps: FlowDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  get screen(): Screen {
    return this.current;
  }

  /** Amount, token and the app's name, once loaded. */
  get details(): Challenge | null {
    return this.challenge;
  }

  /** The remembered wallet with its balance and limit left, once read. */
  get source(): Source | null {
    return this.from;
  }

  /** The wallet this browser remembers, known at once (its balance and limit take a chain read). */
  get knownWallet(): string | null {
    return this.deps.memory?.load()?.wallet ?? null;
  }

  /** The remembered wallet's balance and limit are still being read. */
  get sourcePending(): boolean {
    return this.reading;
  }

  onChange(listener: (s: Screen) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    try {
      // Both at once: the challenge and the wallet's numbers.
      const challenge = this.refresh();
      const read = this.readSourceSoon();
      await challenge;
      await read;
      this.show({ name: "confirm" });
    } catch (e) {
      this.fail(e, () => void this.start());
      return;
    }
    this.timer ??= setInterval(() => {
      const idle = ["confirm", "not_found", "ready", "source"].includes(this.current.name);
      if (idle) void this.refresh().catch(() => {});
    }, REFRESH_EVERY_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /**
   * The main button. A browser that knows this user has shown their wallet,
   * so Face ID makes the deposit. Otherwise Face ID first says who they are.
   * Call straight from a tap.
   */
  approve(): Promise<void> {
    const known = this.deps.memory?.load();
    return known ? this.pay(known.wallet, { name: "confirm", cancelled: true }) : this.verify();
  }

  /**
   * Face ID to say who this is: their wallets are shown, nothing moves. Also
   * how a remembered user picks another wallet. Call straight from a tap.
   */
  async verify(): Promise<void> {
    // The browser does not say whether the sheet was closed or found no
    // passkey. Someone this browser has seen deposit before has one.
    const dismissed: Screen = this.deps.memory?.load() ? { name: "confirm", cancelled: true } : { name: "not_found" };
    const approval = await this.faceId("verify", dismissed, () => void this.verify());
    if (!approval) return;
    this.show({ name: "sending", purpose: "verify" });
    try {
      const wallets = await this.deps.api.sources(this.deposit, approval);
      if (!wallets.length) return this.submitRefused(new ApiError(402, "no_funds", "no linked wallet"));
      this.linked = wallets.map((w) => w.wallet);
      // A new challenge for the deposit itself, in hand before the next tap.
      await this.refresh();
      const last = this.deps.memory?.load()?.wallet;
      const selected = wallets.find((w) => w.enough && w.wallet === last) ?? wallets.find((w) => w.enough);
      this.show({ name: "source", wallets, selected: selected?.wallet ?? null });
    } catch (e) {
      this.submitRefused(e);
    }
  }

  /** On the "pay from" screen: highlights another wallet. */
  selectWallet(wallet: string): void {
    const s = this.current;
    if (s.name === "source" && s.wallets.some((w) => w.wallet === wallet && w.enough)) {
      this.show({ ...s, selected: wallet, cancelled: false });
    }
  }

  /** On the "pay from" screen: Face ID, then the deposit from the selected wallet. Call straight from a tap. */
  async payFrom(): Promise<void> {
    const s = this.current;
    if (s.name !== "source" || !s.selected) return;
    await this.pay(s.selected, { ...s, cancelled: true });
  }

  /** Face ID is the last step: it approves this deposit, and the money moves. */
  private async pay(wallet: string, dismissed: Screen): Promise<void> {
    const approval = await this.faceId("pay", dismissed, () => void this.pay(wallet, dismissed));
    if (!approval) return;
    this.show({ name: "sending", purpose: "pay" });
    let result: DepositResult;
    try {
      result = await this.deps.api.submit(this.deposit, approval, wallet);
    } catch (e) {
      return this.submitRefused(e);
    }
    this.challenge = null;
    if (result.status !== "succeeded") {
      return this.show({ name: "failed", message: "The deposit did not go through. Nothing was taken.", retry: false });
    }
    this.show({ name: "succeeded", result });
    if (result.wallet) {
      this.deps.memory?.save({ credentialId: approval.credentialId, wallet: result.wallet });
      // Shown again with what is left, once read.
      await this.readSource();
      if (this.current.name === "succeeded") this.show(this.current);
    }
  }

  /** Opens the Face ID sheet. Null when it was closed or failed: the screen then says so. */
  private async faceId(purpose: "verify" | "pay", dismissed: Screen, again: () => void): Promise<Approval | null> {
    const ready = this.fresh();
    this.show({ name: "approving", purpose });
    try {
      // With a fresh challenge in hand nothing is awaited before Face ID,
      // so the browser still counts the tap.
      const challenge = ready ?? (await this.refresh());
      const approval = await this.deps.passkeys.approve(challenge.challenge, challenge.rp_id);
      this.credentialId = approval.credentialId;
      return approval;
    } catch (e) {
      if (e instanceof PasskeyDismissed) this.show(dismissed);
      else this.fail(e, again);
      return null;
    }
  }

  /** From "no passkey found": start the one-time setup. */
  setUp(): void {
    this.purpose = "setup";
    this.adding = false;
    this.credentialId = null;
    this.forget();
    this.pickAWallet();
  }

  /**
   * Links one more wallet to the Swish ID this browser knows: same passkey,
   * the new wallet signs once. No new passkey is made.
   */
  addWallet(): void {
    const known = this.deps.memory?.load();
    if (!known) return;
    this.purpose = "setup";
    this.adding = true;
    this.credentialId = known.credentialId;
    this.pickAWallet();
  }

  /** When the limit is too low: from the first screen, or from the "pay from" screen. */
  addToLimit(): void {
    const credentialId = this.credentialId ?? this.deps.memory?.load()?.credentialId;
    if (!credentialId) return;
    this.purpose = "raise";
    this.credentialId = credentialId;
    this.pickAWallet();
  }

  /** Looks again for wallets in this browser (one may have just been installed). */
  listWallets(): void {
    this.pickAWallet();
  }

  async pickWallet(name: string): Promise<void> {
    this.show({ name: "connecting", wallet: name });
    try {
      this.wallet = await this.deps.wallets.connect(name);
      // A wallet that already trusts this site connects silently, with
      // whichever account is selected in it: say so when it is the same one.
      // Adding to a limit is for a wallet already linked to this Swish ID,
      // never a way to link whichever account the wallet happens to be on.
      const mine = this.purpose === "raise" ? this.raisable() : null;
      if (mine && !mine.includes(this.wallet.address)) {
        const connected = this.wallet.address;
        this.wallet = null;
        return this.pickAWallet(
          `${name} is on ${short(connected)}, which is not linked to your Swish ID. Switch to ${mine.map(short).join(" or ")} in ${name}, then choose it again.`,
        );
      }
      if (this.adding && this.wallet.address === this.deps.memory?.load()?.wallet) {
        this.wallet = null;
        return this.pickAWallet(
          `${name} connected the wallet you already use with Swish. Switch to another account in ${name}, then choose it again.`,
        );
      }
      await this.askLimit();
    } catch (e) {
      if (e instanceof WalletRejected) return this.pickAWallet(e.message);
      this.fail(e, () => void this.pickWallet(name));
    }
  }

  /** Setup: the wallet's limit. Raise: how much to add. Both in USDC, e.g. "250". */
  async chooseLimit(amount: string): Promise<void> {
    this.chosen = amount;
    if (this.purpose === "raise") return this.raiseLimit();
    if (this.credentialId) return this.linkWallet();
    this.show({ name: "passkey" });
  }

  /** Makes the user's Swish passkey. Call straight from a tap. */
  async createPasskey(): Promise<void> {
    const { api, passkeys } = this.deps;
    const rpId = this.challenge?.rp_id;
    if (!rpId) return this.fail(new Error("no deposit loaded"), () => void this.start());
    this.show({ name: "creating" });
    try {
      const created = await passkeys.create(rpId);
      await api.registerPasskey(created.credentialId, created.publicKey);
      this.credentialId = created.credentialId;
    } catch (e) {
      if (e instanceof PasskeyDismissed) {
        return this.show({ name: "passkey", note: "The passkey was not created. Try again." });
      }
      return this.fail(e, () => this.show({ name: "passkey" }));
    }
    await this.linkWallet();
  }

  /** The action behind a failed screen's "Try again". */
  retry(): void {
    const again = this.again;
    this.again = null;
    if (again) again();
    else void this.start();
  }

  // ---- inside ----

  private show(screen: Screen): void {
    this.current = screen;
    for (const l of this.listeners) l(screen);
  }

  /** The cached challenge, if it will outlive a Face ID prompt. */
  private fresh(): Challenge | null {
    const c = this.challenge;
    if (!c || this.loading) return null;
    return new Date(c.expires_at).getTime() - this.now() > FRESH_FOR_MS ? c : null;
  }

  /** Asks for a new challenge; the previous one stops working. */
  private refresh(): Promise<Challenge> {
    this.loading ??= this.deps.api
      .challenge(this.deposit)
      .then((c) => (this.challenge = c))
      .finally(() => (this.loading = null));
    return this.loading;
  }

  /** Reads the remembered wallet's balance and limit; never fails the flow. */
  private async readSource(): Promise<void> {
    const known = this.deps.memory?.load();
    if (!known) {
      this.from = null;
      return;
    }
    this.reading = true;
    try {
      const standing = await this.deps.api.allowance(known.credentialId, known.wallet);
      this.from = { wallet: known.wallet, left: standing.left, balance: standing.balance };
    } catch {
      this.from = null;
    } finally {
      this.reading = false;
    }
  }

  /**
   * Reads the wallet's balance and limit, so the screen opens knowing whether
   * the limit covers the deposit. Resolves when they are read, or after a
   * short wait if the chain is slow: the screen then opens without them
   * (its button inactive) and is drawn again when they arrive.
   */
  private readSourceSoon(): Promise<void> {
    const read = this.readSource().then(() => {
      if (late && (this.current.name === "confirm" || this.current.name === "ready")) this.show(this.current);
    });
    let late = false;
    const wait = new Promise<void>((resolve) => setTimeout(resolve, this.deps.sourceWaitMs ?? SOURCE_WAIT_MS));
    return Promise.race([read, wait.then(() => void (late = true))]);
  }

  /** The wallets whose limit can be raised, as far as this browser knows; null when it does not. */
  private raisable(): string[] | null {
    if (this.linked?.length) return this.linked;
    const known = this.deps.memory?.load()?.wallet;
    return known ? [known] : null;
  }

  private forget(): void {
    this.deps.memory?.clear();
    this.from = null;
    this.linked = null;
  }

  private need(left = 0): number {
    return Math.max(Number(this.challenge?.amount ?? 0) - left, 0);
  }

  private pickAWallet(note?: string): void {
    this.show({ name: "wallets", purpose: this.purpose, wallets: this.deps.wallets.list(), note });
  }

  private async askLimit(): Promise<void> {
    const wallet = this.wallet!;
    if (this.purpose === "setup") {
      const need = this.need();
      // Shown for reference; setup does not depend on it.
      const balance = await this.deps.api
        .allowance(this.credentialId ?? "new", wallet.address)
        .then((s) => s.balance)
        .catch(() => undefined);
      return this.show({
        name: "limit",
        purpose: "setup",
        wallet: wallet.address,
        ...(balance === undefined ? {} : { balance }),
        choices: limitChoices(need),
        minimum: String(need),
      });
    }
    const { left, balance } = await this.deps.api.allowance(this.credentialId!, wallet.address);
    const need = this.need(Number(left));
    if (need <= 0) {
      // The limit covers it, so the wallet itself is short.
      return this.show({
        name: "failed",
        message: `This wallet does not hold the ${this.challenge?.amount} USDC this deposit needs. Add USDC to it and try again.`,
        retry: false,
      });
    }
    this.show({
      name: "limit",
      purpose: "raise",
      wallet: wallet.address,
      balance,
      left,
      choices: limitChoices(need),
      minimum: String(need),
    });
  }

  /** Setup: the wallet signs what the API prepares until nothing is left. */
  private async linkWallet(): Promise<void> {
    const { api } = this.deps;
    const wallet = this.wallet!;
    try {
      let done = 0;
      for (;;) {
        const step = await api.prepareWallet(this.deposit, this.credentialId!, wallet.address, this.chosen!);
        if (step.done) break;
        if (done >= MAX_SETUP_STEPS) throw new Error("Setup did not finish. Try again.");
        const total = done + (step.step === "authorize" ? 2 : 1);
        await this.signAndSend(step, done, total);
        done++;
      }
      await this.settled();
    } catch (e) {
      this.setupRefused(e, () => void this.linkWallet());
    }
  }

  private async raiseLimit(): Promise<void> {
    const { api } = this.deps;
    const wallet = this.wallet!;
    try {
      let step: SetupStep;
      try {
        step = await api.addToLimit(this.deposit, this.credentialId!, wallet.address, this.chosen!);
      } catch (e) {
        // A passkey with no wallet behind it yet: finish the setup instead.
        if (e instanceof ApiError && e.code === "not_set_up") return this.linkWallet();
        throw e;
      }
      await this.signAndSend(step, 0, 1);
      await this.settled();
    } catch (e) {
      this.setupRefused(e, () => void this.raiseLimit());
    }
  }

  /** The wallet part is done: remember it, and get ready for the one Face ID left. */
  private async settled(): Promise<void> {
    this.deps.memory?.save({ credentialId: this.credentialId!, wallet: this.wallet!.address });
    const challenge = this.refresh();
    const read = this.readSourceSoon();
    await challenge;
    await read;
    this.show(this.adding ? { name: "ready", purpose: this.purpose, added: true } : { name: "ready", purpose: this.purpose });
    this.adding = false;
  }

  private async signAndSend(step: SetupStep, done: number, total: number): Promise<void> {
    if (step.done) return;
    const wallet = this.wallet!;
    this.show({ name: "signing", wallet: wallet.name, done, total });
    const signed = await wallet.sign(fromBase64(step.transaction));
    await this.deps.api.submitWalletTransaction(toBase64(signed), step.token);
  }

  private submitRefused(e: unknown): void {
    if (!(e instanceof ApiError)) return this.fail(e, () => void this.approve());
    switch (e.code) {
      case "no_funds":
        this.purpose = "raise";
        if (this.wallet) {
          void this.askLimit().catch((err) => this.fail(err, () => void this.approve()));
          return;
        }
        return this.pickAWallet("Your Swish limit or balance is too low for this deposit. Connect your wallet to fix it.");
      case "no_swish_id":
        this.credentialId = null;
        this.forget();
        return this.show({ name: "not_found", note: "That passkey is not set up with Swish yet." });
      case "expired":
      case "passkey_rejected":
        void this.refresh().catch(() => {});
        return this.show({ name: "confirm", note: "That did not go through. Try again." });
      case "not_open":
        return this.show({ name: "failed", message: "This deposit is already finished.", retry: false });
      default:
        return this.fail(e, () => void this.approve());
    }
  }

  private setupRefused(e: unknown, again: () => void): void {
    if (e instanceof WalletRejected) return this.fail(e, again);
    if (e instanceof ApiError) {
      switch (e.code) {
        // Another wallet may do: nothing was spent on this one.
        case "no_usdc_account":
        case "not_enough_usdc":
        case "wallet_linked_elsewhere":
          this.wallet = null;
          return this.pickAWallet(e.message);
        case "deposit_has_wallet":
        case "setup_limit":
        case "daily_new_wallet_limit":
        case "not_open":
          return this.show({ name: "failed", message: e.message, retry: false });
      }
    }
    this.fail(e, again);
  }

  private fail(e: unknown, again: () => void): void {
    const known = e instanceof ApiError || e instanceof WalletRejected || e instanceof PasskeyUnsupported;
    const final = e instanceof PasskeyUnsupported || (e instanceof ApiError && e.code === "not_open");
    this.again = final ? null : again;
    this.show({
      name: "failed",
      message: known ? (e as Error).message : "Something went wrong. Try again.",
      retry: !final,
    });
  }
}
