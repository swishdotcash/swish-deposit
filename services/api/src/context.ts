import type { Address } from "@solana/kit";

import type { Chain } from "./chain/client.js";
import type { Db } from "./db.js";

export interface Deps {
  db: Db;
  chain: Chain;
  /** The passkey site; must match the program's Config. */
  rpId: string;
  usdcMint: Address;
  /** Signs the setup transactions we hand out, so only ours come back. */
  serverSecret: Buffer;
  /** Sends webhooks. Injected so tests can watch them. */
  fetch: typeof fetch;
}

export interface AppRow {
  id: string;
  name: string;
  website: string;
  allowed_origins: string[];
  publishable_key: string;
  secret_key_hash: string;
  webhook_url: string | null;
  active: boolean;
}

export const USDC_DECIMALS = 6;
/** How long a Face ID approval stays valid (the program allows up to 120 s). */
export const SIGNATURE_LIFETIME_SECONDS = 90;
