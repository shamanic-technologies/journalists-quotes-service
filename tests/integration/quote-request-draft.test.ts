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
import { SHARED_EMAIL_ORG_ID } from "../../src/lib/inbound/process.js";

interface CapturedCall {
  request: GenerateExpertQuotePitchRequest;
  identity: ContentGenerationCallerIdentity;
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
