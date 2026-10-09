import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { shortAddress } from "core/format";
import { fundWallet, readBalance, type WalletBalance } from "./demo-api";
import { DEMO_WALLET } from "./demo-wallet";
import { Logo, Primary, Spinner } from "./widget/ui";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="swish demo-modal"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const b = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < b.left ||
            e.clientX > b.right ||
            e.clientY < b.top ||
            e.clientY > b.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-top">
        <span>
          <Logo />
          {title}
        </span>
        <button
          className="close"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}

export function ApprovalDialog({
  wallet,
  limit,
  step,
  total,
  reset,
  onApprove,
  onReject,
}: {
  wallet: string;
  limit: string;
  step: number;
  total: number;
  reset?: boolean;
  onApprove(): void;
  onReject(): void;
}) {
  return (
    <Modal title={DEMO_WALLET} onClose={onReject}>
      <div className="dialog-heading">
        <span className="eyebrow">
          {reset ? "START OVER" : `APPROVAL ${step} OF ${total}`}
        </span>
        <h2>
          {reset
            ? "Unlink this wallet"
            : total > 1 && step === 1
              ? "Prepare USDC permissions"
              : "Link your passkey and limit"}
        </h2>
        <p>
          {reset
            ? "This cancels the wallet's Swish limit. You can then run setup again."
            : total > 1 && step === 1
              ? "Prepare this wallet for Swish. The next approval sets your limit."
              : "Link this wallet to your passkey and allow deposits within your chosen limit."}
        </p>
      </div>
      <dl className="dialog-facts">
        <div>
          <dt>Wallet</dt>
          <dd>{shortAddress(wallet)}</dd>
        </div>
        <div>
          <dt>{reset ? "Network" : "Token"}</dt>
          <dd>{reset ? "Solana Devnet" : "Test USDC"}</dd>
        </div>
        {!reset && (step > 1 || total === 1) && (
          <div>
            <dt>Spending limit</dt>
            <dd>{Number(limit).toLocaleString()} USDC</dd>
          </div>
        )}
        <div>
          <dt>Network fees</dt>
          <dd>Paid by Swish</dd>
        </div>
      </dl>
      <p className="dialog-notice">
        This devnet setup transaction does not make a deposit.
      </p>
      <div className="dialog-actions">
        <Primary onClick={onApprove}>Approve</Primary>
        <button className="secondary" onClick={onReject}>
          Reject
        </button>
      </div>
    </Modal>
  );
}

export function FundingDialog({
  wallet,
  walletName,
  amount,
  onClose,
  onFunded,
  onState,
}: {
  wallet: string;
  walletName: string;
  amount: string;
  onClose(): void;
  onFunded(): void;
  onState?(state: string): void;
}) {
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [state, setState] = useState<
    "checking" | "idle" | "funding" | "funded" | "failed"
  >("checking");
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    onState?.(state);
  }, [state, onState]);
  useEffect(() => {
    alive.current = true;
    void readBalance(wallet)
      .then((b) => {
        if (alive.current) {
          setBalance(b);
          setState(
            Number(b.usdc) >= Number(amount) && Number(b.sol) > 0
              ? "funded"
              : "idle",
          );
        }
      })
      .catch(() => {
        if (alive.current) {
          setState("idle");
          setError(
            "The balance could not be read. You can request test funds or continue setup.",
          );
        }
      });
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, [wallet, amount]);
  async function fund() {
    setState("funding");
    setError("");
    abort.current = new AbortController();
    try {
      await fundWallet(wallet, abort.current.signal);
      const b = await readBalance(wallet).catch(() => null);
      if (alive.current) {
        setBalance(b);
        setState("funded");
        onFunded();
      }
    } catch (e) {
      if (alive.current) {
        setState("failed");
        setError(
          e instanceof Error
            ? e.message
            : "Test funding could not be confirmed. Try again.",
        );
      }
    }
  }
  const demo = walletName === DEMO_WALLET;
  return (
    <Modal title="Test wallet setup" onClose={onClose}>
      <div className="dialog-heading">
        <h2>
          {state === "funded"
            ? "Test funds are ready"
            : state === "failed"
              ? "Test funds are not ready"
              : "Prepare your wallet"}
        </h2>
        <p>
          {state === "funded"
            ? "Your wallet has test USDC and devnet SOL. You can continue with the deposit."
            : "Add free test USDC for this demo. Swish pays the deposit's network fees."}
        </p>
      </div>
      <dl className="dialog-facts">
        <div>
          <dt>Wallet</dt>
          <dd>{shortAddress(wallet)}</dd>
        </div>
        <div>
          <dt>Test USDC</dt>
          <dd>
            {balance
              ? `${Number(balance.usdc).toFixed(2)} USDC`
              : state === "checking"
                ? "Checking…"
                : "Not available"}
          </dd>
        </div>
        <div>
          <dt>Devnet SOL</dt>
          <dd>
            {balance
              ? `${Number(balance.sol).toFixed(4)} SOL`
              : state === "checking"
                ? "Checking…"
                : "Not available"}
          </dd>
        </div>
      </dl>
      {state === "funded" ? (
        <p className="funded-note" role="status">
          ✓ Test funds confirmed
        </p>
      ) : (
        <Primary
          onClick={() => void fund()}
          busy={
            state === "funding"
              ? "Adding test funds"
              : state === "checking"
                ? "Checking wallet"
                : undefined
          }
        >
          {state === "failed" ? "Retry test funding" : "Get test USDC"}
        </Primary>
      )}
      <p className="fine">
        Each request adds 10 test USDC and 0.02 devnet SOL.
      </p>
      {!demo && (
        <div className="network-help">
          <h3>Use Solana Devnet in {walletName || "your wallet"}</h3>
          <p>
            The browser cannot always read your wallet's network. Check it
            before you approve setup.
          </p>
          <ol>
            {/phantom/i.test(walletName) ? (
              <>
                <li>Open Settings in Phantom.</li>
                <li>Choose Developer Settings.</li>
                <li>Turn on Testnet Mode and select Solana Devnet.</li>
              </>
            ) : (
              <>
                <li>Open your wallet's settings.</li>
                <li>Open its network or developer settings.</li>
                <li>Select Solana Devnet, then return here.</li>
              </>
            )}
          </ol>
        </div>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      <button className="secondary" onClick={onClose}>
        {state === "funded" ? "Continue setup" : "Continue anyway"}
      </button>
    </Modal>
  );
}

export function ResetDialog({
  names,
  working,
  error,
  onChoose,
  onClose,
}: {
  names: string[];
  working: boolean;
  error: string;
  onChoose(name: string): void;
  onClose(): void;
}) {
  return (
    <Modal title="Start over" onClose={onClose}>
      <div className="dialog-heading">
        <h2>Unlink your test wallet</h2>
        <p>
          Choose the wallet you set up. It signs once to cancel its Swish limit.
          Your device keeps the passkey.
        </p>
      </div>
      <div className="stack">
        {names.map((name) => (
          <button
            key={name}
            className="option"
            disabled={working}
            onClick={() => onChoose(name)}
          >
            {name}
            {working && <Spinner />}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="note error">
          {error}
        </p>
      )}
    </Modal>
  );
}
