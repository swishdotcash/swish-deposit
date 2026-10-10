/**
 * The Swish frame. An app's page puts it over itself and tells it which
 * deposit to make; passkeys, wallets and what this browser remembers stay
 * in here, on Swish's own site.
 */
import "@fontsource-variable/jost";
import "./styles.css";

import { createRoot } from "react-dom/client";

import { createApi } from "core/api";
import { fromBase64, toBase64 } from "core/encoding";
import { DepositFlow } from "core/flow";
import { browserMemory } from "core/memory";
import { browserPasskeys } from "core/passkey";
import { windowPasskeys } from "core/passkeyWindow";
import { isMessage, type FromFrame, type ToFrame } from "core/protocol";
import { browserWallets } from "core/wallet";

import { App, type Session } from "./App";

const root = createRoot(document.getElementById("root")!);
const memory = browserMemory();
let session: (Session & { page: string }) | null = null;

const tell = (message: FromFrame, page: string) => window.parent.postMessage(message, page);

function open(m: Extract<ToFrame, { swish: "open" }>, page: string) {
  session?.flow.dispose();
  const theme = m.theme === "dark" ? "dark" : "light";
  const flow = new DepositFlow(
    { id: m.depositId, clientSecret: m.clientSecret },
    {
      // The API lets this frame in only for a page the app registered.
      api: createApi(m.publishableKey, m.apiUrl, page),
      // Approval opens a Swish window. Creation uses it if the frame fails.
      passkeys: windowPasskeys(browserPasskeys(), `${location.origin}/passkey.html`, theme),
      wallets: browserWallets(m.cluster),
      memory,
    },
  );
  // The flow shows its last screen again when the numbers behind it arrive; the page hears of a deposit once.
  let told = false;
  let known = false;
  flow.onChange((screen) => {
    // Their wallets are on show: the passkey has said who this is, so the page can know their wallet too.
    if (screen.name === "source" && !known) {
      known = true;
      tell({ swish: "known", wallet: memory.load()?.wallet ?? null }, page);
    }
    if (screen.name !== "succeeded" || told) return;
    told = true;
    tell({ swish: "succeeded", deposit: screen.result }, page);
  });
  session = { flow, cluster: m.cluster, theme, page };
  root.render(
    <App
      key={m.depositId}
      session={session}
      onClose={(deposit) => {
        session?.flow.dispose();
        session = null;
        root.render(null);
        tell({ swish: "closed", deposit }, page);
      }}
    />,
  );
  void flow.start();
}

async function unlink(m: Extract<ToFrame, { swish: "unlink" }>, page: string) {
  try {
    const api = createApi(m.publishableKey, m.apiUrl, page);
    const wallet = await browserWallets(m.cluster).connect(m.wallet);
    const step = await api.unlinkWallet(wallet.address);
    if (!step.done) {
      const signed = await wallet.sign(fromBase64(step.transaction));
      await api.submitWalletTransaction(toBase64(signed), step.token);
    }
    if (memory.load()?.wallet === wallet.address) memory.clear();
    tell({ swish: "unlinked", address: wallet.address }, page);
  } catch (e) {
    tell({ swish: "unlink_failed", message: e instanceof Error ? e.message : "The wallet was not unlinked." }, page);
  }
}

if (window.parent !== window) {
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !isMessage(e.data)) return;
    const m = e.data as ToFrame;
    if (m.swish === "open") open(m, e.origin);
    // Browsers keep this frame's storage apart for each site that embeds it,
    // so a page only ever hears about a wallet that was used on that same site.
    else if (m.swish === "known") tell({ swish: "known", wallet: memory.load()?.wallet ?? null }, e.origin);
    else if (m.swish === "unlink") void unlink(m, e.origin);
  });
  // Nothing private in this one, and the page's address is not known yet.
  window.parent.postMessage({ swish: "ready" } satisfies FromFrame, "*");
} else if (import.meta.env.DEV) {
  void import("./preview").then((p) => p.preview(root));
}
