import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { configureAnchor, programId } from "./program-config.js";

const id = programId();
configureAnchor(id);
const root = fileURLToPath(new URL("../", import.meta.url));
const program = fileURLToPath(new URL("../programs/swish-deposit/", import.meta.url));
const keypair = fileURLToPath(new URL("../target/deploy/swish_deposit-keypair.json", import.meta.url));
const hadKeypair = existsSync(keypair);
const env = { ...process.env, SWISH_PROGRAM_ID: id };

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("cargo-build-sbf", ["--tools-version", "v1.52", "--sbf-out-dir", "../../target/deploy"], program);
// cargo-build-sbf can make a new keypair. Deployment must use the keypair
// that matches SWISH_PROGRAM_ID, so do not leave a new, unrelated one here.
if (!hadKeypair) rmSync(keypair, { force: true });
if (process.argv.includes("--test")) run("cargo", ["test", "-p", "swish-deposit"], root);
