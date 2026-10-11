import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { address, type Address } from "@solana/kit";
import { config } from "dotenv";

const root = new URL("../", import.meta.url);
const envFile = fileURLToPath(new URL("services/api/.env", root));

export function programId(): Address {
  config({ path: envFile, quiet: true });
  const value = process.env.SWISH_PROGRAM_ID;
  if (!value) throw new Error(`SWISH_PROGRAM_ID is not set. Add it to ${envFile}.`);
  try {
    return address(value);
  } catch {
    throw new Error("SWISH_PROGRAM_ID must be a Solana program address.");
  }
}

export function configureAnchor(id: Address): void {
  const template = readFileSync(new URL("Anchor.toml.example", root), "utf8");
  const output = template.replaceAll("__SWISH_PROGRAM_ID__", id);
  writeFileSync(new URL("Anchor.toml", root), output);
  console.log(`Anchor.toml uses ${id}`);
}
