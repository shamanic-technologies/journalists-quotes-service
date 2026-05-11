import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { featuredProfiles } from "../db/schema.js";
import type { FeaturedClient } from "./featured-client.js";
import { getBrand, getBrandLogo } from "./brand-client.js";

export interface FetchedLogo {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export type FetchLogoBytes = (url: string) => Promise<FetchedLogo>;

export async function defaultFetchLogoBytes(url: string): Promise<FetchedLogo> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch brand logo at ${url} (${response.status})`
    );
  }
  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = await response.arrayBuffer();
  const ext = contentType.split("/")[1]?.split(";")[0] || "png";
  return {
    bytes: new Uint8Array(buffer),
    contentType,
    filename: `brand-logo.${ext}`,
  };
}

/**
 * Resolve or lazily create a Featured profile for (orgId, brandId).
 * Requires a brand logo to upload as the profile image — fails loud if absent.
 */
export async function ensureFeaturedProfile(input: {
  orgId: string;
  brandId: string;
  userId?: string;
  runId?: string;
  client: FeaturedClient;
  fetchLogoBytes?: FetchLogoBytes;
}): Promise<{ featuredProfileId: number }> {
  const fetchLogo = input.fetchLogoBytes ?? defaultFetchLogoBytes;

  const existing = (
    await db
      .select()
      .from(featuredProfiles)
      .where(
        and(
          eq(featuredProfiles.orgId, input.orgId),
          eq(featuredProfiles.brandId, input.brandId)
        )
      )
      .limit(1)
  )[0];

  if (existing) {
    return { featuredProfileId: existing.featuredProfileId };
  }

  const brand = await getBrand(input.brandId, input.orgId, input.userId, input.runId);
  const logo = await getBrandLogo(
    input.brandId,
    input.orgId,
    input.userId,
    input.runId
  );
  if (!logo) {
    throw new Error(
      "Brand has no logo media asset; cannot create Featured profile"
    );
  }

  const { bytes, contentType, filename } = await fetchLogo(logo.permanentUrl);
  const form = new FormData();
  form.set("name", brand.name);
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  form.set("image", new Blob([ab], { type: contentType }), filename);
  const created = await input.client.createProfile(form);

  const [row] = await db
    .insert(featuredProfiles)
    .values({
      orgId: input.orgId,
      brandId: input.brandId,
      featuredProfileId: created.profileId,
    })
    .returning();

  return { featuredProfileId: row.featuredProfileId };
}
