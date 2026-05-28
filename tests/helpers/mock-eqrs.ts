import type {
  EqrsClient,
  EqrsOpportunitiesResponse,
  EqrsOpportunity,
  EqrsSubmitResult,
} from "../../src/lib/eqrs-client.js";

export interface MockEqrsState {
  opportunities: EqrsOpportunity[];
  fetchCalls: number;
  fetchSinceLog: Array<string | undefined>;
  submitCalls: Array<{
    orgId: string;
    brandId: string;
    featuredQuestionId: number;
    answer: string;
  }>;
  submitImpl?: (input: {
    orgId: string;
    brandId: string;
    featuredQuestionId: number;
    answer: string;
  }) => Promise<EqrsSubmitResult>;
  fetchImpl?: (since: string | undefined) => EqrsOpportunitiesResponse;
}

export function createMockEqrsState(
  overrides: Partial<MockEqrsState> = {}
): MockEqrsState {
  return {
    opportunities: [],
    fetchCalls: 0,
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
