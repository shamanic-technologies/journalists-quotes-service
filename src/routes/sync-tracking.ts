import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { quotePitches } from "../db/schema.js";
import {
  FeaturedClient,
  type FeaturedCredentials,
  type FeaturedClientOptions,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import { asyncHandler } from "../middleware/async-handler.js";

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

export function createSyncTrackingRouter(deps: SyncTrackingDeps = {}): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;
  const resolveCredentials =
    deps.resolveCredentials ?? (async () => getFeaturedCredentials("internal"));

  router.post("/internal/sync-tracking", asyncHandler(async (_req, res) => {
    const credentials = await resolveCredentials();
    const client = buildClient(credentials);

    const [selected, published, notSelected] = await Promise.all([
      client.listSelected(),
      client.listPublished(),
      client.listNotSelected(),
    ]);

    // Batch update: selected
    const selectedIds = selected.map((i) => i.featuredQuestionId);
    let selectedUpdated = 0;
    if (selectedIds.length > 0) {
      const result = await db
        .update(quotePitches)
        .set({ status: "selected", updatedAt: new Date() })
        .where(inArray(quotePitches.featuredQuestionId, selectedIds))
        .returning({ id: quotePitches.id });
      selectedUpdated = result.length;
    }

    // Batch update: published (status only), then individual articleUrl pass
    const publishedIds = published.map((i) => i.featuredQuestionId);
    let publishedUpdated = 0;
    if (publishedIds.length > 0) {
      const result = await db
        .update(quotePitches)
        .set({ status: "published", updatedAt: new Date() })
        .where(inArray(quotePitches.featuredQuestionId, publishedIds))
        .returning({ id: quotePitches.id });
      publishedUpdated = result.length;

      // Set articleUrl individually for items that have one
      for (const item of published) {
        if (item.articleUrl) {
          await db
            .update(quotePitches)
            .set({ featuredArticleUrl: item.articleUrl })
            .where(eq(quotePitches.featuredQuestionId, item.featuredQuestionId));
        }
      }
    }

    // Batch update: notSelected
    const notSelectedIds = notSelected.map((i) => i.featuredQuestionId);
    let notSelectedUpdated = 0;
    if (notSelectedIds.length > 0) {
      const result = await db
        .update(quotePitches)
        .set({ status: "not_selected", updatedAt: new Date() })
        .where(inArray(quotePitches.featuredQuestionId, notSelectedIds))
        .returning({ id: quotePitches.id });
      notSelectedUpdated = result.length;
    }

    res.json({ selectedUpdated, publishedUpdated, notSelectedUpdated });
  }));

  return router;
}

export default createSyncTrackingRouter();
