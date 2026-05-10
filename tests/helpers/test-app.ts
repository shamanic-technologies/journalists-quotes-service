import "express-async-errors";
import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import { createExpertQuoteRunsRouter, type ExpertQuoteRunsDeps } from "../../src/routes/expert-quote-runs.js";
import quoteRequestsRoutes from "../../src/routes/quote-requests.js";
import quotePitchesRoutes from "../../src/routes/quote-pitches.js";
import { createSyncTrackingRouter, type SyncTrackingDeps } from "../../src/routes/sync-tracking.js";
import inboundEmailRoutes from "../../src/routes/webhooks/inbound-email.js";
import {
  apiKeyAuth,
  requireOrgId,
  requireServiceAuth,
  withRunTracking,
} from "../../src/middleware/auth.js";

export interface TestAppDeps {
  expertQuoteRunsDeps?: ExpertQuoteRunsDeps;
  syncTrackingDeps?: SyncTrackingDeps;
}

export function createTestApp(deps: TestAppDeps = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(healthRoutes);

  app.use(
    "/webhooks",
    requireServiceAuth(["email-gateway-service"])
  );
  app.use(inboundEmailRoutes);

  app.use("/internal", apiKeyAuth);
  app.use(createSyncTrackingRouter(deps.syncTrackingDeps));

  app.use("/orgs", apiKeyAuth, requireOrgId, withRunTracking);
  app.use(createExpertQuoteRunsRouter(deps.expertQuoteRunsDeps));
  app.use(quoteRequestsRoutes);
  app.use(quotePitchesRoutes);

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error("[test-app] unhandled error:", err);
      res.status(500).json({ error: err.message });
    }
  );

  return app;
}

export const TEST_ORG_A = "00000000-0000-0000-0000-00000000000a";
export const TEST_ORG_B = "00000000-0000-0000-0000-00000000000b";
export const TEST_USER = "00000000-0000-0000-0000-0000000000aa";
export const TEST_PARENT_RUN = "00000000-0000-0000-0000-0000000000bb";
export const TEST_BRAND = "00000000-0000-0000-0000-0000000000cc";
export const TEST_CAMPAIGN_A = "00000000-0000-0000-0000-0000000000d1";
export const TEST_CAMPAIGN_B = "00000000-0000-0000-0000-0000000000d2";

export const AUTH_HEADERS = {
  "x-api-key": "test-api-key",
  "x-org-id": TEST_ORG_A,
  "x-user-id": TEST_USER,
  "x-run-id": TEST_PARENT_RUN,
};

export const AUTH_HEADERS_ORG_B = {
  ...AUTH_HEADERS,
  "x-org-id": TEST_ORG_B,
};
