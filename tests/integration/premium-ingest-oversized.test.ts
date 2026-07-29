import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/db/index.js";
import { providerQuoteRequests, quoteOpportunities } from "../../src/db/schema.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { TEST_ORG_A, TEST_USER, TEST_PARENT_RUN } from "../helpers/test-app.js";
import {
  buildMockEqrsClient,
  createMockEqrsState,
  makeOpportunity,
  makePremiumQuestion,
} from "../helpers/mock-eqrs.js";
import {
  ingestPremiumQuestionsToSilver,
  ingestFeaturedToSilver,
} from "../../src/lib/opportunity-pipeline.js";

/**
 * Regression: the Featured premium catalog is a full-list pass-through
 * with no cursor, so the ingest bulk-inserts the WHOLE list. The silver
 * upsert binds 13 parameters per row and Postgres caps a single
 * statement at 65,534 → it started throwing `MAX_PARAMETERS_EXCEEDED`
 * once the catalog crossed 5,042 questions, 500-ing every
 * `/orgs/opportunities/next` in prod (2026-07-29).
 *
 * 6,000 rows is comfortably past that ceiling on every bulk site.
 */
const OVERSIZED = 6000;

beforeEach(async () => {
  await cleanTestData();
});

afterAll(closeDb);

describe("ingestPremiumQuestionsToSilver — oversized catalog", () => {
  it("ingests a catalog past the Postgres bind-parameter ceiling", async () => {
    const state = createMockEqrsState({
      premiumQuestions: Array.from({ length: OVERSIZED }, (_, i) =>
        makePremiumQuestion({
          featuredQuestionId: 100000 + i,
          question: `oversized premium question ${i}`,
          mediaOutlet: `outlet-${i}.test`,
        })
      ),
    });

    await ingestPremiumQuestionsToSilver({
      orgId: TEST_ORG_A,
      userId: TEST_USER,
      runId: TEST_PARENT_RUN,
      eqrsClient: buildMockEqrsClient(state),
    });

    const silver = await db.select().from(providerQuoteRequests);
    const gold = await db.select().from(quoteOpportunities);
    expect(silver).toHaveLength(OVERSIZED);
    expect(gold).toHaveLength(OVERSIZED);
  });

  it("stays idempotent across chunk boundaries on re-ingest", async () => {
    const state = createMockEqrsState({
      premiumQuestions: Array.from({ length: OVERSIZED }, (_, i) =>
        makePremiumQuestion({
          featuredQuestionId: 200000 + i,
          question: `idempotent premium question ${i}`,
          mediaOutlet: `outlet-${i}.test`,
        })
      ),
    });
    const eqrsClient = buildMockEqrsClient(state);

    await ingestPremiumQuestionsToSilver({
      orgId: TEST_ORG_A,
      runId: TEST_PARENT_RUN,
      eqrsClient,
    });
    await ingestPremiumQuestionsToSilver({
      orgId: TEST_ORG_A,
      runId: TEST_PARENT_RUN,
      eqrsClient,
    });

    const silver = await db.select().from(providerQuoteRequests);
    expect(silver).toHaveLength(OVERSIZED);
  });
});

describe("ingestFeaturedToSilver — oversized catalog", () => {
  it("ingests a discovery batch past the bind-parameter ceiling", async () => {
    const state = createMockEqrsState({
      opportunities: Array.from({ length: OVERSIZED }, (_, i) =>
        makeOpportunity({
          externalId: `discovery-oversized-${i}`,
          featuredQuestionId: 300000 + i,
          opportunityText: `oversized discovery opportunity ${i}`,
          mediaOutlet: `outlet-${i}.test`,
        })
      ),
    });

    await ingestFeaturedToSilver({
      orgId: TEST_ORG_A,
      runId: TEST_PARENT_RUN,
      eqrsClient: buildMockEqrsClient(state),
    });

    const silver = await db.select().from(providerQuoteRequests);
    expect(silver).toHaveLength(OVERSIZED);
  });
});
