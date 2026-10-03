import { p256 } from "@noble/curves/nist.js";

import { sha256 } from "../src/chain/program.js";
import { b64url } from "../src/chain/webauthn.js";

/** A browser passkey, emulated: what `navigator.credentials.get` returns. */
export function fakePasskey() {
  const secret = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(secret, true);
  const spki = new Uint8Array([
    ...Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
    ...p256.getPublicKey(secret, false),
  ]);
  /**
   * `asChrome`: the client data as Chrome writes it, with `crossOrigin` and
   * the ~100 bytes of padding it adds to some approvals at random.
   */
  function assert(
    challenge: Uint8Array,
    opts: { rpId?: string; flags?: number; type?: string; highS?: boolean; asChrome?: boolean } = {},
  ) {
    const authenticatorData = new Uint8Array([...sha256(Buffer.from(opts.rpId ?? "localhost")), opts.flags ?? 0x05, 0, 0, 0, 1]);
    const clientDataJson = Buffer.from(
      JSON.stringify({
        type: opts.type ?? "webauthn.get",
        challenge: b64url(challenge),
        origin: "http://localhost:3000",
        ...(opts.asChrome
          ? {
              crossOrigin: false,
              other_keys_can_be_added_here: "do not compare clientDataJSON against a template. See https://goo.gl/yabPex",
            }
          : {}),
      }),
    );
    const message = Buffer.concat([authenticatorData, sha256(clientDataJson)]);
    let sig = p256.Signature.fromBytes(p256.sign(message, secret), "compact");
    if (opts.highS) sig = new p256.Signature(sig.r, p256.Point.Fn.ORDER - sig.s);
    return { authenticatorData, clientDataJson: new Uint8Array(clientDataJson), signature: sig.toBytes("der") };
  }
  return { publicKey, spki, assert };
}

