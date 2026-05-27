import { eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { quoteOpportunities } from "../../db/schema.js";

/**
 * Idempotently attach a silver provider_quote_requests row to (or create)
 * its Gold quote_opportunities cluster by fingerprint. Returns the Gold
 * cluster id and whether this call created it.
 */
export async function attachOrCreateCluster(input: {
  fingerprint: string;
  canonicalText: string;
  canonicalOutlet: string | null;
  canonicalDeadline: Date | null;
}): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .select({ id: quoteOpportunities.id })
    .from(quoteOpportunities)
    .where(eq(quoteOpportunities.fingerprint, input.fingerprint))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(quoteOpportunities)
      .set({ lastSeenAt: drizzleSql`now()` })
      .where(eq(quoteOpportunities.id, existing[0].id));
    return { id: existing[0].id, created: false };
  }

  const [row] = await db
    .insert(quoteOpportunities)
    .values({
      fingerprint: input.fingerprint,
      canonicalText: input.canonicalText,
      canonicalOutlet: input.canonicalOutlet,
      canonicalDeadline: input.canonicalDeadline,
      clusterMethod: "fingerprint",
    })
    .onConflictDoNothing({ target: quoteOpportunities.fingerprint })
    .returning({ id: quoteOpportunities.id });

  if (row) return { id: row.id, created: true };

  const refetch = await db
    .select({ id: quoteOpportunities.id })
    .from(quoteOpportunities)
    .where(eq(quoteOpportunities.fingerprint, input.fingerprint))
    .limit(1);
  return { id: refetch[0].id, created: false };
}
