import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from "@solana/kit";

/** A secret key as `solana-keygen` writes it (JSON byte array) or as base58. */
export function sponsorFromSecret(secret: string): Promise<KeyPairSigner> {
  const trimmed = secret.trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed) as number[])
    : (getBase58Encoder().encode(trimmed) as Uint8Array);
  return createKeyPairSignerFromBytes(bytes);
}
