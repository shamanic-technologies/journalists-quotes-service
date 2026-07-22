import "express-async-errors";
import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import {
  createOpportunitiesNextRouter,
  type OpportunitiesNextDeps,
} from "../../src/routes/opportunities-next.js";
import {
  createOpportunitiesDiscoverRouter,
  type OpportunitiesDiscoverDeps,
} from "../../src/routes/opportunities-discover.js";
import {
  createOpportunitiesRankedRouter,
  type OpportunitiesRankedDeps,
} from "../../src/routes/opportunities-ranked.js";
import {
  createOpportunityReplyRouter,
  type OpportunityReplyDeps,
} from "../../src/routes/opportunity-reply.js";
import quoteRequestsRoutes from "../../src/routes/quote-requests.js";
import {
  createQuotePitchesRouter,
  type QuotePitchesDeps,
} from "../../src/routes/quote-pitches.js";
import processInboundEmailsRoutes from "../../src/routes/process-inbound-emails.js";
import inboundEmailRoutes from "../../src/routes/webhooks/inbound-email.js";
import {
  apiKeyAuth,
  requireOrgId,
  withRunTracking,
} from "../../src/middleware/auth.js";
import { hmacVerify } from "../../src/middleware/hmac-verify.js";

export interface TestAppDeps {
  opportunitiesNextDeps?: OpportunitiesNextDeps;
  opportunitiesDiscoverDeps?: OpportunitiesDiscoverDeps;
  opportunitiesRankedDeps?: OpportunitiesRankedDeps;
  opportunityReplyDeps?: OpportunityReplyDeps;
  quotePitchesDeps?: QuotePitchesDeps;
  skipHmacVerify?: boolean;
}

export function createTestApp(deps: TestAppDeps = {}) {
  const app = express();
  app.use(cors());
  app.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(healthRoutes);

  if (!deps.skipHmacVerify) {
    app.use(
      "/webhooks/inbound-email",
      hmacVerify({ secretEnvVar: "JQS_INBOUND_HMAC_SECRET" })
    );
  }
  app.use(inboundEmailRoutes);

  app.use("/internal", apiKeyAuth);
  app.use(processInboundEmailsRoutes);

  app.use("/orgs", apiKeyAuth, requireOrgId, withRunTracking);
  app.use(createOpportunitiesNextRouter(deps.opportunitiesNextDeps));
  app.use(createOpportunitiesDiscoverRouter(deps.opportunitiesDiscoverDeps));
  app.use(createOpportunitiesRankedRouter(deps.opportunitiesRankedDeps));
  app.use(createOpportunityReplyRouter(deps.opportunityReplyDeps));
  app.use(quoteRequestsRoutes);
  app.use(createQuotePitchesRouter(deps.quotePitchesDeps));

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
export const TEST_BRAND_B = "00000000-0000-0000-0000-0000000000cd";
export const TEST_CAMPAIGN_A = "00000000-0000-0000-0000-0000000000d1";
export const TEST_CAMPAIGN_B = "00000000-0000-0000-0000-0000000000d2";

export const AUTH_HEADERS = {
  "x-api-key": "test-api-key",
  "x-org-id": TEST_ORG_A,
  "x-user-id": TEST_USER,
  "x-run-id": TEST_PARENT_RUN,
  "x-brand-id": TEST_BRAND,
  // /next + /discover require x-campaign-id. GET /orgs/opportunities +
  // /reply + /stats read campaignId from query/body and ignore this
  // header, so its presence in the shared default is inert for them.
  "x-campaign-id": TEST_CAMPAIGN_A,
};

export const AUTH_HEADERS_ORG_B = {
  ...AUTH_HEADERS,
  "x-org-id": TEST_ORG_B,
};
