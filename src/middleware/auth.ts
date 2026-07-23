import { Request, Response, NextFunction } from "express";
import { createChildRun, closeRun } from "../lib/runs-client.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgId?: string;
      userId?: string;
      parentRunId?: string;
      runId?: string;
      campaignId?: string;
      brandId?: string;
      featureSlug?: string;
      workflowSlug?: string;
      audienceId?: string;
    }
  }
}

export function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey || apiKey !== process.env.JOURNALISTS_QUOTES_SERVICE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.userId = (req.headers["x-user-id"] as string | undefined) ?? undefined;
  req.parentRunId =
    (req.headers["x-run-id"] as string | undefined) ?? undefined;
  req.campaignId =
    (req.headers["x-campaign-id"] as string | undefined) ?? undefined;
  req.brandId = (req.headers["x-brand-id"] as string | undefined) ?? undefined;
  req.featureSlug =
    (req.headers["x-feature-slug"] as string | undefined) ?? undefined;
  req.workflowSlug =
    (req.headers["x-workflow-slug"] as string | undefined) ?? undefined;
  // x-audience-id: campaign-scoped audience attribution. Optional —
  // absent outside the campaign flux. Forwarded to siblings + runs-service
  // so per-audience cost attribution works (never throws when absent).
  req.audienceId =
    (req.headers["x-audience-id"] as string | undefined) ?? undefined;

  next();
}

/**
 * Verify request comes from a known sibling service.
 * Requires:
 *   - x-api-key matching JOURNALISTS_QUOTES_SERVICE_API_KEY
 *   - x-service-name matching one of the allowedServices
 */
export function requireServiceAuth(allowedServices: readonly string[]) {
  const allowed = new Set(allowedServices);
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (!apiKey || apiKey !== process.env.JOURNALISTS_QUOTES_SERVICE_API_KEY) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const serviceName = req.headers["x-service-name"] as string | undefined;
    if (!serviceName || !allowed.has(serviceName)) {
      res.status(401).json({ error: "Unauthorized: unknown calling service" });
      return;
    }
    next();
  };
}

export function requireOrgId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }
  req.orgId = orgId;
  next();
}

// Bound the pre-handler child-run creation so a cold/slow runs-service (Neon
// scale-to-zero + Railway cold-start) can never hang a request for the far
// upstream's whole client-timeout window (~60s). Applies to the WRITE path
// where the call is awaited; reads don't await at all (see below).
const RUNS_CREATE_TIMEOUT_MS = Number(
  process.env.RUNS_CREATE_TIMEOUT_MS ?? "3000"
);

export async function withRunTracking(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    req.runId = req.parentRunId ?? "00000000-0000-0000-0000-000000000000";
    next();
    return;
  }

  const taskName = `${req.method} ${req.path}`;

  // Pure GET reads declare NO cost — they must NEVER be gated on synchronous
  // run/cost tracking. Create the child run in the BACKGROUND (best-effort
  // attribution) and let the handler proceed immediately, so the read returns
  // promptly regardless of runs-service / compute cold-start state. If the run
  // resolves, close it on (or after) response finish; if runs-service is
  // cold/slow/unreachable, log and serve the read anyway (fail-open).
  if (req.method === "GET") {
    createChildRun(
      {
        parentRunId: req.parentRunId,
        serviceName: "journalists-quotes-service",
        taskName,
      },
      req.orgId,
      req.userId,
      req.audienceId,
      req.campaignId,
      req.brandId,
      req.featureSlug,
      RUNS_CREATE_TIMEOUT_MS
    )
      .then((run) => {
        req.runId = run.id;
        const closeIt = () => {
          const status = res.statusCode < 400 ? "completed" : "failed";
          closeRun(run.id, status, req.orgId, req.userId).catch((err) => {
            console.error(
              "[journalists-quotes-service] failed to close run:",
              err
            );
          });
        };
        if (res.writableEnded) closeIt();
        else res.on("finish", closeIt);
      })
      .catch((err) => {
        console.error(
          "[journalists-quotes-service] run-tracking skipped for read (runs-service cold/unavailable):",
          err
        );
      });

    next();
    return;
  }

  // Write/spend path: run + cost declaration is load-bearing → fail loud (502)
  // if it can't be recorded, but bound the call so a cold runs-service returns
  // a fast 502 (retryable) instead of hanging for the full client timeout.
  try {
    const run = await createChildRun(
      {
        parentRunId: req.parentRunId,
        serviceName: "journalists-quotes-service",
        taskName,
      },
      req.orgId,
      req.userId,
      req.audienceId,
      req.campaignId,
      req.brandId,
      req.featureSlug,
      RUNS_CREATE_TIMEOUT_MS
    );
    req.runId = run.id;
  } catch (err) {
    console.error("[journalists-quotes-service] runs-service unavailable:", err);
    res.status(502).json({ error: "runs-service unavailable" });
    return;
  }

  res.on("finish", () => {
    const status = res.statusCode < 400 ? "completed" : "failed";
    closeRun(req.runId!, status, req.orgId, req.userId).catch((err) => {
      console.error(
        "[journalists-quotes-service] failed to close run:",
        err
      );
    });
  });

  next();
}
