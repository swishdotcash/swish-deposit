import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { test } from "node:test";

test("malformed request paths return 400 without terminating the frame server", { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited: ${code}`)));
    child.stdout.on("data", (data) => {
      const match = /frame on :(\d+)/.exec(String(data));
      if (match) resolve(Number(match[1]));
    });
  });
  const read = (path) => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  for (const path of ["/%ZZ", "/%E0%A4%A", "/%00"]) {
    assert.equal(await read(path), 400);
    assert.equal(await read("/health"), 200);
  }
  assert.equal(child.exitCode, null);
});
