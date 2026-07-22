import type {
  EqrsClient,
  EqrsOpportunitiesResponse,
  EqrsOpportunity,
  EqrsPremiumQuestion,
  EqrsPremiumQuestionsResponse,
  EqrsSubmitResult,
  EqrsSubmittedOutcome,
} from "../../src/lib/eqrs-client.js";

export interface MockEqrsState {
  opportunities: EqrsOpportunity[];
  premiumQuestions: EqrsPremiumQuestion[];
  submittedOutcomes: EqrsSubmittedOutcome[];
  fetchCalls: number;
  premiumFetchCalls: number;
  submittedFetchCalls: number;
  fetchSinceLog: Array<string | undefined>;
  submitCalls: Array<{
    orgId: string;
    brandId: string;
    featuredQuestionId: number;
    answer: string;
  }>;
  submittedFetchImpl?: () => EqrsSubmittedOutcome[];
  submitImpl?: (input: {
    orgId: string;
    brandId: string;
    featuredQuestionId: number;
    answer: string;
  }) => Promise<EqrsSubmitResult>;
  fetchImpl?: (since: string | undefined) => EqrsOpportunitiesResponse;
  premiumFetchImpl?: () => EqrsPremiumQuestionsResponse;
}

export function createMockEqrsState(
  overrides: Partial<MockEqrsState> = {}
): MockEqrsState {
  return {
    opportunities: [],
    premiumQuestions: [],
    submittedOutcomes: [],
    fetchCalls: 0,
    premiumFetchCalls: 0,
    submittedFetchCalls: 0,
    fetchSinceLog: [],
    submitCalls: [],
    ...overrides,
  };
}

export function buildMockEqrsClient(state: MockEqrsState): EqrsClient {
  return {
    async fetchOpportunities(args) {
      state.fetchCalls++;
      state.fetchSinceLog.push(args.since);
      if (state.fetchImpl) return state.fetchImpl(args.since);
      // Default impl: return all opps once, advance nextSince to now.
      // If `since` is provided, return [] (caller has already seen
      // everything up to that timestamp).
      if (args.since != null) {
        return { items: [], nextSince: args.since, refreshed: false };
      }
      return {
        items: state.opportunities,
        nextSince:
          state.opportunities.length > 0 ? new Date().toISOString() : null,
        refreshed: true,
      };
    },
    async fetchPremiumQuestions() {
      state.premiumFetchCalls++;
      if (state.premiumFetchImpl) return state.premiumFetchImpl();
      // Pass-through: returns the full current premium list each call
      // (no cursor). Idempotent ingest makes repeats cheap no-ops.
      return { questions: state.premiumQuestions };
    },
    async submitAnswer(args) {
      state.submitCalls.push({
        orgId: args.orgId,
        brandId: args.brandId,
        featuredQuestionId: args.featuredQuestionId,
        answer: args.answer,
      });
      if (state.submitImpl) return state.submitImpl(args);
      return {
        status: "submitted",
        featuredQuestionId: args.featuredQuestionId,
        featuredProfileId: 1234,
      };
    },
    async fetchSubmittedOutcomes() {
      state.submittedFetchCalls++;
      if (state.submittedFetchImpl) return state.submittedFetchImpl();
      return state.submittedOutcomes;
    },
  };
}

/** Helper to build a well-formed `EqrsSubmittedOutcome` for tests. */
export function makeSubmittedOutcome(
  overrides: Partial<EqrsSubmittedOutcome> & {
    featuredQuestionId: number;
    profileId: number;
    status: string;
  }
): EqrsSubmittedOutcome {
  return {
    featuredQuestionId: overrides.featuredQuestionId,
    profileId: overrides.profileId,
    status: overrides.status,
    publicationSource: overrides.publicationSource ?? null,
    domainAuthority: overrides.domainAuthority ?? null,
    attribution: overrides.attribution ?? null,
    submissionDate: overrides.submissionDate ?? null,
  };
}

/**
 * Helper to construct a well-formed `EqrsOpportunity` for tests
 * without forcing every field on the caller.
 */
export function makeOpportunity(
  overrides: Partial<EqrsOpportunity> & {
    externalId: string;
    featuredQuestionId: number;
    opportunityText: string;
  }
): EqrsOpportunity {
  return {
    id: overrides.id ?? `eqrs-${overrides.externalId}`,
    externalId: overrides.externalId,
    featuredQuestionId: overrides.featuredQuestionId,
    opportunityText: overrides.opportunityText,
    mediaOutlet: overrides.mediaOutlet ?? null,
    source: overrides.source ?? "featured",
    pitchUrl: overrides.pitchUrl ?? null,
    deadline: overrides.deadline ?? null,
    raw: overrides.raw ?? null,
    firstSeenAt: overrides.firstSeenAt ?? new Date().toISOString(),
    lastSeenAt: overrides.lastSeenAt ?? new Date().toISOString(),
  };
}

/**
 * Helper to construct a well-formed `EqrsPremiumQuestion` for tests.
 * Premium questions always carry a `featuredQuestionId` — that's what
 * makes them submittable via Featured's API.
 */
export function makePremiumQuestion(
  overrides: Partial<EqrsPremiumQuestion> & {
    featuredQuestionId: number;
    question: string;
  }
): EqrsPremiumQuestion {
  return {
    featuredQuestionId: overrides.featuredQuestionId,
    question: overrides.question,
    source: overrides.source ?? "featured",
    mediaOutlet: overrides.mediaOutlet ?? null,
    pitchUrl: overrides.pitchUrl ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    deadline: overrides.deadline ?? null,
  };
}
