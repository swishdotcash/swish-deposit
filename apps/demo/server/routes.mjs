import { homedir } from "node:os";
import { resolve } from "node:path";
import { createFundingSource } from "./funding-source.mjs";
import { createFunding } from "./funding.mjs";
import { createHandoffs } from "./handoffs.mjs";
import { body, checkOrigin, DemoError, json } from "./http.mjs";

// This route group belongs only to the demo host. It does not proxy secret-key APIs.
export function demoRoutes({
  cluster,
  getDeposit,
  readDeposit,
  env = process.env,
  funding: suppliedFunding,
}) {
  const funding =
    suppliedFunding ??
    createFunding({
      source: createFundingSource({
        rpcUrl: env.DEMO_RPC_URL ?? "https://api.devnet.solana.com",
        keypairPath:
          env.DEMO_FUNDING_KEYPAIR_FILE ??
          resolve(homedir(), ".config/swish/devnet-bank.json"),
      }),
      journalPath:
        env.DEMO_FUNDING_JOURNAL ??
        resolve(homedir(), ".config/swish/demo-funding.json"),
    });
  const handoffs = createHandoffs({ getDeposit, readDeposit });
  return async (req, res, url) => {
    const path = url.pathname;
    if (!path.startsWith("/api/demo/")) return false;
    try {
      if (cluster !== "devnet")
        throw new DemoError(
          403,
          "devnet_only",
          "The playground uses Solana Devnet only.",
        );
      checkOrigin(req, env.DEMO_PUBLIC_ORIGIN);
      if (req.method === "GET" && path === "/api/demo/funding/status")
        json(res, 200, await funding.status());
      else if (req.method === "POST" && path === "/api/demo/funding/claims") {
        const input = await body(req);
        json(res, 200, await funding.claim(input?.wallet, input?.id));
      } else if (
        req.method === "GET" &&
        /^\/api\/demo\/funding\/claims\/[0-9a-f-]{36}$/i.test(path)
      ) {
        json(res, 200, await funding.get(path.split("/").at(-1)));
      } else if (
        req.method === "GET" &&
        /^\/api\/demo\/wallets\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(path)
      ) {
        json(res, 200, await funding.balances(path.split("/").at(-1)));
      } else if (req.method === "POST" && path === "/api/demo/handoffs") {
        json(res, 201, handoffs.create(await body(req)));
      } else {
        const match =
          /^\/api\/demo\/handoffs\/([\w-]{43})\/(open|status|progress|cancel)$/.exec(
            path,
          );
        if (req.method !== "POST" || !match)
          throw new DemoError(
            404,
            "not_found",
            "This demo route was not found.",
          );
        const [, key, action] = match;
        const input = await body(req);
        const response =
          action === "open"
            ? await handoffs.open(key, input?.device)
            : action === "status"
              ? await handoffs.status(key, input?.ownerKey)
              : action === "progress"
                ? handoffs.progress(key, input?.device, input?.phase)
                : handoffs.cancel(key, input?.ownerKey);
        json(res, 200, response);
      }
    } catch (e) {
      json(res, e instanceof DemoError ? e.status : 503, {
        error: {
          code: e instanceof DemoError ? e.code : "demo_unavailable",
          message:
            e instanceof DemoError
              ? e.message
              : "The demo service could not finish this request. Try again.",
        },
      });
    }
    return true;
  };
}
