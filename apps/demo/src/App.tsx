import { useEffect, useMemo, useRef, useState } from "react";

import type { DepositResult } from "core/api";
import { mountDepositButton, type DepositButton } from "core/button";
import { shortAddress, unlockName } from "core/format";
import { knownWallet, unlinkWallet, watchKnownWallet } from "core/loader";
import type { Theme } from "core/protocol";
import { browserWallets, type Cluster } from "core/wallet";

import copyIcon from "./assets/copy.svg";
import usdcIcon from "./assets/usdc.svg";

interface Config {
  publishableKey: string;
  apiUrl: string;
  cluster: Cluster;
  frameUrl: string;
}

/** A line of the server's log: `sent` is this server's own call, the rest are what came back. */
interface ServerEvent {
  kind: "sent" | "pending" | "success" | "error";
  text: string;
  at: number;
}

const DEFAULT_AMOUNT = "5";
// The server refuses more; the field does not let you type it.
const MAX_AMOUNT = 5;
const FAUCET_URL = "https://faucet.circle.com/";
const DOCS_URL = "https://docs.swish.cash";
const GITHUB_URL = "https://github.com/swishdotcash/swish-deposit";

const BROWSER_CODE = `import { openDeposit }
  from "@swishdotcash/deposit";

const outcome = await openDeposit({
  publishableKey: "swishpub_test_…",
  depositId,
  clientSecret,
  cluster: "devnet",
});

if (outcome.status === "succeeded") {
  showBalance();
}`;

const SERVER_CODE = `const res = await fetch(\`\${SWISH}/v1/deposits\`, {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${SECRET_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    amount: "5",
    token: "USDC",
    destination: userAccount,
  }),
});
const { id, client_secret } = await res.json();`;

const Logo = ({ className }: { className: string }) => (
  <svg className={className} viewBox="0 0 289 148" fill="none" aria-label="Swish" role="img">
    <path
      d="M24.0052 24.0052L60.2824 96.5595C62.1139 100.223 66.9958 101.015 69.8916 98.1189L98.6645 69.346C101.395 66.6152 105.957 67.138 107.999 70.4157L139.349 120.73C141.713 124.524 147.247 124.493 149.569 120.673L180.038 70.5344C182.057 67.2105 186.657 66.6574 189.408 69.4077L218.119 98.1189C221.015 101.015 225.897 100.223 227.728 96.5595L264.005 24.0052"
      stroke="currentColor"
      strokeWidth="48"
      strokeMiterlimit="3.99393"
      strokeLinecap="round"
    />
  </svg>
);

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

export function App({ config }: { config: Config }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [balance, setBalance] = useState(0);
  // Meridian's server keeps the balance, by wallet: the same on a laptop and a phone.
  const loadBalance = async (wallet: string | null) => {
    if (!wallet) return setBalance(0);
    try {
      const res = await fetch(`/api/balance?wallet=${wallet}`);
      if (res.ok) setBalance(Number((await res.json()).balance) || 0);
    } catch {
      // The balance stays as it was.
    }
  };
  useEffect(() => {
    // Heard on load, after each close, and as soon as a passkey has shown whose browser this is.
    const stop = watchKnownWallet(config, (wallet) => void loadBalance(wallet));
    void knownWallet(config).catch(() => {});
    return stop;
  }, [config]);
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [tab, setTab] = useState<"browser" | "server">("browser");
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");
  const [reset, setReset] = useState<{ state: "idle" | "choosing" | "working"; choices?: string[]; note?: string; failed?: boolean }>({
    state: "idle",
  });
  // Wallet apps announce themselves over time, so start listening on load.
  const wallets = useMemo(() => browserWallets(config.cluster), [config.cluster]);

  const slot = useRef<HTMLDivElement>(null);
  const button = useRef<DepositButton | null>(null);
  const amountNow = useRef(amount);
  amountNow.current = amount;
  const stream = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!slot.current) return;
    const mounted = mountDepositButton(slot.current, {
      ...config,
      // Meridian's own server creates the deposit with its secret key.
      createDeposit: async () => {
        setNote("");
        const res = await fetch("/api/deposits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: amountNow.current.trim() }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error?.message ?? "The deposit could not be started.");
        stream.current?.close();
        setEvents([]);
        const source = new EventSource(`/api/deposits/${body.id}/events`);
        source.onmessage = (m) => setEvents((seen) => [...seen, JSON.parse(m.data) as ServerEvent]);
        stream.current = source;
        return body;
      },
      onSuccess: (deposit: DepositResult) => {
        if (deposit.wallet) void loadBalance(deposit.wallet);
        else setBalance((had) => had + Number(deposit.amount));
      },
      onError: (e) => setNote(e instanceof Error ? e.message : "The deposit could not be started."),
    });
    button.current = mounted;
    return () => {
      mounted.destroy();
      stream.current?.close();
    };
  }, [config]);

  useEffect(() => button.current?.setTheme(theme), [theme]);

  const copy = async () => {
    await navigator.clipboard.writeText(tab === "browser" ? BROWSER_CODE : SERVER_CODE);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /** One wallet app installed: straight to its signature. Several: ask which. */
  const chooseWallet = () => {
    const names = wallets.list().map((w) => w.name);
    if (names.length === 0) return setReset({ state: "idle", note: "No Solana wallet was found in this browser.", failed: true });
    if (names.length === 1) return void startOver(names[0]!);
    setReset({ state: "choosing", choices: names });
  };

  /** Unlinks the wallet (it signs once); the browser then forgets it and the button is the first-time one again. */
  const startOver = async (wallet: string) => {
    setReset({ state: "working" });
    try {
      await unlinkWallet({ ...config, wallet });
      setBalance(0);
      setEvents([]);
      button.current?.refresh();
      setReset({ state: "idle", note: "Unlinked. Press the button to run setup again." });
    } catch (e) {
      // A wallet app with several accounts connects whichever one is active.
      const remembered = await knownWallet(config).catch(() => null);
      const message = e instanceof Error ? e.message : "The wallet was not unlinked.";
      const note =
        remembered && /not linked/i.test(message)
          ? `${wallet} is on an account that is not linked. Switch it to ${shortAddress(remembered)} and try again.`
          : message;
      setReset({ state: "idle", note, failed: true });
    }
  };

  // Kept on one line: "Touch ID" never breaks in the middle.
  const unlock = unlockName().replace(/ /g, "\u00a0");

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <Logo className="brand-logo" />
          <span className="brand-name">Swish Deposit</span>
          <span className="tag">Demo</span>
        </div>
        <nav className="links">
          <span className="network">
            <i />
            Devnet · test USDC, no real funds
          </span>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            Docs
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>

      <main className="body">
        <section className="left">
          <div className="intro">
            <h1>One tap to deposit, in any app.</h1>
            <p>A passkey is your Swish ID. Link a wallet once, set a limit, and every deposit after is a single {unlock}.</p>
          </div>

          <div className="configure">
            <div className="control">
              <div className="label">Try it</div>
              <ol className="steps">
                <li>
                  <span>1</span>
                  <p>
                    <b>Switch your wallet to devnet.</b> In Phantom: Settings, Developer settings, Testnet mode.
                  </p>
                </li>
                <li>
                  <span>2</span>
                  <p>
                    <b>Get test USDC</b> from the faucet below. No SOL needed: Swish pays the network fees.
                  </p>
                </li>
                <li>
                  <span>3</span>
                  <p>
                    <b>Press Deposit with Swish.</b> Connect the wallet, set a limit, create your passkey.
                  </p>
                </li>
                <li>
                  <span>4</span>
                  <p>
                    <b>Deposit again.</b> This time it is one {unlock}, and no wallet.
                  </p>
                </li>
              </ol>
            </div>

            <div className="control">
              <div className="label">Theme</div>
              <div className="segmented" role="tablist">
                {(["light", "dark"] as const).map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={theme === t} onClick={() => setTheme(t)}>
                    {t === "light" ? "Light" : "Dark"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="reset">
            {reset.state === "idle" && (
              <button type="button" className="start-over" onClick={chooseWallet}>
                Start over
              </button>
            )}
            {reset.state === "choosing" && (
              <div className="wallets">
                {(reset.choices ?? []).map((w) => (
                  <button key={w} type="button" className="wallet-choice" onClick={() => void startOver(w)}>
                    {w}
                  </button>
                ))}
              </div>
            )}
            {reset.state === "working" && <div className="start-over waiting">Waiting for your wallet</div>}
            <p className={reset.failed ? "hint failed" : "hint"} role="status">
              {reset.note ??
                (reset.state === "choosing"
                  ? "Pick the wallet you set up with. It signs once to unlink."
                  : "Unlinks your test wallet and clears its limit, so you can run setup again.")}
            </p>
          </div>

          <a className="faucet" href={FAUCET_URL} target="_blank" rel="noreferrer">
            <img src={usdcIcon} alt="" width={28} height={28} />
            <span className="faucet-text">
              <b>Need test USDC?</b>
              <span>Get devnet USDC from Circle's faucet</span>
            </span>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3.5 8.5L8.5 3.5M4.5 3.5H8.5V7.5" fill="none" stroke="#121212B3" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </section>

        <section className="center">
          <div className="preview-header">
            <span className="label">Live demo</span>
            <span className="preview-hint">The real widget. Press the button.</span>
          </div>

          <div className="meridian" data-theme={theme}>
            <div className="meridian-top">
              <div className="meridian-name">
                <span className="meridian-mark">M</span>
                Meridian
              </div>
              <span className="meridian-tag">Demo app</span>
            </div>

            <div className="meridian-balance">
              <span className="quiet">Your Meridian balance</span>
              <div>
                <strong>{balance.toFixed(2)}</strong>
                <span className="unit">USDC</span>
              </div>
            </div>

            <div className="meridian-deposit">
              <label htmlFor="amount">Deposit</label>
              <div className="field">
                <input
                  id="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => {
                    const typed = e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
                    setAmount(Number(typed) > MAX_AMOUNT ? String(MAX_AMOUNT) : typed);
                  }}
                />
                <span>USDC</span>
              </div>
              <div ref={slot} />
              <p className="lands">{note || "Lands in a demo account on devnet"}</p>
            </div>
          </div>
        </section>

        <section className="right">
          <div className="code-card">
            <div className="code-tabs">
              <div role="tablist">
                <button type="button" role="tab" aria-selected={tab === "browser"} onClick={() => setTab("browser")}>
                  Browser
                </button>
                <button type="button" role="tab" aria-selected={tab === "server"} onClick={() => setTab("server")}>
                  Server
                </button>
              </div>
              <button type="button" className="copy" onClick={() => void copy()}>
                <img src={copyIcon} alt="" width={14} height={14} />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre>{tab === "browser" ? BROWSER_CODE : SERVER_CODE}</pre>
          </div>

          <div className="events-card">
            <div className="events-top">
              <span>What your server sees</span>
              <span className="label">Live</span>
            </div>
            <div className="events" aria-live="polite">
              {events.length === 0 && (
                <div className="event" data-kind="sent">
                  <i />
                  <span>Waiting for a deposit</span>
                  <time />
                </div>
              )}
              {events.map((e) => (
                <div className="event" data-kind={e.kind} key={`${e.at}-${e.text}`}>
                  <i />
                  <span>{e.text}</span>
                  <time>{clock(e.at)}</time>
                </div>
              ))}
            </div>
          </div>

          <div className="facts">
            <div>
              <strong>1</strong>
              <span>tap per deposit</span>
            </div>
            <div>
              <strong>0</strong>
              <span>gas paid by users</span>
            </div>
            <div>
              <strong>90s</strong>
              <span>approval lifetime</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
