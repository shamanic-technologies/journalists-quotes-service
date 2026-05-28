import { db, sql } from "../../src/db/index.js";
import {
  eqrsSyncState,
  inboundEmails,
  providerQuoteRequests,
  quoteOpportunities,
  quotePriorities,
  quotePitches,
} from "../../src/db/schema.js";

export async function cleanTestData() {
  await db.delete(quotePitches);
  await db.delete(quotePriorities);
  await db.delete(providerQuoteRequests);
  await db.delete(quoteOpportunities);
  await db.delete(inboundEmails);
  await db.delete(eqrsSyncState);
}

export async function closeDb() {
  await sql.end();
}
