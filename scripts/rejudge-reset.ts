/**
 * One-shot migration helper for the RAG → LLM-judge cutover.
 *
 * The prior scorer wrote 0-1 RAG similarity scores into
 * `quote_priorities`. The judge writes 0-100 relevance scores. Mixing
 * the two scales under the new threshold (30) would silently hide the
 * old rows. This script wipes the scored projection AND resets the
 * per-org EQRS cursor so the next `/next` calls re-pull the full EQRS
 * feed and re-judge from scratch.
 *
 * Both tables are JQS-local — no cross-service coordination needed.
 *
 * Run AFTER deploying the judge code:
 *   pnpm rejudge-reset
 *
 * Idempotent: safe to re-run (truncate of empty tables is a no-op).
 */
import { db, sql } from "../src/db/index.js";
import { quotePriorities, eqrsSyncState } from "../src/db/schema.js";

async function main() {
  const before = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(quotePriorities);
  const priorCount = before[0]?.n ?? 0;

  await db.delete(quotePriorities);
  await db.delete(eqrsSyncState);

  console.log(
    `[journalists-quotes-service] rejudge-reset complete — cleared ${priorCount} quote_priorities rows + reset eqrs_sync_state. Next /next calls re-pull EQRS + re-judge.`
  );
  await sql.end();
}

main().catch((err) => {
  console.error("[journalists-quotes-service] rejudge-reset failed:", err);
  process.exit(1);
});
