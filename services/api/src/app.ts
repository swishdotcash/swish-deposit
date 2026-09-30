import express from "express";

import { corsPreflight } from "./auth.js";
import type { Deps } from "./context.js";
import { errorHandler } from "./http.js";
import { depositsRouter } from "./routes/deposits.js";
import { setupRouter } from "./routes/setup.js";

export function createApp(deps: Deps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(corsPreflight);
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(depositsRouter(deps));
  app.use(setupRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  });
  app.use(errorHandler);
  return app;
}
