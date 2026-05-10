import { Router } from "express";
import { and, desc, eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { quoteRequests, quotePitches } from "../db/schema.js";
import { QuoteRequestListQuerySchema } from "../schemas.js";

const router = Router();

router.get("/orgs/quote-requests/stats", async (req, res) => {
  const orgId = req.orgId!;
  const campaignId = req.query.campaign_id as string | undefined;

  const [{ total }] = await db
    .select({ total: drizzleSql<number>`count(*)::int` })
    .from(quoteRequests)
    .where(eq(quoteRequests.orgId, orgId));

  const pitchCondition = campaignId
    ? and(
        eq(quotePitches.orgId, orgId),
        eq(quotePitches.campaignId, campaignId)
      )
    : eq(quotePitches.orgId, orgId);

  const pitchCounts = await db
    .select({
      status: quotePitches.status,
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(quotePitches)
    .where(pitchCondition)
    .groupBy(quotePitches.status);

  const byStatus: Record<string, number> = {};
  for (const row of pitchCounts) byStatus[row.status] = row.count;

  res.json({
    totalRequests: total ?? 0,
    totalPitched:
      (byStatus.submitted ?? 0) +
      (byStatus.selected ?? 0) +
      (byStatus.published ?? 0) +
      (byStatus.not_selected ?? 0),
    totalSelected: byStatus.selected ?? 0,
    totalPublished: byStatus.published ?? 0,
    totalNotSelected: byStatus.not_selected ?? 0,
  });
});

router.get("/orgs/quote-requests", async (req, res) => {
  const parsed = QuoteRequestListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const orgId = req.orgId!;
  const { source, limit, offset } = parsed.data;

  const conditions = [eq(quoteRequests.orgId, orgId)];
  if (source) conditions.push(eq(quoteRequests.source, source));

  const rows = await db
    .select()
    .from(quoteRequests)
    .where(and(...conditions))
    .orderBy(desc(quoteRequests.fetchedAt))
    .limit(limit)
    .offset(offset);

  res.json({ quoteRequests: rows });
});

router.get("/orgs/quote-requests/:id", async (req, res) => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "id must be a valid UUID" });
    return;
  }
  const orgId = req.orgId!;
  const { id } = req.params;
  const [row] = await db
    .select()
    .from(quoteRequests)
    .where(and(eq(quoteRequests.orgId, orgId), eq(quoteRequests.id, id)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Quote request not found" });
    return;
  }
  res.json({ quoteRequest: row });
});

export default router;
