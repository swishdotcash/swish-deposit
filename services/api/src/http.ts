import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const message = issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request";
    res.status(400).json({ error: { code: "invalid_request", message } });
    return;
  }
  console.error("[error]", err);
  res.status(500).json({ error: { code: "internal", message: "Something went wrong" } });
}
