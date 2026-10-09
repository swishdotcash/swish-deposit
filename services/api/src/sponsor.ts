import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from "@solana/kit";

/** A JSON keypair, base58 secret, or file URL to a JSON keypair. */
export async function sponsorFromSecret(secret: string): Promise<KeyPairSigner> {
  const trimmed = secret.trim();
  const source = trimmed.startsWith("file:") ? (await readFile(fileURLToPath(trimmed), "utf8")).trim() : trimmed;
  const bytes = source.startsWith("[")
    ? Uint8Array.from(JSON.parse(source) as number[])
    : (getBase58Encoder().encode(source) as Uint8Array);
  return createKeyPairSignerFromBytes(bytes);
}
