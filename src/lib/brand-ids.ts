/**
 * Canonical form for brand_ids[]: deduplicated, sorted ascending. All
 * persistence and idempotency checks rely on this canonical form to make
 * (opportunity_id, brand_ids) array equality stable regardless of caller
 * input order.
 */
export function canonBrandIds(brandIds: string[]): string[] {
  return Array.from(new Set(brandIds)).sort();
}

/**
 * Parse the platform-convention `x-brand-id` header (CSV of UUIDs) into a
 * canonical brand_ids array. Throws BrandIdsHeaderError when missing or
 * empty — fail-loud, no silent default. UUID shape is validated to keep
 * downstream SQL safe.
 */
export class BrandIdsHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandIdsHeaderError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseBrandIdsHeader(
  raw: string | string[] | undefined
): string[] {
  if (raw == null) {
    throw new BrandIdsHeaderError("x-brand-id header is required");
  }
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new BrandIdsHeaderError("x-brand-id header is required");
  }
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      throw new BrandIdsHeaderError(
        `x-brand-id header value is not a UUID: ${id}`
      );
    }
  }
  return canonBrandIds(ids);
}
