/**
 * Every screen of the widget, drawn from what the flow says. No screen
 * decides anything: taps go back to the flow through `Actions`.
 */
import { useState } from "react";

import type { Challenge } from "core/api";
import type { Screen, Source } from "./flow";
import { explorerUrl, money, round, shortAddress } from "core/format";
import type { Cluster } from "core/wallet";

import {
  AmountBlock,
  Chevron,
  FaceId,
  Heading,
  LimitBar,
  Primary,
  Spinner,
  Steps,
  WalletIcon,
} from "./ui";
import { DEMO_WALLET, type DemoStage } from "../demo-wallet";

/** What the flow knows, as the screens need it. */
export interface View {
  details: Challenge | null;
  /** The wallet this browser remembers, with its balance and limit once read. */
  wallet: string | null;
  source: Source | null;
  sourcePending: boolean;
  cluster: Cluster;
  /** "Touch ID", "Face ID", or "your fingerprint or screen lock". */
  unlock: string;
  /** The wallet app chosen in setup ("Phantom") and the limit set, for the lines that name them. */
  walletName: string | null;
  chosenLimit: string | null;
  /** What is being waited for; the screen stays as it is and says so. */
  busy?: string;
  demoStage?: DemoStage;
  connectingWallet?: string;
}

export interface Actions {
  approve(): void;
  verify(): void;
  setUp(): void;
  addToLimit(): void;
  addWallet(): void;
  listWallets(): void;
  pickWallet(name: string): void;
  chooseLimit(amount: string): void;
  createPasskey(): void;
  selectWallet(wallet: string): void;
  payFrom(): void;
  retry(): void;
  close(): void;
  fundWallet(wallet?: string): void;
}

/** Screens that are a wait: the screen before them stays up, with `busy` set. */
export const WAITS = new Set<Screen["name"]>([
  "approving",
  "sending",
  "creating",
  "connecting",
  "signing",
]);

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Short enough for a button: "Deposit with Touch ID", "Deposit with passkey". */
const unlockOnButton = (unlock: string) =>
  /ID$/.test(unlock) ? unlock : "passkey";

const Waiting = ({ text }: { text: string }) => (
  <div className="waiting" role="status">
    <Spinner />
    {text}
  </div>
);

const Note = ({
  text,
  error,
}: {
  text?: string | undefined;
  error?: boolean;
}) =>
  text ? (
    <p className={error ? "note error" : "note"} role="status">
      {text}
    </p>
  ) : null;

const to = (v: View) =>
  v.details
    ? `${round(v.details.amount)} ${v.details.token} to ${v.details.app.name}`
    : "";

/** First time in this browser: connect a wallet, or use a passkey made elsewhere. */
/**
 * For someone who set up before, on another browser or device: their passkey
 * finds their wallet, so they can leave setup at any step. Hidden once this
 * browser knows who they are.
 */
function HavePasskey({ v, a }: { v: View; a: Actions }) {
  if (v.wallet) return null;
  return (
    <p className="fine" style={{ paddingTop: 16 }}>
      Already have a Swish passkey?{" "}
      <button onClick={a.approve} disabled={!!v.busy}>
        Use it
      </button>
    </p>
  );
}

function Welcome({
  v,
  a,
  note,
}: {
  v: View;
  a: Actions;
  note?: string | undefined;
}) {
  return (
    <>
      <Steps done={1} />
      <Heading
        eyebrow={`${to(v)} · step 1 of 3`}
        title={"Set up once.\nOne tap after."}
      >
        Choose the wallet your deposits come from. Link it once, then use your
        passkey.
      </Heading>
      <div className="stack">
        <button className="option" onClick={a.setUp} disabled={!!v.busy}>
          <span className="badge">
            <WalletIcon />
          </span>
          <span className="text">
            <span className="name">Connect a wallet</span>
            <span className="sub">Demo Wallet, Phantom, Solflare and more</span>
          </span>
          <Chevron />
        </button>
        <button className="option" onClick={a.approve} disabled={!!v.busy}>
          <span className="badge">
            <FaceId />
          </span>
          <span className="text">
            <span className="name">Use my Swish passkey</span>
            <span className="sub">Already set up? No wallet needed</span>
          </span>
          <Chevron />
        </button>
      </div>
      <Note text={note} />
      {v.busy && <Waiting text={v.busy} />}
    </>
  );
}

function Wallets({
  v,
  a,
  screen,
}: {
  v: View;
  a: Actions;
  screen: Extract<Screen, { name: "wallets" }>;
}) {
  const setup = screen.purpose === "setup";
  const none = screen.wallets.length === 0;
  return (
    <>
      {setup && <Steps done={1} />}
      <Heading
        eyebrow={setup ? `${to(v)} · step 1 of 3` : to(v)}
        title={
          none
            ? "No wallet found"
            : setup
              ? "Choose your wallet"
              : "Connect your wallet"
        }
      >
        {none
          ? "Install a Solana wallet such as Phantom in this browser, add USDC to it, then look again."
          : setup
            ? "Choose where your deposits come from. No wallet app? Use Demo Wallet."
            : "The wallet whose limit you want to add to. It signs once."}
      </Heading>
      <div className="stack">
        {screen.wallets.map((w) => (
          <button
            key={w.name}
            className="option"
            onClick={() => a.pickWallet(w.name)}
            disabled={!!v.busy}
          >
            <span className="badge">
              <img alt="" src={w.icon} />
            </span>
            <span className="text">
              <span className="name">{w.name}</span>
              {w.name === DEMO_WALLET && (
                <span className="sub">Test funds only</span>
              )}
            </span>
            {v.connectingWallet === w.name ? (
              <span className="wallet-progress" role="status">
                <span>
                  {w.name === DEMO_WALLET
                    ? {
                        creating: "Creating wallet",
                        funding: "Adding test funds",
                        ready: "Wallet ready",
                        failed: "Retry",
                      }[v.demoStage ?? "creating"]
                    : "Connecting"}
                </span>
                {v.demoStage === "ready" && w.name === DEMO_WALLET ? (
                  <span aria-hidden="true">✓</span>
                ) : (
                  <Spinner />
                )}
              </span>
            ) : w.name === DEMO_WALLET ? (
              <span className="wallet-progress">
                {v.demoStage === "failed" ? "Try again" : "Try it"}
                <Chevron />
              </span>
            ) : (
              <Chevron />
            )}
          </button>
        ))}
      </div>
      <Note text={screen.note} />
      <p className="fine" style={{ paddingTop: 20 }}>
        Your wallet signs during setup. Later deposits use your passkey.
      </p>
      {screen.purpose === "setup" && <HavePasskey v={v} a={a} />}
      {none && (
        <div className="actions">
          <Primary onClick={a.listWallets}>Look again</Primary>
        </div>
      )}
    </>
  );
}

const PRESETS = ["250", "1000", "2500"];
const validAmount = (s: string) => /^\d+(\.\d{1,6})?$/.test(s) && Number(s) > 0;

function Limit({
  v,
  a,
  screen,
}: {
  v: View;
  a: Actions;
  screen: Extract<Screen, { name: "limit" }>;
}) {
  const raise = screen.purpose === "raise";
  const minimum = Number(screen.minimum);
  // Setup offers the design's three limits; adding to a limit offers what the flow worked out.
  const fits = PRESETS.filter((p) => Number(p) >= minimum);
  const presets = raise || fits.length < 2 ? screen.choices : fits;
  const [preset, setPreset] = useState<string | null>(
    presets[Math.min(1, presets.length - 1)] ?? null,
  );
  const [other, setOther] = useState("");
  const typed = other.trim();
  const chosen = typed || preset || "";
  const ok = validAmount(chosen) && Number(chosen) >= minimum;
  const tooLow = validAmount(chosen) && Number(chosen) < minimum;

  const amount = Number(v.details?.amount ?? 0);
  const left = Number(screen.left ?? 0);
  // Setup: the limit itself. Adding: what is left now plus what is added.
  const limitAfter = raise ? left + Number(chosen || 0) : Number(chosen || 0);
  const leftAfter = Math.max(limitAfter - amount, 0);
  // A limit is easier to judge as a number of deposits than against today's balance.
  const covers = amount > 0 ? Math.floor(limitAfter / amount) : 0;

  const facts = [shortAddress(screen.wallet)];
  if (screen.balance !== undefined) facts.push(`${money(screen.balance)} USDC`);
  facts.push(raise ? `limit left ${round(String(left))}` : "step 2 of 3");

  return (
    <div className="limit">
      {!raise && <Steps done={2} />}
      <Heading
        eyebrow={facts.join(" · ")}
        title={raise ? "Add to your limit" : "Set a spending limit"}
      >
        {raise
          ? "This deposit needs more than your limit has left. How much do you want to add?"
          : "The most Swish can ever move from this wallet, across every app. Change it any time."}
      </Heading>
      <div className="presets">
        {presets.map((p) => (
          <button
            key={p}
            className={!typed && preset === p ? "preset on" : "preset"}
            aria-pressed={!typed && preset === p}
            disabled={!!v.busy}
            onClick={() => {
              setPreset(p);
              setOther("");
            }}
          >
            {raise ? "+" : ""}
            {round(p)}
          </button>
        ))}
      </div>
      <label className={typed ? "other on" : "other"}>
        <input
          inputMode="decimal"
          autoComplete="off"
          placeholder="Other amount"
          aria-label="Other amount in USDC"
          value={other}
          disabled={!!v.busy}
          onChange={(e) => setOther(e.target.value.replace(/[^\d.]/g, ""))}
        />
        <span>USDC</span>
      </label>
      {ok && (
        <div className="panel">
          <div className="pad">
            <div className="pair">
              <span>After this deposit</span>
              <span>
                {round(String(leftAfter))} of {round(String(limitAfter))} USDC
                left
              </span>
            </div>
            <LimitBar now={amount} rest={leftAfter} />
            {covers > 0 && (
              <p className="aside">
                {covers === 1
                  ? "Covers this deposit"
                  : `Covers ${covers.toLocaleString("en-US")} deposits like this one`}
              </p>
            )}
          </div>
        </div>
      )}
      <Note
        text={
          tooLow
            ? `This deposit needs at least ${round(screen.minimum)} USDC${raise ? " more" : ""}.`
            : undefined
        }
      />
      <div className="actions" style={{ paddingTop: 8 }}>
        <Primary
          onClick={() => a.chooseLimit(chosen)}
          disabled={!ok}
          busy={v.busy}
        >
          Continue
        </Primary>
        <p className="fine">
          Not the wallet you want? Switch account in your wallet, then{" "}
          <button onClick={a.listWallets} disabled={!!v.busy}>
            choose again
          </button>
        </p>
        {screen.purpose === "setup" && <HavePasskey v={v} a={a} />}
        {screen.balance !== undefined &&
          Number(screen.balance) < Number(v.details?.amount ?? 0) && (
            <button
              className="text-link"
              onClick={() => a.fundWallet(screen.wallet)}
              disabled={!!v.busy}
            >
              Get free test funds
            </button>
          )}
      </div>
    </div>
  );
}

function Passkey({
  v,
  a,
  note,
  retry,
}: {
  v: View;
  a: Actions;
  note?: string | undefined;
  retry?: boolean;
}) {
  const lines = [
    `${capital(v.unlock)} creates the passkey`,
    `${v.walletName ?? "Your wallet"} signs to link and set the limit`,
    "Swish pays the network fees",
  ];
  return (
    <>
      <Steps done={3} />
      <Heading
        eyebrow={`${v.chosenLimit ? `Limit ${round(v.chosenLimit)} USDC · ` : ""}step 3 of 3`}
        title="Create your Swish ID"
      >
        A passkey, not an email or a phone number. Use it on any device where
        your same passkey is available. It approves each deposit.
      </Heading>
      <div className="panel">
        {lines.map((line, i) => (
          <div key={line} className="numbered">
            <b>0{i + 1}</b>
            <span>{line}</span>
          </div>
        ))}
      </div>
      <Note text={note} />
      <div className="actions">
        <Primary
          onClick={retry ? a.retry : a.createPasskey}
          busy={v.busy}
          faceId={!retry}
        >
          {retry ? "Continue setup" : "Create passkey"}
        </Primary>
        {retry && (
          <button className="text-link" onClick={() => a.fundWallet()}>
            Test funds and network help
          </button>
        )}
        {!retry && <HavePasskey v={v} a={a} />}
      </div>
    </>
  );
}

/** The remembered wallet and one button: on open for a returning user, and at the end of setup. */
function Confirm(props: {
  v: View;
  a: Actions;
  line: string;
  fine: string;
  note?: string | undefined;
  cancelled?: boolean;
}) {
  const { v, a } = props;
  const d = v.details;
  if (!d || !v.wallet) return null;
  const amount = Number(d.amount);
  // Until the balance and limit are read, nothing is called low.
  const read = v.source?.wallet === v.wallet ? v.source : null;
  const limitLow = read !== null && Number(read.left) < amount;
  const balanceLow = read !== null && Number(read.balance) < amount;
  const leftAfter = read ? Math.max(Number(read.left) - amount, 0) : 0;
  const said =
    props.note ??
    (props.cancelled
      ? `${capital(v.unlock)} did not finish. Nothing was sent. Try again.`
      : // An empty wallet comes first: adding to a limit needs the USDC there too.
        balanceLow
        ? "This wallet holds less than this deposit. Add USDC to it, or use another wallet."
        : limitLow
          ? "Your limit is lower than this deposit. Add to it first."
          : undefined);
  return (
    <>
      <AmountBlock
        app={d.app.name}
        line={props.line}
        amount={round(d.amount)}
        token={d.token}
        lockedBy={d.app.name}
      />
      <div className="panel">
        <div className="source">
          <span className="badge round">
            <WalletIcon />
          </span>
          <span className="text">
            <span className="name">{shortAddress(v.wallet)}</span>
            <span className="sub">
              {read
                ? `${money(read.balance)} USDC in wallet`
                : v.sourcePending
                  ? "…"
                  : "Balance not available"}
            </span>
          </span>
        </div>
        {read && (
          <div className="pad">
            <div className="pair">
              <span>Limit</span>
              <span>
                {round(read.left)}
                {read.limit === undefined
                  ? ""
                  : ` of ${round(read.limit)}`}{" "}
                USDC left
              </span>
            </div>
            {!limitLow && <LimitBar now={amount} rest={leftAfter} />}
            {!limitLow && (
              <p className="aside">
                {round(String(leftAfter))} USDC left after this deposit
              </p>
            )}
          </div>
        )}
      </div>
      <Note text={said} />
      <div className="actions">
        {balanceLow ? (
          <Primary onClick={() => a.fundWallet(v.wallet!)} busy={v.busy}>
            Get test USDC
          </Primary>
        ) : limitLow ? (
          <Primary onClick={a.addToLimit} busy={v.busy}>
            Add to limit
          </Primary>
        ) : (
          <Primary
            onClick={a.approve}
            busy={v.busy}
            disabled={v.sourcePending}
            faceId
          >
            Deposit with {unlockOnButton(v.unlock)}
          </Primary>
        )}
        <p className="fine">
          {props.cancelled ? (
            <>
              No Swish passkey on this device?{" "}
              <button onClick={a.setUp} disabled={!!v.busy}>
                Set up once
              </button>
            </>
          ) : (
            props.fine
          )}
        </p>
      </div>
    </>
  );
}

function PayFrom({
  v,
  a,
  screen,
}: {
  v: View;
  a: Actions;
  screen: Extract<Screen, { name: "source" }>;
}) {
  const d = v.details;
  if (!d) return null;
  const none = screen.selected === null;
  return (
    <>
      <AmountBlock
        app={d.app.name}
        line={`Deposit to ${d.app.name}`}
        amount={round(d.amount)}
        token={d.token}
      />
      <div className="stack">
        <div className="label">Pay from</div>
        {screen.wallets.map((w) =>
          w.enough ? (
            <button
              key={w.wallet}
              className={
                w.wallet === screen.selected ? "option selected" : "option"
              }
              aria-pressed={w.wallet === screen.selected}
              disabled={!!v.busy}
              onClick={() => a.selectWallet(w.wallet)}
            >
              <span className="badge round">
                <WalletIcon />
              </span>
              <span className="text">
                <span className="name">{shortAddress(w.wallet)}</span>
                <span className="sub">
                  Balance {money(w.balance)} · limit left {round(w.left)} USDC
                </span>
              </span>
              <span
                className={w.wallet === screen.selected ? "radio on" : "radio"}
              />
            </button>
          ) : (
            <div key={w.wallet} className="option">
              <span className="badge round dim">
                <WalletIcon />
              </span>
              <span className="text">
                <span className="name dim">{shortAddress(w.wallet)}</span>
                <span className="sub warn">
                  {money(w.balance)} USDC · not enough
                </span>
              </span>
              <button
                className="row-action"
                onClick={() =>
                  Number(w.balance) < Number(d.amount)
                    ? a.fundWallet(w.wallet)
                    : a.addToLimit()
                }
                disabled={!!v.busy}
              >
                {Number(w.balance) < Number(d.amount)
                  ? "Get test USDC"
                  : "Add to limit"}
              </button>
            </div>
          ),
        )}
      </div>
      <Note
        text={
          screen.cancelled
            ? `${capital(v.unlock)} did not finish. Nothing was sent. Try again.`
            : none
              ? "None of your wallets can cover this deposit. Add to a limit, or add USDC to a wallet."
              : undefined
        }
      />
      <div className="actions">
        {none ? (
          <Primary onClick={a.addToLimit} busy={v.busy}>
            Add to limit
          </Primary>
        ) : (
          <Primary onClick={a.payFrom} busy={v.busy} faceId>
            Deposit with {unlockOnButton(v.unlock)}
          </Primary>
        )}
        <p className="fine">Nothing moves without your passkey</p>
      </div>
    </>
  );
}

function Landed({
  v,
  a,
  screen,
}: {
  v: View;
  a: Actions;
  screen: Extract<Screen, { name: "succeeded" }>;
}) {
  const { result } = screen;
  const from = result.wallet ?? v.source?.wallet ?? null;
  const left = v.source && v.source.wallet === from ? v.source.left : null;
  return (
    <>
      <div className="landed">
        <svg width="120" height="46" viewBox="0 0 200 76" aria-hidden="true">
          <path
            d="M100 0L200 56L190 66L156 48L134 64L116 52L100 62L84 52L66 64L44 48L10 66L0 56Z"
            fill="currentColor"
          />
        </svg>
        <div className="sum">
          <strong>{round(result.amount)}</strong>
          <span>{result.token}</span>
        </div>
        <div className="status">
          Landed in your {v.details?.app.name ?? "app"} account
        </div>
      </div>
      {from && (
        <div className="panel">
          <div className="pad">
            <div className="pair">
              <span>From</span>
              <span>{shortAddress(from)}</span>
            </div>
            {left !== null && (
              <>
                <div className="pair">
                  <span>Limit left</span>
                  <span>{round(left)} USDC</span>
                </div>
                <LimitBar
                  used={Number(result.amount)}
                  now={0}
                  rest={Number(left)}
                />
              </>
            )}
          </div>
        </div>
      )}
      <div className="actions">
        <Primary onClick={a.close}>Done</Primary>
        {result.signature && (
          <p className="fine">
            <a
              href={explorerUrl(result.signature, v.cluster)}
              target="_blank"
              rel="noopener noreferrer"
            >
              View transaction
            </a>
          </p>
        )}
      </div>
    </>
  );
}

function Failed({
  v,
  a,
  screen,
}: {
  v: View;
  a: Actions;
  screen: Extract<Screen, { name: "failed" }>;
}) {
  return (
    <>
      <Heading eyebrow={to(v)} title="That did not work">
        {screen.message}
      </Heading>
      <div className="actions" style={{ paddingTop: 0 }}>
        {screen.retry ? (
          <Primary onClick={a.retry}>Try again</Primary>
        ) : (
          <Primary onClick={a.close}>Close</Primary>
        )}
      </div>
    </>
  );
}

/** `screen` is never a wait: the caller keeps the screen before it and sets `v.busy`. */
export function ScreenBody({
  screen,
  v,
  a,
}: {
  screen: Screen;
  v: View;
  a: Actions;
}) {
  const app = v.details?.app.name ?? "";
  switch (screen.name) {
    case "confirm":
      return v.wallet ? (
        <Confirm
          v={v}
          a={a}
          line={`Deposit to ${app}`}
          fine="Nothing moves without your passkey"
          note={screen.note}
          cancelled={screen.cancelled ?? false}
        />
      ) : (
        <Welcome v={v} a={a} note={screen.note} />
      );
    case "not_found":
      return (
        <Welcome
          v={v}
          a={a}
          note={
            screen.note ??
            `No Swish passkey was found on this device, or ${v.unlock} was cancelled.`
          }
        />
      );
    case "wallets":
      return <Wallets v={v} a={a} screen={screen} />;
    case "limit":
      // Keyed so a different wallet starts from that wallet's choices.
      return (
        <Limit
          key={`${screen.purpose}:${screen.wallet}`}
          v={v}
          a={a}
          screen={screen}
        />
      );
    case "passkey":
      return <Passkey v={v} a={a} note={screen.note} />;
    case "setup_retry":
      return <Passkey v={v} a={a} note={screen.note} retry />;
    case "ready":
      return (
        <Confirm
          v={v}
          a={a}
          line={`Deposit to ${app}`}
          fine={
            screen.purpose === "setup" && !screen.added
              ? "From now on, every deposit is only this step"
              : "Nothing moves without your passkey"
          }
        />
      );
    case "source":
      return <PayFrom v={v} a={a} screen={screen} />;
    case "succeeded":
      return <Landed v={v} a={a} screen={screen} />;
    case "failed":
      return <Failed v={v} a={a} screen={screen} />;
    default:
      return (
        <div className="loading" role="status" aria-label="Loading">
          <Spinner />
        </div>
      );
  }
}

/** What a wait says, on the button or under the screen it interrupted. */
export function waitText(screen: Screen, unlock: string): string | undefined {
  switch (screen.name) {
    case "approving":
      return `Waiting for ${unlock}`;
    case "sending":
      return screen.purpose === "verify"
        ? "Finding your wallets"
        : "Sending your deposit";
    case "creating":
      return "Creating your passkey";
    case "connecting":
      return `Opening ${screen.wallet}`;
    case "signing":
      return screen.phase === "confirming"
        ? screen.done + 1 < screen.total
          ? "Confirming first approval"
          : "Confirming wallet link"
        : `Approve in ${screen.wallet}`;
    default:
      return undefined;
  }
}
