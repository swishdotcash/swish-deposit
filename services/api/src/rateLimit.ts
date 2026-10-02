import type { RequestHandler } from "express";

import { HttpError } from "./http.js";

const WINDOW_MS = 60_000;

/**
 * At most `perMinute` requests per IP in any 60 s. In memory: one API
 * process. Behind Railway's proxy, `trust proxy` makes `req.ip` the caller.
 */
export function perIpLimit(perMinute: number, now: () => number = Date.now): RequestHandler {
  const hits = new Map<string, number[]>();
  return (req, res, next) => {
    const t = now();
    const ip = req.ip ?? "unknown";
    const recent = (hits.get(ip) ?? []).filter((h) => t - h < WINDOW_MS);
    if (recent.length >= perMinute) {
      res.set("Retry-After", String(Math.ceil((recent[0]! + WINDOW_MS - t) / 1000)));
      throw new HttpError(429, "rate_limited", "Too many requests. Try again in a minute.");
    }
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 10_000) {
      for (const [key, times] of hits) if (!times.some((h) => t - h < WINDOW_MS)) hits.delete(key);
    }
    next();
  };
}
