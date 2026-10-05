/**
 * The window where a Swish passkey is created. The widget opens it, it asks
 * the device for the passkey, tells the widget, and closes.
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
const rpId = query.get("rp") ?? "";
const nonce = query.get("nonce") ?? "";
const theme = query.get("theme") === "dark" ? "dark" : "light";
// Only the Swish frame that opened this window is ever told anything.
const opener = window.opener as Window | null;
const tell = (message: PasskeyWindowMessage) => opener?.postMessage(message, location.origin);

type State = { name: "asking" } | { name: "idle"; note?: string } | { name: "done" } | { name: "stray" };

function PasskeyWindow() {
  const [state, setState] = useState<State>(opener && rpId && nonce ? { name: "asking" } : { name: "stray" });
  const started = useRef(false);
  const unlock = unlockName();

  const create = async () => {
    setState({ name: "asking" });
    try {
      const created = await browserPasskeys().create(rpId);
      tell({ swishPasskey: "created", nonce, ...created });
      setState({ name: "done" });
      setTimeout(() => window.close(), 150);
    } catch (e) {
      // Only a browser that cannot do passkeys at all ends the setup. Anything
      // else (the sheet was closed, this window is closing) can be tried again.
      if (!(e instanceof PasskeyUnsupported)) {
        return setState({ name: "idle", note: "The passkey was not created. Try again." });
      }
      tell({ swishPasskey: "unsupported", nonce, message: e.message });
      setState({ name: "idle", note: e.message });
    }
  };

  useEffect(() => {
    if (state.name !== "asking" || started.current) return;
    started.current = true;
    void create();
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
          <h1 className="title">{state.name === "done" ? "Passkey created" : "Create your Swish ID"}</h1>
          <p className="lede">
            {state.name === "stray"
              ? "This window opens from a Swish deposit. You can close it."
              : state.name === "done"
                ? "This window closes by itself."
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
            <Primary onClick={() => void create()} busy={state.name === "asking" ? `Waiting for ${unlock}` : undefined} faceId>
              Create passkey
            </Primary>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PasskeyWindow />);
