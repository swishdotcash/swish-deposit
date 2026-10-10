/**
 * The window where Swish creates a passkey or approves a deposit. It asks the
 * device for the passkey, tells the widget, and closes.
 */
import "@fontsource-variable/jost";
import "./styles.css";

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { unlockName } from "core/format";
import { PasskeyUnsupported, browserPasskeys } from "core/passkey";
import type { PasskeyWindowMessage } from "core/passkeyWindow";

import { Logo, Primary } from "./ui";

const query = new URLSearchParams(location.search);
const action = query.get("action") === "approve" ? "approve" : "create";
const rpId = query.get("rp") ?? "";
const nonce = query.get("nonce") ?? "";
const challenge = query.get("challenge") ?? "";
const theme = query.get("theme") === "dark" ? "dark" : "light";
// Only the Swish frame that opened this window is ever told anything.
const opener = window.opener as Window | null;
const tell = (message: PasskeyWindowMessage) => opener?.postMessage(message, location.origin);

type State = { name: "asking" } | { name: "idle"; note?: string } | { name: "done" } | { name: "stray" };

function PasskeyWindow() {
  const [state, setState] = useState<State>(opener && rpId && nonce && (action === "create" || challenge) ? { name: "asking" } : { name: "stray" });
  const started = useRef(false);
  const unlock = unlockName();

  const ask = async () => {
    setState({ name: "asking" });
    try {
      if (action === "approve") {
        const approval = await browserPasskeys().approve(challenge, rpId);
        tell({ swishPasskey: "approved", nonce, ...approval });
      } else {
        const created = await browserPasskeys().create(rpId);
        tell({ swishPasskey: "created", nonce, ...created });
      }
      setState({ name: "done" });
      setTimeout(() => window.close(), 150);
    } catch (e) {
      // A closed prompt can be tried again in this window.
      if (!(e instanceof PasskeyUnsupported)) {
        return setState({ name: "idle", note: action === "approve" ? "Touch ID did not finish. Try again." : "The passkey was not created. Try again." });
      }
      tell({ swishPasskey: "unsupported", nonce, message: e.message });
      setState({ name: "idle", note: e.message });
    }
  };

  useEffect(() => {
    if (state.name !== "asking" || started.current) return;
    started.current = true;
    void ask();
    // Runs once: the window asks as soon as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="swish window" data-theme={theme}>
      <div className="card">
        <div className="top">
          <Logo />
        </div>
        <div className="heading">
          <h1 className="title">
            {state.name === "done"
              ? action === "approve"
                ? "Passkey approved"
                : "Passkey created"
              : action === "approve"
                ? "Approve with your passkey"
                : "Create your Swish ID"}
          </h1>
          <p className="lede">
            {state.name === "stray"
              ? "This window opens from a Swish deposit. You can close it."
              : state.name === "done"
                ? "This window closes by itself."
                : action === "approve"
                  ? `Use ${unlock} to approve the deposit shown in the Swish window. This window closes by itself.`
                  : `Approve with ${unlock} to create your passkey. This window closes by itself.`}
          </p>
        </div>
        {state.name === "idle" && state.note && (
          <p className="note" role="status" style={{ marginTop: 0 }}>
            {state.note}
          </p>
        )}
        {(state.name === "asking" || state.name === "idle") && (
          <div className="actions">
            <Primary onClick={() => void ask()} busy={state.name === "asking" ? `Waiting for ${unlock}` : undefined} faceId>
              {action === "approve" ? "Use passkey" : "Create passkey"}
            </Primary>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PasskeyWindow />);
