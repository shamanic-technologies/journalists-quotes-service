import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
// Intentionally NOT importing "express-async-errors" here — we rely on the
// production entrypoint (src/index.ts) and tests/helpers/test-app.ts to install
// the polyfill globally. If they stop doing so, async route throws will crash
// the process again and these tests will fail.
import { createTestApp } from "../helpers/test-app.js";

function makeAppWithThrowingRoutes() {
  const app = express();

  app.get("/sync-throw", (_req, _res) => {
    throw new Error("sync boom");
  });

  app.get("/async-throw", async (_req, _res) => {
    throw new Error("async boom");
  });

  app.get("/async-reject", async (_req, _res) => {
    await Promise.reject(new Error("rejected boom"));
  });

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(500).json({ error: err.message });
    }
  );

  return app;
}

describe("async handler crash safety", () => {
  // Touch createTestApp so the test file transitively imports the polyfill
  // installed by tests/helpers/test-app.ts. If that import is removed in the
  // future, the async tests below will fail.
  void createTestApp;

  it("forwards sync throws to error middleware", async () => {
    const app = makeAppWithThrowingRoutes();
    const res = await request(app).get("/sync-throw");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "sync boom" });
  });

  it("forwards async throws to error middleware", async () => {
    const app = makeAppWithThrowingRoutes();
    const res = await request(app).get("/async-throw");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "async boom" });
  });

  it("forwards async promise rejections to error middleware", async () => {
    const app = makeAppWithThrowingRoutes();
    const res = await request(app).get("/async-reject");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "rejected boom" });
  });
});
