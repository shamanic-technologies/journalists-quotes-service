import {
  FeaturedClient,
  FeaturedRateLimitError,
  type FeaturedCredentials,
  type FeaturedClientOptions,
  type FeaturedOpportunity,
} from "../../src/lib/featured-client.js";

export interface MockFeaturedState {
  opportunities: FeaturedOpportunity[];
  submitted: Array<{ featuredQuestionId: number; profileId: number; answer: string }>;
  rateRemaining: number;
  forceSubmitError?: Error;
  profileIdSeq: number;
  loginCalls: number;
}

export function createMockState(
  overrides: Partial<MockFeaturedState> = {}
): MockFeaturedState {
  return {
    opportunities: [],
    submitted: [],
    rateRemaining: 100,
    profileIdSeq: 1000,
    loginCalls: 0,
    ...overrides,
  };
}

export class MockFeaturedClient extends FeaturedClient {
  state: MockFeaturedState;
  private retryAfterSec: number;

  constructor(state: MockFeaturedState, retryAfterSec = 60) {
    super({
      credentials: { username: "x", password: "y" },
      baseUrl: "http://mock",
      fetchImpl: (async () => {
        throw new Error("MockFeaturedClient should not call fetch");
      }) as unknown as typeof fetch,
    });
    this.state = state;
    this.retryAfterSec = retryAfterSec;
  }

  async login() {
    this.state.loginCalls++;
    return "mock-jwt";
  }

  async listOpportunities() {
    return this.state.opportunities;
  }

  rateLimitState() {
    return {
      remaining: this.state.rateRemaining,
      retryAfter: this.state.rateRemaining > 0 ? 0 : this.retryAfterSec,
    };
  }

  async submitAnswer(input: {
    answer: string;
    featuredQuestionId: number;
    profileId: number;
  }) {
    if (this.state.forceSubmitError) {
      const e = this.state.forceSubmitError;
      this.state.forceSubmitError = undefined;
      throw e;
    }
    if (this.state.rateRemaining <= 0) {
      throw new FeaturedRateLimitError(this.retryAfterSec);
    }
    this.state.rateRemaining--;
    this.state.submitted.push(input);
    return { message: "Success" };
  }

  async createProfile(_form: FormData) {
    const id = this.state.profileIdSeq++;
    return { profileId: id };
  }
}

export function buildMockClient(
  state: MockFeaturedState,
  retryAfterSec = 60
) {
  return (
    _credentials: FeaturedCredentials,
    _overrides?: Partial<FeaturedClientOptions>
  ) => new MockFeaturedClient(state, retryAfterSec);
}
