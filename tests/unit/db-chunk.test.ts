import { describe, it, expect } from "vitest";
import { chunkRows, DB_BULK_CHUNK_SIZE } from "../../src/lib/db-chunk.js";

/** postgres.js rejects a single statement above this many bind params. */
const PG_MAX_PARAMETERS = 65534;
/** Widest bulk insert in the service: the 13-column silver upsert. */
const WIDEST_INSERT_COLUMNS = 13;

describe("chunkRows", () => {
  it("splits an oversized batch into consecutive chunks preserving order", () => {
    const rows = Array.from({ length: 5100 }, (_, i) => i);
    const batches = chunkRows(rows, 500);

    expect(batches).toHaveLength(11);
    expect(batches.slice(0, 10).every((b) => b.length === 500)).toBe(true);
    expect(batches[10]).toHaveLength(100);
    expect(batches.flat()).toEqual(rows);
  });

  it("returns a single chunk when the batch fits", () => {
    expect(chunkRows([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });

  it("returns no chunks for an empty batch", () => {
    expect(chunkRows([], 500)).toEqual([]);
  });

  it("defaults to DB_BULK_CHUNK_SIZE", () => {
    const rows = Array.from({ length: DB_BULK_CHUNK_SIZE + 1 }, (_, i) => i);
    const batches = chunkRows(rows);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(DB_BULK_CHUNK_SIZE);
  });

  it("throws on a non-positive or non-integer size (fail loud)", () => {
    expect(() => chunkRows([1], 0)).toThrow();
    expect(() => chunkRows([1], -5)).toThrow();
    expect(() => chunkRows([1], 1.5)).toThrow();
  });

  it("keeps the widest bulk insert under the Postgres bind-parameter cap", () => {
    expect(DB_BULK_CHUNK_SIZE * WIDEST_INSERT_COLUMNS).toBeLessThan(
      PG_MAX_PARAMETERS
    );
  });
});
