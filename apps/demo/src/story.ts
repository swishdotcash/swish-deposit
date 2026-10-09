import type { Screen, Source } from "./widget/flow";
import type { DemoStage } from "./demo-wallet";

export function storyFor(
  screen: Screen,
  options: {
    remote: boolean;
    known: boolean;
    source: Source | null;
    sourcePending: boolean;
    amount: number;
    demoStage: DemoStage;
    demo: boolean;
  },
): number {
  const { remote, known, source, sourcePending, amount, demoStage, demo } =
    options;
  switch (screen.name) {
    case "loading":
      return 58;
    case "wallets":
      return screen.purpose === "raise"
        ? 49
        : demoStage === "failed"
          ? 24
          : screen.note
            ? 28
            : screen.wallets.length <= 1
              ? 31
              : 3;
    case "connecting":
      return demo
        ? { creating: 4, funding: 5, ready: 6, failed: 24 }[
            demoStage ?? "creating"
          ]
        : 15;
    case "limit":
      return screen.purpose === "raise"
        ? 50
        : Number(screen.balance ?? amount) < amount
          ? 23
          : 7;
    case "passkey":
      return screen.note ? 25 : 8;
    case "creating":
      return 9;
    case "signing":
      return screen.phase === "confirming"
        ? screen.done + 1 < screen.total
          ? 11
          : 13
        : demo
          ? screen.done === 0 && screen.total > 1
            ? 10
            : 12
          : screen.done === 0 && screen.total > 1
            ? 21
            : 22;
    case "setup_retry":
      return screen.reason === "funds"
        ? 30
        : screen.reason === "confirmation"
          ? 29
          : 26;
    case "not_found":
      return remote ? 73 : 55;
    case "approving":
      return screen.purpose === "verify"
        ? remote
          ? 67
          : 53
        : remote
          ? 70
          : 33;
    case "sending":
      return screen.purpose === "verify"
        ? remote
          ? 68
          : 54
        : remote
          ? 71
          : 34;
    case "source":
      return !screen.selected
        ? 47
        : screen.cancelled
          ? remote
            ? 74
            : 48
          : remote
            ? 69
            : 46;
    case "succeeded":
      return remote ? 72 : 35;
    case "failed":
      return /already finished/.test(screen.message)
        ? 44
        : screen.retry
          ? 42
          : 43;
    case "ready":
    case "confirm":
      if (!known) return remote ? 66 : 2;
      if (screen.name === "confirm" && screen.cancelled)
        return remote ? 74 : 36;
      if (screen.name === "confirm" && screen.note) return 37;
      if (sourcePending) return 40;
      if (!source) return 41;
      if (Number(source.balance) < amount) return 38;
      if (Number(source.left) < amount) return 39;
      return screen.name === "ready"
        ? screen.purpose === "raise"
          ? 52
          : 14
        : remote
          ? 69
          : 45;
  }
}
