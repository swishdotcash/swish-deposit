/**
 * A browser's passkey (WebAuthn) result → the secp256r1 precompile
 * instruction the program reads (webauthn.rs). We also verify everything
 * here first, so a bad signature fails with a clear error instead of a
 * transaction we paid for.
 */
import { p256 } from "@noble/curves/nist.js";
import { type Instruction } from "@solana/kit";

import { SECP256R1_PROGRAM, sha256 } from "./program.js";

/** P-256 group order. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = N >> 1n;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

export class PasskeyError extends Error {}

export const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
export const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

/**
 * A passkey's public key as the program stores it: compressed (33 bytes).
 * Accepts what browsers give: `getPublicKey()` (SPKI DER), or a raw point.
 */
export function compressPublicKey(key: Uint8Array): Uint8Array {
  let point = key;
  // SPKI for P-256 is 91 bytes and ends with the 65-byte uncompressed point.
  if (key.length === 91) point = key.subarray(26);
  try {
    return p256.Point.fromBytes(point).toBytes(true);
  } catch {
    throw new PasskeyError("not a P-256 public key");
  }
}

const bigintTo32 = (n: bigint) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));

/**
 * WebAuthn returns an ASN.1 DER signature; the precompile wants r‖s, and the
 * runtime refuses a high-S one, so it is normalised (both S values are
 * equally valid ECDSA signatures).
 */
export function derToLowSCompact(der: Uint8Array): Uint8Array {
  let sig;
  try {
    sig = p256.Signature.fromBytes(der, "der");
  } catch {
    throw new PasskeyError("malformed signature");
  }
  const s = sig.s > HALF_N ? N - sig.s : sig.s;
  const out = new Uint8Array(64);
  out.set(bigintTo32(sig.r), 0);
  out.set(bigintTo32(s), 32);
  return out;
}

export interface Assertion {
  authenticatorData: Uint8Array;
  clientDataJson: Uint8Array;
  /** DER, as the browser returns it. */
  signature: Uint8Array;
}

/** Checks a Face ID approval exactly as the program will. Throws PasskeyError. */
export function verifyAssertion(
  publicKey: Uint8Array,
  a: Assertion,
  expected: { rpId: string; challenge: Uint8Array },
): { compactSignature: Uint8Array; message: Uint8Array } {
  if (a.authenticatorData.length < 37) throw new PasskeyError("malformed authenticator data");
  if (!Buffer.from(a.authenticatorData.subarray(0, 32)).equals(sha256(Buffer.from(expected.rpId)))) {
    throw new PasskeyError("the passkey signed for a different site");
  }
  const flags = a.authenticatorData[32]!;
  if (!(flags & FLAG_USER_PRESENT) || !(flags & FLAG_USER_VERIFIED)) {
    throw new PasskeyError("Face ID did not verify the user");
  }
  // The program matches this literal prefix; so do we.
  const prefix = `{"type":"webauthn.get","challenge":"${b64url(expected.challenge)}"`;
  if (!Buffer.from(a.clientDataJson).toString("utf8").startsWith(prefix)) {
    throw new PasskeyError("the passkey signed a different deposit");
  }
  const message = new Uint8Array(Buffer.concat([a.authenticatorData, sha256(a.clientDataJson)]));
  const compactSignature = derToLowSCompact(a.signature);
  if (!p256.verify(compactSignature, message, publicKey, { lowS: true })) {
    throw new PasskeyError("the signature is not from this passkey");
  }
  return { compactSignature, message };
}

/**
 * The secp256r1 precompile instruction: one signature, and its key, signature
 * and message all inside this instruction (index u16::MAX), as the program
 * requires.
 */
export function secp256r1Instruction(publicKey: Uint8Array, compactSignature: Uint8Array, message: Uint8Array): Instruction {
  const HEADER = 2;
  const OFFSETS = 14;
  const pubkeyOffset = HEADER + OFFSETS;
  const signatureOffset = pubkeyOffset + 33;
  const messageOffset = signatureOffset + 64;
  const data = Buffer.alloc(messageOffset + message.length);
  data.writeUInt8(1, 0); // one signature
  data.writeUInt8(0, 1); // padding
  const THIS = 0xffff;
  [signatureOffset, THIS, pubkeyOffset, THIS, messageOffset, message.length, THIS].forEach((v, i) =>
    data.writeUInt16LE(v, HEADER + i * 2),
  );
  data.set(publicKey, pubkeyOffset);
  data.set(compactSignature, signatureOffset);
  data.set(message, messageOffset);
  return { programAddress: SECP256R1_PROGRAM, accounts: [], data };
}
