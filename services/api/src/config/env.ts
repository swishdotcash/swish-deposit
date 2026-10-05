import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  CLUSTER: z.enum(["devnet", "mainnet"]).default("devnet"),
  RPC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  SPONSOR_SECRET_KEY: z.string().min(1),
  USDC_MINT: z.string().min(32),
  RP_ID: z.string().min(1),
  SERVER_SECRET: z.string().regex(/^[0-9a-f]{64,}$/i, "32+ random bytes as hex"),
  /** Comma-separated, e.g. "https://pay.swish.cash". */
  FRAME_ORIGINS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
