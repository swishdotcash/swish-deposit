/**
 * Creating a passkey in a small Swish window when it could not be created
 * inside the frame. A frame on someone else's page may only ask for a new
 * passkey within a few seconds of a tap; anything that opens first (a
 * password manager, say) uses that time up, and the browser then refuses. A
 * window of our own has no such limit. Approving a deposit stays in the frame.
 */
import { PasskeyDismissed, PasskeyUnsupported, type NewPasskey, type Passkeys } from "./passkey.js";
import type { Theme } from "./protocol.js";

/** What the window tells the frame that opened it. Both are on Swish's own site. */
export type PasskeyWindowMessage =
  | { swishPasskey: "created"; nonce: string; credentialId: string; publicKey: string }
  | { swishPasskey: "unsupported"; nonce: string; message: string };

const WIDTH = 420;
const HEIGHT = 560;

/**
 * `inFrame` approves deposits and makes the first attempt at a new passkey.
 * If that attempt comes to nothing, the next one opens the window.
 */
export function windowPasskeys(inFrame: Passkeys, pageUrl: string, theme: Theme): Passkeys {
  let useWindow = false;
  return {
    approve: (challenge, rpId) => inFrame.approve(challenge, rpId),

    // Call straight from a tap: browsers only open a window then.
    create(rpId) {
      if (!useWindow) {
        return inFrame.create(rpId).catch((e: unknown) => {
          if (e instanceof PasskeyDismissed) useWindow = true;
          throw e;
        });
      }
      const nonce = crypto.randomUUID();
      const url = `${pageUrl}?${new URLSearchParams({ rp: rpId, nonce, theme })}`;
      const left = Math.max(window.screenX + (window.outerWidth - WIDTH) / 2, 0);
      const top = Math.max(window.screenY + (window.outerHeight - HEIGHT) / 2, 0);
      const opened = window.open(url, "swish-passkey", `popup,width=${WIDTH},height=${HEIGHT},left=${left},top=${top}`);
      if (!opened) return inFrame.create(rpId);

      return new Promise<NewPasskey>((resolve, reject) => {
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
          const m = e.data as Partial<PasskeyWindowMessage> | null;
          if (!m || m.nonce !== nonce) return;
          if (m.swishPasskey === "created" && m.credentialId && m.publicKey) {
            const { credentialId, publicKey } = m;
            finish(() => resolve({ credentialId, publicKey }));
          } else if (m.swishPasskey === "unsupported") {
            finish(() => reject(new PasskeyUnsupported(m.message ?? "This browser does not support passkeys.")));
          }
        };
        window.addEventListener("message", onMessage);
        // Closed without an answer: the user gave up. A beat of grace, as the
        // window closes itself right after it answers.
        const watch = setInterval(() => {
          if (opened.closed) setTimeout(() => finish(() => reject(new PasskeyDismissed())), 300);
        }, 400);
      });
    },
  };
}
