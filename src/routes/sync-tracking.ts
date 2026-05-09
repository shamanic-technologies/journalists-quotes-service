import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { quotePitches } from "../db/schema.js";
import {
  FeaturedClient,
  type FeaturedCredentials,
  type FeaturedClientOptions,
} from "../lib/featured-client.js";

export interface SyncTrackingDeps {
  buildClient?: (
    credentials: FeaturedCredentials,
    overrides?: Partial<FeaturedClientOptions>
  ) => FeaturedClient;
  resolveCredentials?: () => Promise<FeaturedCredentials>;
}

function defaultBuildClient(
  credentials: FeaturedCredentials,
  overrides?: Partial<FeaturedClientOptions>
): FeaturedClient {
  return new FeaturedClient({ credentials, ...overrides });
}

function envCredentials(): FeaturedCredentials {
  const username = process.env.FEATURED_USERNAME;
  const password = process.env.FEATURED_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "FEATURED_USERNAME / FEATURED_PASSWORD env vars required for sync-tracking until key-service `featured` provider lands"
    );
  }
  return { username, password };
}

export function createSyncTrackingRouter(deps: SyncTrackingDeps = {}): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;
  const resolveCredentials = deps.resolveCredentials ?? (async () => envCredentials());

  router.post("/internal/sync-tracking", async (_req, res) => {
    const credentials = await resolveCredentials();
    const client = buildClient(credentials);

    const [selected, published, notSelected] = await Promise.all([
      client.listSelected(),
      client.listPublished(),
      client.listNotSelected(),
    ]);

    let selectedUpdated = 0;
    for (const item of selected) {
      const result = await db
        .update(quotePitches)
        .set({ status: "selected", updatedAt: new Date() })
        .where(eq(quotePitches.featuredQuestionId, item.featuredQuestionId))
        .returning({ id: quotePitches.id });
      selectedUpdated += result.length;
    }

    let publishedUpdated = 0;
    for (const item of published) {
      const result = await db
        .update(quotePitches)
        .set({
          status: "published",
          featuredArticleUrl: item.articleUrl ?? null,
          updatedAt: new Date(),
        })
        .where(eq(quotePitches.featuredQuestionId, item.featuredQuestionId))
        .returning({ id: quotePitches.id });
      publishedUpdated += result.length;
    }

    let notSelectedUpdated = 0;
    for (const item of notSelected) {
      const result = await db
        .update(quotePitches)
        .set({ status: "not_selected", updatedAt: new Date() })
        .where(eq(quotePitches.featuredQuestionId, item.featuredQuestionId))
        .returning({ id: quotePitches.id });
      notSelectedUpdated += result.length;
    }

    res.json({ selectedUpdated, publishedUpdated, notSelectedUpdated });
  });

  return router;
}

export default createSyncTrackingRouter();
