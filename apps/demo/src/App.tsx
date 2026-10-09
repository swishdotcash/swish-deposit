import { useEffect, useState } from "react";
import type { DepositRef, DepositResult } from "core/api";
import type { Memory, Remembered } from "./widget/flow";
import {
  request,
  deviceId,
  linkAction,
  type Config,
  type OpenLink,
} from "./demo-api";
import { Page } from "./Page";
import { Session } from "./Session";
import { DeviceButton } from "./device";
import { Logo, Spinner } from "./widget/ui";

export function demoMemory(key: string, fresh = false): Memory {
  let verified = !fresh;
  let fallback: Remembered | null = null;
  return {
    load() {
      if (!verified) return null;
      try {
        const value = JSON.parse(
          localStorage.getItem(key) ?? "null",
        ) as Remembered | null;
        return value &&
          typeof value.wallet === "string" &&
          typeof value.credentialId === "string"
          ? value
          : null;
      } catch {
        return fallback;
      }
    },
    save(value) {
      verified = true;
      fallback = value;
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* The passkey can find wallets again. */
      }
    },
    clear() {
      verified = true;
      fallback = null;
      try {
        localStorage.removeItem(key);
      } catch {
        /* No saved wallet. */
      }
    },
  };
}

interface Current {
  deposit: DepositRef;
  amount: string;
  shareFirst?: boolean;
  remote?: { token: string; device: string };
  result?: DepositResult;
}
const incomingToken = () =>
  new URLSearchParams(location.hash.slice(1)).get("deposit");

export function App({ config }: { config: Config }) {
  const [token] = useState(incomingToken);
  const [memory] = useState(() =>
    demoMemory(`swish-demo-passkey-v3:${config.publishableKey}`, !!token),
  );
  const [amount, setAmount] = useState("5");
  const [balance, setBalance] = useState("0.00");
  const [current, setCurrent] = useState<Current | null>(null);
  const [busy, setBusy] = useState(!!token);
  const [error, setError] = useState("");
  const [invalidLink, setInvalidLink] = useState(false);
  const [generation, setGeneration] = useState(0);
  async function loadBalance() {
    const wallet = memory.load()?.wallet;
    if (!wallet) return;
    try {
      const data = await request<{ balance: string }>(
        `/api/balance?wallet=${encodeURIComponent(wallet)}`,
      );
      setBalance(Number(data.balance).toFixed(2));
    } catch {
      /* Keep the last known app balance. */
    }
  }
  useEffect(() => {
    void loadBalance();
  }, [generation]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    void (async () => {
      try {
        if (!/^[\w-]{43}$/.test(token))
          throw new Error(
            "This link is no longer valid. Open a new link from the original screen.",
          );
        const device = deviceId();
        const opened = await linkAction<OpenLink>(token, "open", { device });
        if (!active) return;
        const ref = opened.deposit ?? {
          id: opened.result!.id,
          clientSecret: "",
        };
        setCurrent({
          deposit: ref,
          amount: opened.amount ?? opened.result?.amount ?? "5",
          remote: { token, device },
          result: opened.result,
        });
      } catch (e) {
        if (active) {
          setError(
            e instanceof Error ? e.message : "This link could not be opened.",
          );
          setInvalidLink(true);
        }
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);
  const valid =
    /^\d+(\.\d{1,6})?$/.test(amount) &&
    Number(amount) >= 1 &&
    Number(amount) <= 5;
  async function start(shareFirst = false) {
    if (busy || !valid) return;
    setBusy(true);
    setError("");
    try {
      const d = await request<{ id: string; client_secret: string }>(
        "/api/deposits",
        { amount },
      );
      setCurrent({
        deposit: { id: d.id, clientSecret: d.client_secret },
        amount,
        shareFirst,
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The deposit could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }
  function close() {
    history.replaceState(null, "", location.pathname + location.search);
    setCurrent(null);
    setInvalidLink(false);
    setError("");
    setGeneration((n) => n + 1);
    void loadBalance();
  }
  if (config.cluster !== "devnet")
    return (
      <Page>
        <p className="note error">
          This playground uses Solana Devnet. Select the devnet demo
          configuration to continue.
        </p>
      </Page>
    );
  if (current)
    return (
      <Session
        key={`${current.deposit.id}:${generation}`}
        config={config}
        deposit={current.deposit}
        memory={memory}
        amount={current.amount}
        remote={current.remote}
        shareFirst={current.shareFirst}
        initialResult={current.result}
        onClose={close}
      />
    );
  if (invalidLink)
    return (
      <Page screen={76}>
        <div className="widget-slot swish">
          <div className="card link-error">
            <h2>This link could not be opened</h2>
            <p>{error}</p>
            <button className="primary" onClick={close}>
              Back to playground
            </button>
          </div>
        </div>
      </Page>
    );
  if (token && busy)
    return (
      <Page screen={58}>
        <div className="widget-slot swish">
          <div className="card">
            <div className="loading" role="status">
              <Spinner />
              <span className="sr-only">Opening deposit</span>
            </div>
          </div>
        </div>
      </Page>
    );
  return (
    <Page>
      <form
        className="meridian"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="meridian-top">
          <div className="meridian-name">
            <span className="meridian-mark">M</span>Meridian
          </div>
          <span className="meridian-tag">Demo app</span>
        </div>
        <div className="meridian-balance">
          <span>Your Meridian balance</span>
          <div>
            <strong>{balance}</strong>
            <span>USDC</span>
          </div>
        </div>
        <div className="meridian-deposit">
          <label htmlFor="deposit-amount">Deposit</label>
          <div className="amount-field">
            <input
              id="deposit-amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={busy}
              aria-describedby="amount-hint"
              onChange={(e) =>
                setAmount(
                  e.target.value
                    .replace(/[^\d.]/g, "")
                    .replace(/(\..*)\./g, "$1"),
                )
              }
            />
            <span>USDC</span>
          </div>
          <button
            className="deposit-button"
            disabled={busy || !valid}
            type="submit"
          >
            {busy ? <Spinner /> : <Logo />}
            <span>
              {busy ? "Getting your deposit ready" : "Deposit with Swish"}
            </span>
          </button>
          <p
            id="amount-hint"
            className={error ? "form-note error" : "form-note"}
            role="status"
          >
            {error ||
              (!valid
                ? "Enter an amount from 1 to 5 USDC."
                : "Lands in this demo account on devnet")}
          </p>
        </div>
      </form>
      <DeviceButton
        initial
        disabled={busy || !valid}
        onClick={() => void start(true)}
      />
    </Page>
  );
}
