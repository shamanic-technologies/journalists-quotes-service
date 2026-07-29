/**
 * Batch-size guard for bulk DB statements.
 *
 * The Postgres wire protocol (extended query, Bind message) caps a
 * SINGLE statement at 65,535 bind parameters; postgres.js rejects at
 * 65,534 with `MAX_PARAMETERS_EXCEEDED`. A bulk
 * `INSERT ... VALUES (...), (...), ...` binds one parameter per column
 * per row, so the row ceiling is `65534 / columnCount`.
 *
 * The widest bulk insert in this service is the silver upsert in
 * `opportunity-pipeline.ts` at 13 columns → it blew up at 5,042 rows
 * once the Featured premium catalog crossed ~5,100 questions (prod
 * incident 2026-07-29: every `/orgs/opportunities/next` 500'd).
 *
 * 500 rows × 13 columns = 6,500 parameters — 10× headroom over the
 * widest statement we issue, and small enough that a chunk failure
 * retries cheaply. Every bulk op here is idempotent (ON CONFLICT), so
 * splitting one statement into N is write-safe: a partial run re-applies
 * with no duplicate rows.
 */
export const DB_BULK_CHUNK_SIZE = 500;

/**
 * Split `rows` into consecutive batches of at most `size`. Order is
 * preserved. Returns `[]` for an empty input (callers can loop
 * unconditionally).
 */
export function chunkRows<T>(
  rows: readonly T[],
  size: number = DB_BULK_CHUNK_SIZE
): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(
      `[journalists-quotes-service] chunkRows: size must be a positive integer, got ${size}`
    );
  }
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
  }
  return batches;
}
