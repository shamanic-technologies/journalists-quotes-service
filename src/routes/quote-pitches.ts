import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { quotePitches } from "../db/schema.js";
import { QuotePitchListQuerySchema } from "../schemas.js";

const router = Router();

router.get("/orgs/quote-pitches", async (req, res) => {
  const parsed = QuotePitchListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const orgId = req.orgId!;
  const { campaign_id, status, limit, offset } = parsed.data;

  const conditions = [eq(quotePitches.orgId, orgId)];
  if (campaign_id) conditions.push(eq(quotePitches.campaignId, campaign_id));
  if (status) conditions.push(eq(quotePitches.status, status));

  const rows = await db
    .select()
    .from(quotePitches)
    .where(and(...conditions))
    .orderBy(desc(quotePitches.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({ quotePitches: rows });
});

router.get("/orgs/quote-pitches/:id", async (req, res) => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "id must be a valid UUID" });
    return;
  }
  const orgId = req.orgId!;
  const { id } = req.params;
  const [row] = await db
    .select()
    .from(quotePitches)
    .where(and(eq(quotePitches.orgId, orgId), eq(quotePitches.id, id)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Quote pitch not found" });
    return;
  }
  res.json({ quotePitch: row });
});

export default router;
