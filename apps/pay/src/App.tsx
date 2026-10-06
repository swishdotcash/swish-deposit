import { useEffect, useMemo, useRef, useState } from "react";

import type { DepositResult } from "core/api";
import type { DepositFlow, Screen } from "core/flow";
import { unlockName } from "core/format";
import type { Theme } from "core/protocol";
import type { Cluster } from "core/wallet";

import { ScreenBody, WAITS, waitText, type Actions, type View } from "./screens";
import { TopBar } from "./ui";

export interface Session {
  flow: DepositFlow;
  cluster: Cluster;
  theme: Theme;
}

/** Closing here would abandon something the wallet or the chain is doing. */
const LOCKED = new Set<Screen["name"]>(["sending", "signing"]);

/** How long the widget takes to leave; matches the closing animations in styles.css. */
const CLOSE_MS = 200;

export function App({ session, onClose }: { session: Session; onClose: (deposit: DepositResult | null) => void }) {
  const { flow, cluster, theme } = session;
  const [screen, setScreen] = useState<Screen>(flow.screen);
  // A wait keeps the screen before it on show.
  const shown = useRef<Screen>(flow.screen);
  const walletName = useRef<string | null>(null);
  const chosenLimit = useRef<string | null>(null);
  const [, redraw] = useState(0);

  useEffect(() => {
    setScreen(flow.screen);
    // The flow re-announces a screen when numbers behind it arrive.
    return flow.onChange((s) => {
      setScreen(s);
      redraw((n) => n + 1);
    });
  }, [flow]);

  if (!WAITS.has(screen.name)) shown.current = screen;
  const unlock = unlockName();
  const locked = LOCKED.has(screen.name);

  // The widget leaves the way it came: it fades and settles before the page gets its screen back.
  const [closing, setClosing] = useState(false);
  const leaving = useRef(false);
  const close = () => {
    if (LOCKED.has(flow.screen.name) || leaving.current) return;
    const last = flow.screen;
    const result = last.name === "succeeded" ? last.result : null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onClose(result);
    leaving.current = true;
    setClosing(true);
    setTimeout(() => onClose(result), CLOSE_MS);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const actions = useMemo<Actions>(
    () => ({
      approve: () => void flow.approve(),
      verify: () => void flow.verify(),
      setUp: () => flow.setUp(),
      addToLimit: () => flow.addToLimit(),
      addWallet: () => flow.addWallet(),
      listWallets: () => flow.listWallets(),
      pickWallet: (name) => {
        walletName.current = name;
        void flow.pickWallet(name);
      },
      chooseLimit: (amount) => {
        chosenLimit.current = amount;
        void flow.chooseLimit(amount);
      },
      createPasskey: () => void flow.createPasskey(),
      selectWallet: (wallet) => flow.selectWallet(wallet),
      payFrom: () => void flow.payFrom(),
      retry: () => flow.retry(),
      close: () => close(),
    }),
    // `close` reads the flow's live screen, so one set of actions serves the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flow],
  );

  const view: View = {
    details: flow.details,
    wallet: flow.knownWallet,
    source: flow.source,
    sourcePending: flow.sourcePending,
    cluster,
    unlock,
    walletName: walletName.current,
    chosenLimit: chosenLimit.current,
    busy: waitText(screen, unlock),
  };

  return (
    <div className="swish" data-theme={theme} data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="card" role="dialog" aria-modal="true" aria-label="Swish Deposit">
        <TopBar onClose={close} locked={locked} />
        <ScreenBody screen={shown.current} v={view} a={actions} />
      </div>
    </div>
  );
}
