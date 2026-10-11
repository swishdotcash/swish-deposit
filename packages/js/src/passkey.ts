/**
 * The user's Swish passkey, through the browser (WebAuthn). The passkey
 * belongs to one site (`rpId`); the API tells us which.
 */
import type { Approval } from "./api.js";
import { fromBase64Url, toBase64Url } from "./encoding.js";

/** The passkey request did not finish. This can include a blocked frame prompt. */
export class PasskeyDismissed extends Error {}

/** This browser or device cannot use passkeys. */
export class PasskeyUnsupported extends Error {}

export interface NewPasskey {
  credentialId: string;
  /** SPKI from the browser, base64url. */
  publicKey: string;
}

export interface Passkeys {
  /** Asks for Face ID over `challenge`. Call it straight from a tap. */
  approve(challenge: string, rpId: string): Promise<Approval>;
  create(rpId: string): Promise<NewPasskey>;
}

/** ES256 (P-256), the only curve the Solana program checks. */
const ES256 = -7;

const bytes = (b: ArrayBuffer) => new Uint8Array(b);
// WebAuthn wants its own ArrayBuffer, not a view on a shared one.
const buffer = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

const dismissed = (e: unknown) =>
  e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError");

export function browserPasskeys(): Passkeys {
  const credentials = () => {
    if (typeof navigator === "undefined" || !navigator.credentials || typeof PublicKeyCredential === "undefined") {
      throw new PasskeyUnsupported("This browser does not support passkeys.");
    }
    return navigator.credentials;
  };

  return {
    async approve(challenge, rpId) {
      let credential: Credential | null;
      try {
        credential = await credentials().get({
          publicKey: {
            challenge: buffer(fromBase64Url(challenge)),
            rpId,
            userVerification: "required",
            // Empty: any Swish passkey on this device, the user picks.
            allowCredentials: [],
          },
        });
      } catch (e) {
        if (dismissed(e)) throw new PasskeyDismissed();
        throw e;
      }
      if (!credential) throw new PasskeyDismissed();
      const c = credential as PublicKeyCredential;
      const r = c.response as AuthenticatorAssertionResponse;
      return {
        credentialId: toBase64Url(bytes(c.rawId)),
        authenticatorData: toBase64Url(bytes(r.authenticatorData)),
        clientDataJson: toBase64Url(bytes(r.clientDataJSON)),
        signature: toBase64Url(bytes(r.signature)),
      };
    },

    async create(rpId) {
      let credential: Credential | null;
      try {
        credential = await credentials().create({
          publicKey: {
            rp: { id: rpId, name: "Swish" },
            user: {
              id: buffer(crypto.getRandomValues(new Uint8Array(16))),
              name: "Swish ID",
              displayName: "Swish ID",
            },
            challenge: buffer(crypto.getRandomValues(new Uint8Array(32))),
            pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
            attestation: "none",
          },
        });
      } catch (e) {
        if (dismissed(e)) throw new PasskeyDismissed();
        throw e;
      }
      if (!credential) throw new PasskeyDismissed();
      const c = credential as PublicKeyCredential;
      const publicKey = (c.response as AuthenticatorAttestationResponse).getPublicKey();
      if (!publicKey) throw new PasskeyUnsupported("This device made a passkey Swish cannot use.");
      return { credentialId: toBase64Url(bytes(c.rawId)), publicKey: toBase64Url(bytes(publicKey)) };
    },
  };
}
