import type { Approval } from "core/api";
import { fromBase64Url, toBase64Url } from "core/encoding";
import {
  browserPasskeys,
  PasskeyDismissed,
  PasskeyUnsupported,
  type Passkeys,
} from "core/passkey";

export interface DemoPasskeys extends Passkeys {
  approve(
    challenge: string,
    rpId: string,
    credentialId?: string,
  ): Promise<Approval>;
}

// Discovery can use any Swish passkey. Payment uses the passkey that found or
// linked the displayed wallet. Keep this change inside the demo.
export function demoPasskeys(): DemoPasskeys {
  const browser = browserPasskeys();
  return {
    create: browser.create,
    async approve(challenge, rpId, credentialId) {
      if (!credentialId) return browser.approve(challenge, rpId);
      if (
        typeof navigator === "undefined" ||
        !navigator.credentials ||
        typeof PublicKeyCredential === "undefined"
      ) {
        throw new PasskeyUnsupported("This browser does not support passkeys.");
      }
      try {
        const credential = (await navigator.credentials.get({
          publicKey: {
            challenge: fromBase64Url(challenge).slice().buffer as ArrayBuffer,
            rpId,
            userVerification: "required",
            allowCredentials: [
              {
                type: "public-key",
                id: fromBase64Url(credentialId).slice().buffer as ArrayBuffer,
              },
            ],
          },
        })) as PublicKeyCredential | null;
        if (!credential) throw new PasskeyDismissed();
        const response = credential.response as AuthenticatorAssertionResponse;
        return {
          credentialId: toBase64Url(new Uint8Array(credential.rawId)),
          authenticatorData: toBase64Url(
            new Uint8Array(response.authenticatorData),
          ),
          clientDataJson: toBase64Url(new Uint8Array(response.clientDataJSON)),
          signature: toBase64Url(new Uint8Array(response.signature)),
        };
      } catch (e) {
        if (
          e instanceof DOMException &&
          ["NotAllowedError", "AbortError"].includes(e.name)
        )
          throw new PasskeyDismissed();
        throw e;
      }
    },
  };
}
