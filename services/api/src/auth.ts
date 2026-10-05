import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AppRow, Deps } from "./context.js";
import { HttpError } from "./http.js";
import { PUBLISHABLE_PREFIX, SECRET_PREFIX, hashKey } from "./keys.js";

/** The app the request authenticated as. */
export function currentApp(res: Response): AppRow {
  return res.locals.app as AppRow;
}

const unauthorized = (message: string) => new HttpError(401, "unauthorized", message);

/** Server-to-server: `Authorization: Bearer swishsec_…`. */
export function requireSecretKey(deps: Deps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "")?.[1];
    if (!key?.startsWith(SECRET_PREFIX)) throw unauthorized("send your secret key as a Bearer token");
    const { rows } = await deps.db.query<AppRow>("select * from apps where secret_key_hash = $1", [hashKey(key)]);
    const app = rows[0];
    if (!app) throw unauthorized("unknown secret key");
    if (!app.active) throw new HttpError(403, "app_inactive", "this app is switched off");
    res.locals.app = app;
    next();
  };
}

/**
 * From the widget in a browser: `X-Swish-Key: swishpub_…`, and the page's
 * origin must be one the app registered. The widget runs in a Swish frame,
 * which names the page it was opened from in `X-Swish-App-Origin`.
 */
export function requirePublishableKey(deps: Deps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.get("x-swish-key") ?? "";
    if (!key.startsWith(PUBLISHABLE_PREFIX)) throw unauthorized("send your publishable key in X-Swish-Key");
    const { rows } = await deps.db.query<AppRow>("select * from apps where publishable_key = $1", [key]);
    const app = rows[0];
    if (!app) throw unauthorized("unknown publishable key");
    if (!app.active) throw new HttpError(403, "app_inactive", "this app is switched off");
    const origin = req.get("origin");
    const page = origin && deps.frameOrigins.includes(origin) ? (req.get("x-swish-app-origin") ?? "") : origin;
    if (page !== undefined && !app.allowed_origins.includes(page)) {
      throw new HttpError(403, "origin_not_allowed", `${page || "this page"} is not an allowed origin for this app`);
    }
    if (origin) res.set("Access-Control-Allow-Origin", origin).set("Vary", "Origin");
    res.locals.app = app;
    next();
  };
}

/**
 * Browsers preflight the widget's calls. We answer every origin here; the
 * real request is still refused unless the app registered that origin.
 */
export const corsPreflight: RequestHandler = (req, res, next) => {
  if (req.method !== "OPTIONS") return next();
  res
    .set("Access-Control-Allow-Origin", req.get("origin") ?? "*")
    .set("Access-Control-Allow-Methods", "GET, POST")
    .set("Access-Control-Allow-Headers", "Content-Type, X-Swish-Key, X-Swish-App-Origin")
    .set("Access-Control-Max-Age", "600")
    .set("Vary", "Origin")
    .status(204)
    .end();
};
