import { randomUUID } from "node:crypto";

import type { TransactionSigner } from "@solana/kit";

import type { Chain } from "./chain/client.js";
import { appPda, registerAppInstruction, uuidBytes } from "./chain/program.js";
import type { Db } from "./db.js";
import { hashKey, newPublishableKey, newSecretKey } from "./keys.js";

export interface NewApp {
  name: string;
  website: string;
  contactEmail: string;
  allowedOrigins: string[];
  webhookUrl?: string;
}

/**
 * Registers an app on chain (the admin signs and pays the rent) and in the
 * database. The secret key is returned once and never stored.
 */
export async function registerApp(db: Db, chain: Pick<Chain, "sendAs">, admin: TransactionSigner, app: NewApp) {
  const id = randomUUID();
  const publishableKey = newPublishableKey();
  const secretKey = newSecretKey();
  const signature = await chain.sendAs(admin, [await registerAppInstruction(admin, uuidBytes(id))]);
  await db.query(
    `insert into apps (id, name, website, contact_email, allowed_origins, publishable_key, secret_key_hash, webhook_url)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, app.name, app.website, app.contactEmail, app.allowedOrigins, publishableKey, hashKey(secretKey), app.webhookUrl ?? null],
  );
  return { id, onChain: await appPda(uuidBytes(id)), publishableKey, secretKey, signature };
}
