import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mock the runs-client BEFORE importing the middleware so createChildRun /
// closeRun never hit the network.
const createChildRun = vi.fn();
const closeRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createChildRun: (...args: unknown[]) => createChildRun(...args),
  closeRun: (...args: unknown[]) => closeRun(...args),
}));

import { withRunTracking } from "../../src/middleware/auth.js";

type FinishCb = () => void;

function makeReqRes(method: string) {
  const finishCbs: FinishCb[] = [];
  const req = {
    method,
    path: "/orgs/quote-pitches",
    orgId: "org-1",
    userId: "user-1",
    parentRunId: "run-parent",
  } as unknown as Request;

  const res = {
    statusCode: 200,
    writableEnded: false,
    status: vi.fn(function (this: Response, code: number) {
      (res as unknown as { statusCode: number }).statusCode = code;
      return this;
    }),
    json: vi.fn(function (this: Response) {
      return this;
    }),
    on: vi.fn((event: string, cb: FinishCb) => {
      if (event === "finish") finishCbs.push(cb);
      return res;
    }),
  } as unknown as Response;

  const emitFinish = () => finishCbs.forEach((cb) => cb());
  return { req, res, emitFinish };
}

describe("withRunTracking", () => {
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    // Bypass the test short-circuit so the real run-tracking path is exercised.
    process.env.NODE_ENV = "development";
    createChildRun.mockReset();
    closeRun.mockReset();
    closeRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
  });

  it("GET: serves the read immediately even when runs-service hangs (never resolves)", async () => {
    // A cold runs-service: the child-run creation never settles.
    createChildRun.mockReturnValue(new Promise(() => {}));
    const { req, res } = makeReqRes("GET");
    const next = vi.fn() as unknown as NextFunction;

    await withRunTracking(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("GET: serves the read (fail-open) when runs-service rejects", async () => {
    createChildRun.mockRejectedValue(new Error("ECONNREFUSED"));
    const { req, res } = makeReqRes("GET");
    const next = vi.fn() as unknown as NextFunction;

    await withRunTracking(req, res, next);
    // Let the rejected background promise settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("GET: sets runId and closes the run on finish when runs-service is warm", async () => {
    createChildRun.mockResolvedValue({ id: "child-run-1" });
    const { req, res, emitFinish } = makeReqRes("GET");
    const next = vi.fn() as unknown as NextFunction;

    await withRunTracking(req, res, next);
    // Let the background run creation resolve so the finish handler registers.
    await new Promise((r) => setTimeout(r, 0));

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.runId).toBe("child-run-1");

    emitFinish();
    expect(closeRun).toHaveBeenCalledWith(
      "child-run-1",
      "completed",
      "org-1",
      "user-1"
    );
  });

  it("POST (write/spend): fails loud with 502 when runs-service is unavailable", async () => {
    createChildRun.mockRejectedValue(new Error("timed out"));
    const { req, res } = makeReqRes("POST");
    const next = vi.fn() as unknown as NextFunction;

    await withRunTracking(req, res, next);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(next).not.toHaveBeenCalled();
  });

  it("POST (write/spend): sets runId and proceeds when runs-service is warm", async () => {
    createChildRun.mockResolvedValue({ id: "child-run-2" });
    const { req, res } = makeReqRes("POST");
    const next = vi.fn() as unknown as NextFunction;

    await withRunTracking(req, res, next);

    expect(req.runId).toBe("child-run-2");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
