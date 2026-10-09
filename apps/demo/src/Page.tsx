import type { ReactNode } from "react";
import { guideCopy } from "./guide-copy";
import { Logo } from "./widget/ui";
import usdcIcon from "./assets/usdc.svg";

export function Page({
  screen = 1,
  amount = "5",
  walletName = "Phantom",
  unlock = "Touch ID",
  limitLeft,
  left,
  children,
}: {
  screen?: number;
  amount?: string;
  walletName?: string;
  unlock?: string;
  limitLeft?: string;
  left?: ReactNode;
  children: ReactNode;
}) {
  const copy = guideCopy[screen] ?? guideCopy[1]!;
  const body = copy.body
    .replaceAll("5 USDC", `${amount} USDC`)
    .replaceAll("2 USDC", `${limitLeft ?? "0"} USDC`)
    .replaceAll("Phantom", walletName)
    .replaceAll("Touch ID", unlock)
    .replaceAll("Face ID", unlock);
  return (
    <div className="playground">
      <header className="page-header">
        <div className="brand">
          <Logo />
          <span>Swish Deposit</span>
          <span className="playground-tag">Playground</span>
        </div>
        <span className="network-label">
          <i />
          Solana Devnet
        </span>
      </header>
      <main className="page-body">
        <section className="story" aria-live="polite" aria-atomic="true">
          <div>
            <h1>{copy.title}</h1>
            <p>{body}</p>
            {left}
          </div>
          {[1, 2, 3, 31].includes(screen) && (
            <div className="free-funds">
              <img src={usdcIcon} width="22" height="22" alt="" />
              <span>Free test funds inside the widget.</span>
            </div>
          )}
        </section>
        <section className="demo-stage" aria-label="Try a deposit">
          <div className="stage-header">
            <span>Try a deposit</span>
            <span className="desktop-fees">Swish pays the network fees</span>
            <span className="mobile-fees">Swish pays the fees</span>
          </div>
          {children}
        </section>
      </main>
    </div>
  );
}
