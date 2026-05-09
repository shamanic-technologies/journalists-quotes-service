import { db, sql } from "../../src/db/index.js";
import {
  quoteRequests,
  quotePriorities,
  quotePitches,
  featuredProfiles,
} from "../../src/db/schema.js";

export async function cleanTestData() {
  await db.delete(quotePitches);
  await db.delete(quotePriorities);
  await db.delete(quoteRequests);
  await db.delete(featuredProfiles);
}

export async function closeDb() {
  await sql.end();
}
