import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PUBLISHABLE_PREFIX = "swishpub_";
export const SECRET_PREFIX = "swishsec_";
export const CLIENT_SECRET_PREFIX = "swishcs_";

const random = (bytes: number) => randomBytes(bytes).toString("base64url");

export const newPublishableKey = () => PUBLISHABLE_PREFIX + random(18);
export const newSecretKey = () => SECRET_PREFIX + random(32);
export const newClientSecret = () => CLIENT_SECRET_PREFIX + random(32);

/** Keys are 256-bit random, so a plain hash is enough to store and look them up. */
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
