/**
 * Ask for deposit approval in a small Swish window. Some browsers do not show
 * a passkey prompt inside the frame. Passkey creation can also use the window.
 */
import type { Approval } from "./api.js";
import { PasskeyDismissed, PasskeyUnsupported, type NewPasskey, type Passkeys } from "./passkey.js";
import type { Theme } from "./protocol.js";

/** What the window tells the frame that opened it. Both are on Swish's own site. */
export type PasskeyWindowMessage =
  | { swishPasskey: "created"; nonce: string; credentialId: string; publicKey: string }
  | ({ swishPasskey: "approved"; nonce: string } & Approval)
  | { swishPasskey: "unsupported"; nonce: string; message: string };

const WIDTH = 420;
const HEIGHT = 560;

export class PasskeyWindowBlocked extends Error {}

/** Open during the tap, then accept only this window's answer for this request. */
function askInWindow<T>(
  pageUrl: string,
  theme: Theme,
  params: Record<string, string>,
  answer: (message: PasskeyWindowMessage) => T | null,
  whenBlocked: () => Promise<T>,
): Promise<T> {
  const nonce = crypto.randomUUID();
  const url = `${pageUrl}?${new URLSearchParams({ ...params, nonce, theme })}`;
  const left = Math.max(window.screenX + (window.outerWidth - WIDTH) / 2, 0);
  const top = Math.max(window.screenY + (window.outerHeight - HEIGHT) / 2, 0);
  const opened = window.open(url, "swish-passkey", `popup,width=${WIDTH},height=${HEIGHT},left=${left},top=${top}`);
  if (!opened) return whenBlocked();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(watch);
      settle();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== opened) return;
      const m = e.data as PasskeyWindowMessage | null;
      if (!m || m.nonce !== nonce) return;
      if (m.swishPasskey === "unsupported") {
        finish(() => reject(new PasskeyUnsupported(m.message ?? "This browser does not support passkeys.")));
        return;
      }
      const result = answer(m);
      if (result !== null) finish(() => resolve(result));
    };
    window.addEventListener("message", onMessage);
    // Give the answer a moment to arrive after the window closes.
    const watch = setInterval(() => {
      if (opened.closed) setTimeout(() => finish(() => reject(new PasskeyDismissed())), 300);
    }, 400);
  });
}

/** Ask for deposit approval on Swish's page, from the first tap. */
export function windowPasskeys(inFrame: Passkeys, pageUrl: string, theme: Theme): Passkeys {
  let createInWindow = false;
  return {
    approve(challenge, rpId) {
      return askInWindow<Approval>(
        pageUrl,
        theme,
        { action: "approve", rp: rpId, challenge },
        (m) =>
          m.swishPasskey === "approved" && m.credentialId && m.authenticatorData && m.clientDataJson && m.signature
            ? { credentialId: m.credentialId, authenticatorData: m.authenticatorData, clientDataJson: m.clientDataJson, signature: m.signature }
            : null,
        () => Promise.reject(new PasskeyWindowBlocked("Your browser blocked the Swish passkey window. Allow pop-ups for this page, then try again.")),
      );
    },

    create(rpId) {
      if (!createInWindow) {
        return inFrame.create(rpId).catch((e: unknown) => {
          if (e instanceof PasskeyDismissed) createInWindow = true;
          throw e;
        });
      }
      return askInWindow<NewPasskey>(
        pageUrl,
        theme,
        { action: "create", rp: rpId },
        (m) => (m.swishPasskey === "created" && m.credentialId && m.publicKey ? { credentialId: m.credentialId, publicKey: m.publicKey } : null),
        () => inFrame.create(rpId),
      );
    },
  };
}
