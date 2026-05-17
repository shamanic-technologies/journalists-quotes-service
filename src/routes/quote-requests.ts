import { Router } from "express";
import { and, desc, eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  providerQuoteRequests,
  quotePitches,
  quotePriorities,
} from "../db/schema.js";
import { QuoteRequestListQuerySchema } from "../schemas.js";

const router = Router();

router.get("/orgs/quote-requests/stats", async (req, res) => {
  const orgId = req.orgId!;
  const campaignId = req.query.campaign_id as string | undefined;

  const [{ total }] = await db
    .select({ total: drizzleSql<number>`count(*)::int` })
    .from(providerQuoteRequests)
    .where(eq(providerQuoteRequests.orgId, orgId));

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
    totalPitched: byStatus.submitted ?? 0,
  });
});

router.get("/orgs/quote-requests", async (req, res) => {
  const parsed = QuoteRequestListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const orgId = req.orgId!;
  const { campaign_id, provider, ingestion_channel, limit, offset } =
    parsed.data;
  const limitN = limit ? Number(limit) : 100;
  const offsetN = offset ? Number(offset) : 0;

  const conditions = [eq(providerQuoteRequests.orgId, orgId)];
  if (provider) conditions.push(eq(providerQuoteRequests.provider, provider));
  if (ingestion_channel)
    conditions.push(
      eq(providerQuoteRequests.ingestionChannel, ingestion_channel)
    );

  if (campaign_id) {
    conditions.push(eq(quotePriorities.campaignId, campaign_id));
    const rows = await db
      .select({ row: providerQuoteRequests })
      .from(providerQuoteRequests)
      .innerJoin(
        quotePriorities,
        eq(quotePriorities.quoteRequestId, providerQuoteRequests.id)
      )
      .where(and(...conditions))
      .orderBy(desc(providerQuoteRequests.fetchedAt))
      .limit(limitN)
      .offset(offsetN);
    res.json({ providerQuoteRequests: rows.map((r) => r.row) });
    return;
  }

  const rows = await db
    .select()
    .from(providerQuoteRequests)
    .where(and(...conditions))
    .orderBy(desc(providerQuoteRequests.fetchedAt))
    .limit(limitN)
    .offset(offsetN);

  res.json({ providerQuoteRequests: rows });
});

router.get("/orgs/quote-requests/:id", async (req, res) => {
  const orgId = req.orgId!;
  const { id } = req.params;
  const [row] = await db
    .select()
    .from(providerQuoteRequests)
    .where(and(eq(providerQuoteRequests.orgId, orgId), eq(providerQuoteRequests.id, id)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Quote request not found" });
    return;
  }
  res.json({ quoteRequest: row });
});

export default router;
