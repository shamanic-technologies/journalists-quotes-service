import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import {
  createTestApp,
  AUTH_HEADERS,
  AUTH_HEADERS_ORG_B,
  TEST_BRAND,
  TEST_CAMPAIGN_A,
  TEST_ORG_A,
} from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { providerQuoteRequests } from "../../src/db/schema.js";
import {
  ExpertQuotePitchLengthError,
  type GenerateExpertQuotePitchRequest,
  type ContentGenerationCallerIdentity,
} from "../../src/lib/content-generation-client.js";
import {
  BrandServiceError,
  type ExtractFieldsResponse,
} from "../../src/lib/brand-client.js";
import { SHARED_EMAIL_ORG_ID } from "../../src/lib/inbound/process.js";

interface CapturedCall {
  request: GenerateExpertQuotePitchRequest;
  identity: ContentGenerationCallerIdentity;
}

interface CapturedExtract {
  brandIds: string[];
  fields: { key: string; description: string }[];
}

function brandFieldsResponse(values: Record<string, string>): ExtractFieldsResponse {
  const fields: ExtractFieldsResponse["fields"] = {};
  for (const [k, v] of Object.entries(values)) {
    fields[k] = {
      value: v,
      byBrand: {
        "test-brand.com": {
          value: v,
          cached: true,
          extractedAt: "2026-05-27T00:00:00.000Z",
          expiresAt: null,
          sourceUrls: null,
        },
      },
    };
  }
  return {
    brands: [
      {
        brandId: "00000000-0000-0000-0000-0000000000cc",
        domain: "test-brand.com",
        name: "Test Brand",
        brandUrl: "https://test-brand.com",
      },
    ],
    fields,
  };
}

describe("POST /orgs/quote-requests/:id/draft", () => {
  beforeAll(async () => {
    await cleanTestData();
  });
  beforeEach(async () => {
    await cleanTestData();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function appWithStub(stub: {
    success?: {
      pitch: string;
      charCount: number;
      attempts: number;
      tokensInput: number;
      tokensOutput: number;
    };
    lengthError?: {
      error: string;
      charCount: number;
      minChars: number;
      maxChars: number;
      attempts: number;
    };
    captured?: CapturedCall[];
    extractFieldsResponse?: ExtractFieldsResponse;
    extractFieldsError?: Error;
    capturedExtract?: CapturedExtract[];
  }) {
    return createTestApp({
      quoteRequestDraftDeps: {
        generateExpertQuotePitch: async (request, identity) => {
          stub.captured?.push({ request, identity });
          if (stub.lengthError) {
            throw new ExpertQuotePitchLengthError(stub.lengthError);
          }
          if (stub.success) return stub.success;
          throw new Error("no stub configured");
        },
        extractFields: async (args) => {
          stub.capturedExtract?.push(args);
          if (stub.extractFieldsError) throw stub.extractFieldsError;
          if (stub.extractFieldsResponse) return stub.extractFieldsResponse;
          throw new Error("no extractFields stub configured");
        },
      },
    });
  }

  async function seedRow(overrides: Partial<typeof providerQuoteRequests.$inferInsert> = {}) {
    const [row] = await db
      .insert(providerQuoteRequests)
      .values({
        provider: "haro",
        ingestionChannel: "email",
        externalId: `ext-${Math.random()}`,
        opportunityText: "Looking for an ergonomics expert with data on remote work",
        mediaOutlet: "Lifehacker",
        journalistName: "Jane Doe",
        deadline: new Date("2099-01-01T00:00:00Z"),
        orgId: TEST_ORG_A,
        ...overrides,
      })
      .returning();
    return row;
  }

  it("returns drafted pitch and forwards identity to content-generation", async () => {
    const row = await seedRow();
    const captured: CapturedCall[] = [];

    const res = await request(
      appWithStub({
        captured,
        success: {
          pitch: "x".repeat(500),
          charCount: 500,
          attempts: 1,
          tokensInput: 30,
          tokensOutput: 200,
        },
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS)
      .set("x-workflow-slug", "test-wf")
      .set("x-feature-slug", "test-feat")
      .send({
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
        spokesperson: "Jane Doe, CEO",
        expertiseTopics: "ergonomics, remote work",
        responseStyle: "direct, data-driven",
        companyContext: "ErgoCorp — founded 2022, 500 customers",
        valueProposition: "Proprietary remote-work ergonomics dataset",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pitch: "x".repeat(500),
      charCount: 500,
      attempts: 1,
      tokensInput: 30,
      tokensOutput: 200,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].request).toEqual({
      variables: {
        brands: [
          {
            name: "Jane Doe, CEO",
            industry: "ErgoCorp — founded 2022, 500 customers",
            expertise: "ergonomics, remote work",
            voice: "direct, data-driven",
            targetAudience: "Proprietary remote-work ergonomics dataset",
          },
        ],
        request: {
          question: row.opportunityText,
          mediaOutlet: row.mediaOutlet,
          source: row.journalistName,
          deadline: "2099-01-01T00:00:00.000Z",
        },
        additionalContext:
          "ErgoCorp — founded 2022, 500 customers\n\nProprietary remote-work ergonomics dataset",
      },
      brandIds: [TEST_BRAND],
      campaignId: TEST_CAMPAIGN_A,
      workflowSlug: "test-wf",
      featureSlug: "test-feat",
    });

    expect(captured[0].identity).toMatchObject({
      orgId: TEST_ORG_A,
      brandId: TEST_BRAND,
      campaignId: TEST_CAMPAIGN_A,
      workflowSlug: "test-wf",
      featureSlug: "test-feat",
    });
  });

  it("uses caller-supplied additionalContext when provided", async () => {
    const row = await seedRow();
    const captured: CapturedCall[] = [];
    await request(
      appWithStub({
        captured,
        success: {
          pitch: "x".repeat(200),
          charCount: 200,
          attempts: 1,
          tokensInput: 10,
          tokensOutput: 50,
        },
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS)
      .send({
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
        spokesperson: "Jane",
        expertiseTopics: "topics",
        responseStyle: "style",
        companyContext: "context",
        valueProposition: "value",
        additionalContext: "user-supplied extra",
      });

    expect(captured[0].request.variables).toMatchObject({
      additionalContext: "user-supplied extra",
    });
  });

  it("404s when the quote-request row does not exist for the org", async () => {
    const row = await seedRow();

    const res = await request(
      appWithStub({
        success: {
          pitch: "x".repeat(200),
          charCount: 200,
          attempts: 1,
          tokensInput: 1,
          tokensOutput: 1,
        },
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS_ORG_B)
      .send({
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
        spokesperson: "x",
        expertiseTopics: "x",
        responseStyle: "x",
        companyContext: "x",
        valueProposition: "x",
      });

    expect(res.status).toBe(404);
  });

  it("returns 400 with length-error passthrough fields", async () => {
    const row = await seedRow();

    const res = await request(
      appWithStub({
        lengthError: {
          error: "pitch length out of range",
          charCount: 50,
          minChars: 100,
          maxChars: 2500,
          attempts: 2,
        },
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS)
      .send({
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
        spokesperson: "x",
        expertiseTopics: "x",
        responseStyle: "x",
        companyContext: "x",
        valueProposition: "x",
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "pitch length out of range",
      charCount: 50,
      minChars: 100,
      maxChars: 2500,
      attempts: 2,
    });
  });

  it("brand-only body { brandId } resolves PR fields via brand-service extract-fields and forwards them as generation inputs", async () => {
    const row = await seedRow();
    const captured: CapturedCall[] = [];
    const capturedExtract: CapturedExtract[] = [];

    const res = await request(
      appWithStub({
        captured,
        capturedExtract,
        success: {
          pitch: "y".repeat(400),
          charCount: 400,
          attempts: 1,
          tokensInput: 20,
          tokensOutput: 150,
        },
        extractFieldsResponse: brandFieldsResponse({
          spokesperson: "Brand Spokes, Founder",
          expertiseTopics: "remote-work, productivity",
          responseStyle: "concise, data-led",
          companyContext: "TestBrand — founded 2024, 100 customers",
          valueProposition: "first telemetry-grade remote-work coach",
        }),
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS)
      .send({ brandId: TEST_BRAND });

    expect(res.status).toBe(200);
    expect(res.body.pitch).toBe("y".repeat(400));

    expect(capturedExtract).toHaveLength(1);
    expect(capturedExtract[0].brandIds).toEqual([TEST_BRAND]);
    const keysSent = capturedExtract[0].fields.map((f) => f.key).sort();
    expect(keysSent).toEqual([
      "companyContext",
      "expertiseTopics",
      "responseStyle",
      "spokesperson",
      "valueProposition",
    ]);
    for (const f of capturedExtract[0].fields) {
      expect(f.description.length).toBeGreaterThan(10);
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].request.variables).toMatchObject({
      brands: [
        {
          name: "Brand Spokes, Founder",
          industry: "TestBrand — founded 2024, 100 customers",
          expertise: "remote-work, productivity",
          voice: "concise, data-led",
          targetAudience: "first telemetry-grade remote-work coach",
        },
      ],
    });
    expect(captured[0].request.campaignId).toBeUndefined();
    expect(captured[0].identity.campaignId).toBeUndefined();
  });

  it("brand-only body: 502 when brand-service returns a non-2xx response", async () => {
    const row = await seedRow();

    const res = await request(
      appWithStub({
        extractFieldsError: new BrandServiceError(
          500,
          "brand-service POST /internal/brands/extract-fields failed (500): boom",
          "boom"
        ),
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS)
      .send({ brandId: TEST_BRAND });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/extract-fields/);
  });

  it("brand-only body: 502 when brand-service returns an empty value for a required field", async () => {
    const row = await seedRow();

    const res = await request(
      appWithStub({
        extractFieldsResponse: brandFieldsResponse({
          // spokesperson omitted intentionally to trigger fail-loud
          expertiseTopics: "topics",
          responseStyle: "style",
          companyContext: "context",
          valueProposition: "value",
        }),
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS)
      .send({ brandId: TEST_BRAND });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/spokesperson/);
  });

  it("400s a mixed body (campaignId provided without all featureInputs)", async () => {
    const row = await seedRow();
    const res = await request(
      appWithStub({
        success: {
          pitch: "x".repeat(200),
          charCount: 200,
          attempts: 1,
          tokensInput: 1,
          tokensOutput: 1,
        },
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS)
      .send({
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
        // missing the other 4 fields
        spokesperson: "x",
      });
    expect(res.status).toBe(400);
  });

  it("accepts rows from the shared email pool (SHARED_EMAIL_ORG_ID)", async () => {
    const row = await seedRow({ orgId: SHARED_EMAIL_ORG_ID });
    const captured: CapturedCall[] = [];

    const res = await request(
      appWithStub({
        captured,
        success: {
          pitch: "x".repeat(200),
          charCount: 200,
          attempts: 1,
          tokensInput: 10,
          tokensOutput: 50,
        },
      })
    )
      .post(`/orgs/quote-requests/${row.id}/draft`)
      .set(AUTH_HEADERS)
      .send({
        brandId: TEST_BRAND,
        campaignId: TEST_CAMPAIGN_A,
        spokesperson: "x",
        expertiseTopics: "x",
        responseStyle: "x",
        companyContext: "x",
        valueProposition: "x",
      });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });
});
