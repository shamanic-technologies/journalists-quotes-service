import * as Sentry from "@sentry/node";
// Patches Express 4 Router so async route throws/rejections propagate to the
// error middleware instead of becoming unhandledRejections that crash the
// process. Must be imported before any Router is created.
import "express-async-errors";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import healthRoutes from "./routes/health.js";
import opportunitiesNextRoutes from "./routes/opportunities-next.js";
import opportunitiesRankedRoutes from "./routes/opportunities-ranked.js";
import opportunityReplyRoutes from "./routes/opportunity-reply.js";
import quoteRequestsRoutes from "./routes/quote-requests.js";
import quoteRequestDraftRoutes from "./routes/quote-request-draft.js";
import quotePitchesRoutes from "./routes/quote-pitches.js";
import processInboundEmailsRoutes from "./routes/process-inbound-emails.js";
import inboundEmailRoutes from "./routes/webhooks/inbound-email.js";
import {
  apiKeyAuth,
  requireOrgId,
  withRunTracking,
} from "./middleware/auth.js";
import { hmacVerify } from "./middleware/hmac-verify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3050;

app.use(cors());
// Capture raw bytes alongside JSON parsing so HMAC verification can
// recompute the signature over the exact bytes that were signed.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = Buffer.from(buf);
    },
  })
);

const openapiPath = join(__dirname, "..", "openapi.json");
app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res
      .status(404)
      .json({ error: "OpenAPI spec not generated. Run: pnpm generate:openapi" });
  }
});

app.use(healthRoutes);

// /webhooks/inbound-email — HMAC-verified push from email-gateway-service
app.use(
  "/webhooks/inbound-email",
  hmacVerify({ secretEnvVar: "JQS_INBOUND_HMAC_SECRET" })
);
app.use(inboundEmailRoutes);

// /internal/* routes (api key only)
app.use("/internal", apiKeyAuth);
app.use(processInboundEmailsRoutes);

// /orgs/* routes (api key + org id + run tracking)
app.use("/orgs", apiKeyAuth, requireOrgId, withRunTracking);
app.use(opportunitiesNextRoutes);
app.use(opportunitiesRankedRoutes);
app.use(opportunityReplyRoutes);
app.use(quoteRequestDraftRoutes);
app.use(quoteRequestsRoutes);
app.use(quotePitchesRoutes);

app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: "Not found" });
});

Sentry.setupExpressErrorHandler(app);

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[journalists-quotes-service] unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("[journalists-quotes-service] migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(
          `[journalists-quotes-service] listening on port ${PORT}`
        );
      });
    })
    .catch((err) => {
      console.error("[journalists-quotes-service] migration failed:", err);
      process.exit(1);
    });
}

export default app;
