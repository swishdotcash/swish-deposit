import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DemoError } from "./http.mjs";
import { PAYOUT, walletAddress } from "./funding-source.mjs";

// Save the signed transaction before broadcast. A retry checks the same transfer.
// There are no invite codes, wallet claim limits, or user accounts.
export function createFunding({ source, journalPath }) {
  let records;
  let queue = Promise.resolve();
  const serial = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  async function load() {
    if (records) return;
    try {
      records = JSON.parse(await readFile(journalPath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      records = {};
    }
  }
  async function save() {
    await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
    await writeFile(journalPath + ".tmp", JSON.stringify(records), {
      mode: 0o600,
    });
    await rename(journalPath + ".tmp", journalPath);
  }
  const view = (r) => ({
    id: r.id,
    wallet: r.wallet,
    status: r.status,
    signature: r.signature,
    usdc: PAYOUT.usdc,
    sol: PAYOUT.sol,
  });
  async function update(r) {
    if (r.status === "pending") {
      r.status = await source.inspect(r);
      await save();
    }
    return view(r);
  }
  return {
    status: () => source.status(),
    balances: async (wallet) => {
      const b = await source.balances(walletAddress(wallet));
      return {
        wallet,
        sol: String(Number(b.solLamports) / 1e9),
        usdc: String(Number(b.usdcUnits) / 1e6),
      };
    },
    claim: (wallet, id) =>
      serial(async () => {
        wallet = walletAddress(wallet);
        if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
          throw new DemoError(
            400,
            "bad_request_id",
            "Use a valid funding request ID.",
          );
        await load();
        const prior = records[id];
        if (prior) {
          if (prior.wallet !== wallet)
            throw new DemoError(
              409,
              "request_used",
              "This funding request belongs to another wallet.",
            );
          return update(prior);
        }
        // A new click must not create another transfer while this wallet has one pending.
        const pending = Object.values(records).find(
          (r) => r.wallet === wallet && r.status === "pending",
        );
        if (pending && (await update(pending)).status === "pending")
          return view(pending);
        const payout = await source.prepare(wallet);
        const r = (records[id] = {
          id,
          wallet,
          ...payout,
          status: "pending",
          createdAt: Date.now(),
        });
        await save();
        try {
          await source.send(r);
        } catch {
          /* It may have reached devnet. Inspect before retry. */
        }
        try {
          return await update(r);
        } catch {
          return view(r);
        }
      }),
    get: (id) =>
      serial(async () => {
        await load();
        const r = records[id];
        if (!r)
          throw new DemoError(
            404,
            "not_found",
            "This funding request was not found.",
          );
        return update(r);
      }),
  };
}
