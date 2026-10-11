import { useEffect, useRef, useState } from "react";
import { createApi, type DepositRef, type DepositResult } from "core/api";
import { demoPasskeys } from "./passkeys";
import { fromBase64, toBase64 } from "core/encoding";
import { unlockName } from "core/format";
import { WalletRejected, type ConnectedWallet } from "core/wallet";
import { DepositFlow, type Memory, type Screen } from "./widget/flow";
import {
  ScreenBody,
  WAITS,
  waitText,
  type Actions,
  type View,
} from "./widget/screens";
import { AmountBlock, Heading, Primary, TopBar, Spinner } from "./widget/ui";
import { createDemoWallets, DEMO_WALLET, type DemoStage } from "./demo-wallet";
import {
  createLink,
  deviceUrl,
  linkAction,
  readBalance,
  untilFundsAreSeen,
  type Config,
  type DeviceLink,
  type LinkStatus,
} from "./demo-api";
import { ApprovalDialog, FundingDialog, ResetDialog } from "./dialogs";
import { DeviceButton, QrCard } from "./device";
import { Page } from "./Page";
import { storyFor } from "./story";

type FundingRequest = { wallet: string; walletName: string; resolve(): void };
type ApprovalRequest = {
  wallet: string;
  resolve(): void;
  reject(): void;
  reset?: boolean;
};
type Remote = { token: string; device: string };

export function Session({
  config,
  deposit,
  memory,
  amount,
  remote,
  initialResult,
  shareFirst,
  onClose,
}: {
  config: Config;
  deposit: DepositRef;
  memory: Memory;
  amount: string;
  remote?: Remote;
  initialResult?: DepositResult;
  shareFirst?: boolean;
  onClose(result?: DepositResult): void;
}) {
  const [snapshot, setSnapshot] = useState<{ screen: Screen }>({
    screen: { name: "loading" },
  });
  const [stage, setStage] = useState<DemoStage>(null);
  const [funding, setFunding] = useState<FundingRequest | null>(null);
  const [fundingState, setFundingState] = useState("");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [chosenLimit, setChosenLimit] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [share, setShare] = useState<DeviceLink | null>(null);
  const [sharing, setSharing] = useState(!!shareFirst);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState("");
  const [linkStatus, setLinkStatus] = useState<LinkStatus | null>(null);
  const [expired, setExpired] = useState(false);
  const [reset, setReset] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const connected = useRef<ConnectedWallet | null>(null);
  const pendingFunding = useRef<FundingRequest | null>(null);
  const pendingApproval = useRef<ApprovalRequest | null>(null);
  const shown = useRef<Screen>({ name: "loading" });
  const mounted = useRef(true);
  const unlock = unlockName();

  function openFunds(
    wallet: ConnectedWallet | { address: string; name: string },
  ): Promise<void> {
    return new Promise((resolve) => {
      const request = {
        wallet: wallet.address,
        walletName: wallet.name,
        resolve,
      };
      pendingFunding.current = request;
      setFunding(request);
      setFundingState("checking");
    });
  }
  function askApproval(wallet: string, isReset = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = {
        wallet,
        reset: isReset,
        resolve,
        reject: () =>
          reject(new WalletRejected("You closed the wallet request.")),
      };
      pendingApproval.current = request;
      setApproval(request);
    });
  }
  const [api] = useState(() =>
    createApi(config.publishableKey, config.apiUrl, window.location.origin),
  );
  const [wallets] = useState(() =>
    createDemoWallets({
      amount: () => Number(amount),
      stage: setStage,
      connected: (wallet) => {
        connected.current = wallet;
        setWalletName(wallet.name);
      },
      approve: (wallet) => askApproval(wallet),
      prepare: (wallet) => openFunds(wallet),
    }),
  );
  const [flow] = useState(
    () =>
      new DepositFlow(deposit, {
        api,
        memory,
        wallets,
        passkeys: demoPasskeys(),
        beforeSetup: async (wallet) => {
          let balance = await readBalance(wallet.address).catch(() => null);
          if (!balance || Number(balance.usdc) < Number(amount)) {
            await openFunds(wallet);
            balance = await readBalance(wallet.address).catch(() => null);
          }
          // Only for a wallet that does hold the funds: one that does not
          // should hear so at once, not after a wait.
          if (balance && Number(balance.usdc) >= Number(amount))
            await untilFundsAreSeen(
              () => api.allowance("funds-check", wallet.address),
              Number(amount),
            );
        },
      }),
  );
  useEffect(() => {
    mounted.current = true;
    const stop = flow.onChange((screen) => setSnapshot({ screen }));
    if (initialResult) void flow.acceptResult(initialResult);
    else if (shareFirst) void openShare();
    else void flow.start();
    return () => {
      mounted.current = false;
      stop();
      flow.dispose();
      pendingApproval.current?.reject();
      pendingFunding.current?.resolve();
    };
  }, [flow]);

  useEffect(() => {
    if (snapshot.screen.name !== "wallets") return;
    const initial = wallets
      .list()
      .map((w) => w.name)
      .join("|");
    const timer = setInterval(() => {
      if (
        wallets
          .list()
          .map((w) => w.name)
          .join("|") !== initial
      )
        flow.listWallets();
    }, 1000);
    return () => clearInterval(timer);
  }, [snapshot.screen, wallets, flow]);

  const screen = snapshot.screen;
  if (!WAITS.has(screen.name)) shown.current = screen;
  const busy = waitText(screen, unlock);
  const locked = WAITS.has(screen.name) || !!approval || resetBusy;

  async function openShare() {
    if (remote) {
      // Release this device before showing the same link on another one.
      await flow.suspend();
      try {
        await linkAction(remote.token, "progress", {
          device: remote.device,
          phase: "release",
        });
        setSharing(true);
      } catch (e) {
        setShareError(
          e instanceof Error ? e.message : "The link could not be opened.",
        );
      }
      return;
    }
    await flow.suspend();
    setSharing(true);
    setShareBusy(true);
    setShareError("");
    setExpired(false);
    setLinkStatus(null);
    try {
      const link = await createLink(deposit);
      if (mounted.current) setShare(link);
    } catch (e) {
      if (mounted.current)
        setShareError(
          e instanceof Error ? e.message : "The link could not be created.",
        );
    } finally {
      if (mounted.current) setShareBusy(false);
    }
  }
  async function returnHere() {
    setShareError("");
    try {
      if (share)
        await linkAction(share.token, "cancel", { ownerKey: share.ownerKey });
      if (remote)
        await linkAction(remote.token, "open", { device: remote.device });
      setShare(null);
      setSharing(false);
      setExpired(false);
      setLinkStatus(null);
      await flow.start();
    } catch (e) {
      setShareError(
        e instanceof Error ? e.message : "The deposit could not be resumed.",
      );
    }
  }
  useEffect(() => {
    if (!share || !sharing) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await linkAction<LinkStatus>(share.token, "status", {
          ownerKey: share.ownerKey,
        });
        if (!live) return;
        setLinkStatus(status);
        setShareError("");
        if (
          status.result.status === "succeeded" ||
          status.result.status === "failed"
        ) {
          setSharing(false);
          await flow.acceptResult(status.result);
          return;
        }
      } catch (e) {
        if (!live) return;
        if (
          e &&
          typeof e === "object" &&
          "code" in e &&
          e.code === "link_expired"
        ) {
          setExpired(true);
          return;
        }
        setShareError(
          "The other device's status could not be read. Checking again…",
        );
      }
      if (live) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [share, sharing, flow]);
  useEffect(() => {
    if (
      !remote ||
      sharing ||
      screen.name === "succeeded" ||
      screen.name === "failed"
    )
      return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        await linkAction(remote.token, "progress", {
          device: remote.device,
          phase:
            screen.name === "sending" && screen.purpose === "pay"
              ? "sending"
              : "waiting",
        });
      } catch (e) {
        if (
          live &&
          e &&
          typeof e === "object" &&
          "code" in e &&
          ["link_expired", "link_in_use"].includes(String(e.code))
        ) {
          flow.dispose();
          setExpired(true);
          return;
        }
      }
      if (live) timer = setTimeout(check, 4000);
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [remote, sharing, screen.name, flow]);

  const view: View = {
    details: flow.details,
    wallet: flow.knownWallet,
    source: flow.source,
    sourcePending: flow.sourcePending,
    cluster: "devnet",
    unlock,
    walletName,
    chosenLimit,
    busy,
    demoStage: stage,
    connectingWallet: screen.name === "connecting" ? screen.wallet : undefined,
  };
  function close() {
    if (locked) return;
    if (share)
      void linkAction(share.token, "cancel", {
        ownerKey: share.ownerKey,
      }).catch(() => {});
    onClose(screen.name === "succeeded" ? screen.result : undefined);
  }
  async function fundingHelp(wallet?: string) {
    const target = wallet ?? connected.current?.address ?? flow.knownWallet;
    if (!target) return;
    await openFunds({
      address: target,
      name:
        connected.current?.address === target
          ? connected.current.name
          : (walletName ?? "your wallet"),
    });
    if (mounted.current) await flow.refreshSource();
  }
  const actions: Actions = {
    approve: () => void flow.approve(),
    verify: () => void flow.verify(),
    setUp: () => flow.setUp(),
    addToLimit: () => flow.addToLimit(),
    addWallet: () => flow.addWallet(),
    listWallets: () => {
      setStage(null);
      flow.listWallets();
    },
    pickWallet: (name) => {
      setWalletName(name);
      void flow.pickWallet(name);
    },
    chooseLimit: (limit) => {
      setChosenLimit(limit);
      void flow.chooseLimit(limit);
    },
    createPasskey: () => void flow.createPasskey(),
    selectWallet: (wallet) => flow.selectWallet(wallet),
    payFrom: () => void flow.payFrom(),
    retry: () => flow.retry(),
    close,
    fundWallet: (wallet) => void fundingHelp(wallet),
  };
  let guide = storyFor(screen, {
    remote: !!remote,
    known: !!view.wallet,
    source: view.source,
    sourcePending: view.sourcePending,
    amount: Number(amount),
    demoStage: stage,
    demo: walletName === DEMO_WALLET,
  });
  if (
    screen.name === "connecting" &&
    shown.current.name === "wallets" &&
    shown.current.purpose === "raise"
  )
    guide = 59;
  if (
    screen.name === "signing" &&
    shown.current.name === "limit" &&
    shown.current.purpose === "raise"
  )
    guide = 51;
  if (funding)
    guide =
      (
        {
          checking: 16,
          idle: 16,
          funding: 17,
          funded: 18,
          failed: 27,
        } as Record<string, number>
      )[fundingState] ?? 16;
  if (screen.name === "succeeded" && share) guide = 64;
  if (initialResult?.status === "succeeded") guide = 75;
  if (sharing)
    guide = remote
      ? 77
      : linkStatus?.phase === "sending"
        ? 63
        : linkStatus?.opened
          ? 62
          : 60;
  if (expired) guide = remote ? 76 : 65;
  const linkUrl = remote
    ? deviceUrl(remote.token, config.publicOrigin ?? location.origin)
    : share
      ? deviceUrl(share.token, config.publicOrigin ?? location.origin)
      : null;
  const remoteEntry =
    remote &&
    ((shown.current.name === "confirm" && !view.wallet) ||
      shown.current.name === "not_found");

  async function startOver(name: string) {
    setResetBusy(true);
    setResetError("");
    try {
      const wallet =
        connected.current?.name === name
          ? connected.current
          : await wallets.reconnect(name);
      if (wallet.address !== flow.knownWallet)
        throw new Error(
          "Choose the linked wallet, or switch accounts in your wallet and try again.",
        );
      const step = await api.unlinkWallet(wallet.address);
      if (!step.done) {
        const signed = await wallet.sign(fromBase64(step.transaction));
        await api.submitWalletTransaction(toBase64(signed), step.token);
      }
      memory.clear();
      onClose();
    } catch (e) {
      setResetError(
        e instanceof Error ? e.message : "The wallet could not be unlinked.",
      );
    } finally {
      if (mounted.current) setResetBusy(false);
    }
  }

  return (
    <Page
      screen={guide}
      amount={amount}
      walletName={walletName ?? "your wallet"}
      unlock={unlock}
      limitLeft={screen.name === "limit" ? screen.left : view.source?.left}
      left={
        guide === 45 ? (
          <button className="start-over" onClick={() => setReset(true)}>
            Start over
          </button>
        ) : undefined
      }
    >
      <div className="widget-slot swish">
        {expired ? (
          <div className="card">
            <Heading eyebrow="" title="This link is no longer valid">
              {remote
                ? "Open a new link from the original screen to continue this deposit."
                : "Get a new link, then open it on a device where your same passkey is available."}
            </Heading>
            <Primary
              onClick={
                remote
                  ? close
                  : () => {
                      onClose();
                    }
              }
            >
              Back to playground
            </Primary>
          </div>
        ) : sharing && linkStatus?.opened && !remote ? (
          <div className="card device-wait">
            <span className="phone-outline" aria-hidden="true">
              ▯
            </span>
            <h2>
              {linkStatus.phase === "sending"
                ? "Sending your deposit"
                : "Continue on your other device"}
            </h2>
            <p>
              Use your same passkey there. This screen will show the result.
            </p>
            <Spinner />
            {shareError && <p className="note error">{shareError}</p>}
            <button className="back-link" onClick={() => void returnHere()}>
              Continue on this device
            </button>
          </div>
        ) : sharing ? (
          <QrCard
            url={linkUrl}
            loading={shareBusy}
            error={shareError}
            onBack={() => void returnHere()}
          />
        ) : (
          <div className="card" aria-label="Swish deposit">
            <TopBar
              onClose={close}
              onBack={
                flow.canGoBack
                  ? () => {
                      setStage(null);
                      flow.back();
                    }
                  : undefined
              }
              locked={locked}
            />
            {remoteEntry ? (
              <>
                <AmountBlock
                  app={flow.details?.app.name ?? "Swish demo"}
                  line={`Deposit to ${flow.details?.app.name ?? "Swish demo"}`}
                  amount={amount}
                  token="USDC"
                />
                <p className="remote-intro">
                  Use your existing Swish passkey to find the wallet you linked
                  during setup.
                </p>
                {shown.current.name === "not_found" && (
                  <p className="note" role="status">
                    No Swish passkey was found on this device, or the prompt was
                    cancelled.
                  </p>
                )}
                <div className="actions">
                  <Primary onClick={actions.verify} busy={busy} faceId>
                    {shown.current.name === "not_found"
                      ? "Try again"
                      : "Use your Swish passkey"}
                  </Primary>
                  <p className="fine">
                    This step finds your wallets. It does not move funds.
                  </p>
                  {shown.current.name === "not_found" && (
                    <button
                      className="back-link"
                      onClick={() => void openShare()}
                    >
                      Use another device
                    </button>
                  )}
                </div>
              </>
            ) : (
              <ScreenBody screen={shown.current} v={view} a={actions} />
            )}
          </div>
        )}
      </div>
      {!sharing &&
        !expired &&
        !remote &&
        ["ready", "confirm"].includes(screen.name) &&
        !!view.wallet && (
          <DeviceButton disabled={locked} onClick={() => void openShare()} />
        )}
      {funding && (
        <FundingDialog
          wallet={funding.wallet}
          walletName={funding.walletName}
          amount={amount}
          onState={setFundingState}
          onClose={() => {
            pendingFunding.current = null;
            setFunding(null);
            funding.resolve();
          }}
          onFunded={() => void flow.refreshSource()}
        />
      )}
      {reset && !approval && !funding && (
        <ResetDialog
          names={wallets.list().map((w) => w.name)}
          working={resetBusy}
          error={resetError}
          onChoose={(name) => void startOver(name)}
          onClose={() => {
            if (!resetBusy) setReset(false);
          }}
        />
      )}
      {approval && (
        <ApprovalDialog
          wallet={approval.wallet}
          limit={chosenLimit ?? "1000"}
          step={screen.name === "signing" ? screen.done + 1 : 1}
          total={screen.name === "signing" ? screen.total : 1}
          reset={reset}
          onApprove={() => {
            pendingApproval.current = null;
            setApproval(null);
            approval.resolve();
          }}
          onReject={() => {
            pendingApproval.current = null;
            setApproval(null);
            approval.reject();
          }}
        />
      )}
    </Page>
  );
}
