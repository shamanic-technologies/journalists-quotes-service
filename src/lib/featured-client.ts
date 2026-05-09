const DEFAULT_BASE_URL = "https://featured.com/api/external-users";
const JWT_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 100;

export interface FeaturedCredentials {
  username: string;
  password: string;
}

export interface FeaturedQuestion {
  featuredQuestionId: number;
  question: string;
  source?: string;
  mediaOutlet?: string;
  pitchUrl?: string;
  createdAt?: string;
  deadline?: string;
  raw?: unknown;
}

export interface FeaturedOpportunity {
  opportunity: string;
  mediaOutlet?: string;
  source?: string;
  createdAt?: string;
  deadline?: string;
  pitchUrl?: string;
  featuredQuestionId: number;
  [key: string]: unknown;
}

export interface FeaturedProfileResponse {
  profileId: number;
  [key: string]: unknown;
}

export interface FeaturedSubmittedResponse {
  data: unknown[];
  total?: number;
  page?: number;
}

export interface FeaturedTrackingItem {
  featuredQuestionId: number;
  profileId?: number;
  articleUrl?: string;
  status?: string;
  [key: string]: unknown;
}

export class FeaturedRateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`Featured rate limit exhausted, retry after ${retryAfter}s`);
    this.retryAfter = retryAfter;
    this.name = "FeaturedRateLimitError";
  }
}

interface JwtCacheEntry {
  token: string;
  fetchedAt: number;
}

export interface FeaturedClientOptions {
  credentials: FeaturedCredentials;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  cacheKey?: string;
}

const jwtCache = new Map<string, JwtCacheEntry>();
const submitTimestamps: number[] = [];

export function _resetFeaturedClientState() {
  jwtCache.clear();
  submitTimestamps.length = 0;
}

export class FeaturedClient {
  private credentials: FeaturedCredentials;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private cacheKey: string;

  constructor(options: FeaturedClientOptions) {
    this.credentials = options.credentials;
    this.baseUrl =
      options.baseUrl ?? process.env.FEATURED_API_BASE_URL ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheKey = options.cacheKey ?? options.credentials.username;
  }

  async login(force = false): Promise<string> {
    const cached = jwtCache.get(this.cacheKey);
    if (!force && cached && Date.now() - cached.fetchedAt < JWT_TTL_MS) {
      return cached.token;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.credentials.username,
        password: this.credentials.password,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Featured /login failed (${response.status}): ${body}`
      );
    }

    const data = (await response.json()) as { "x-access-token"?: string };
    const token = data["x-access-token"];
    if (!token) {
      throw new Error("Featured /login response missing x-access-token");
    }

    jwtCache.set(this.cacheKey, { token, fetchedAt: Date.now() });
    return token;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { body?: BodyInit | null } = {},
    retryOn401 = true
  ): Promise<T> {
    const token = await this.login();
    const headers = new Headers(init.headers ?? {});
    headers.set("x-access-token", token);
    if (init.body && !headers.has("Content-Type") && typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (response.status === 401 && retryOn401) {
      jwtCache.delete(this.cacheKey);
      return this.request<T>(path, init, false);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Featured ${init.method || "GET"} ${path} failed (${response.status}): ${body}`
      );
    }

    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  listPremiumQuestions(): Promise<FeaturedQuestion[]> {
    return this.request<FeaturedQuestion[]>("/premium-question-list");
  }

  listOpportunities(): Promise<FeaturedOpportunity[]> {
    return this.request<FeaturedOpportunity[]>("/opportunities-list");
  }

  async submitAnswer(input: {
    answer: string;
    featuredQuestionId: number;
    profileId: number;
  }): Promise<{ message: string }> {
    if (input.answer.length < 100 || input.answer.length > 2500) {
      throw new Error(
        `Featured submitAnswer: answer must be 100-2500 chars, got ${input.answer.length}`
      );
    }

    const now = Date.now();
    while (
      submitTimestamps.length > 0 &&
      now - submitTimestamps[0] >= RATE_LIMIT_WINDOW_MS
    ) {
      submitTimestamps.shift();
    }
    if (submitTimestamps.length >= RATE_LIMIT_MAX) {
      const retryAfter = Math.ceil(
        (RATE_LIMIT_WINDOW_MS - (now - submitTimestamps[0])) / 1000
      );
      throw new FeaturedRateLimitError(retryAfter);
    }
    submitTimestamps.push(now);

    return this.request<{ message: string }>("/answer-question", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  rateLimitState() {
    const now = Date.now();
    while (
      submitTimestamps.length > 0 &&
      now - submitTimestamps[0] >= RATE_LIMIT_WINDOW_MS
    ) {
      submitTimestamps.shift();
    }
    const remaining = RATE_LIMIT_MAX - submitTimestamps.length;
    const retryAfter =
      submitTimestamps.length === 0
        ? 0
        : Math.ceil(
            (RATE_LIMIT_WINDOW_MS - (now - submitTimestamps[0])) / 1000
          );
    return { remaining, retryAfter };
  }

  async createProfile(form: FormData): Promise<FeaturedProfileResponse> {
    const token = await this.login();
    const response = await this.fetchImpl(`${this.baseUrl}/add-profile`, {
      method: "POST",
      headers: { "x-access-token": token },
      body: form as unknown as BodyInit,
    });

    if (response.status === 401) {
      jwtCache.delete(this.cacheKey);
      const retryToken = await this.login(true);
      const retry = await this.fetchImpl(`${this.baseUrl}/add-profile`, {
        method: "POST",
        headers: { "x-access-token": retryToken },
        body: form as unknown as BodyInit,
      });
      if (!retry.ok) {
        throw new Error(
          `Featured POST /add-profile failed (${retry.status}): ${await retry.text()}`
        );
      }
      return (await retry.json()) as FeaturedProfileResponse;
    }

    if (!response.ok) {
      throw new Error(
        `Featured POST /add-profile failed (${response.status}): ${await response.text()}`
      );
    }
    return (await response.json()) as FeaturedProfileResponse;
  }

  listProfiles(): Promise<FeaturedProfileResponse[]> {
    return this.request<FeaturedProfileResponse[]>("/profiles");
  }

  deactivateProfile(profileId: number): Promise<unknown> {
    return this.request<unknown>("/deactivate-profile", {
      method: "POST",
      body: JSON.stringify({ profileId }),
    });
  }

  listSubmitted(page = 1): Promise<FeaturedSubmittedResponse> {
    return this.request<FeaturedSubmittedResponse>(
      `/submitted?page=${page}`
    );
  }

  listSelected(): Promise<FeaturedTrackingItem[]> {
    return this.request<FeaturedTrackingItem[]>("/selected");
  }

  listPublished(): Promise<FeaturedTrackingItem[]> {
    return this.request<FeaturedTrackingItem[]>("/published");
  }

  listNotSelected(): Promise<FeaturedTrackingItem[]> {
    return this.request<FeaturedTrackingItem[]>("/not-selected");
  }

  addSeats(quantity: number): Promise<unknown> {
    return this.request<unknown>("/add-seats", {
      method: "POST",
      body: JSON.stringify({ quantity }),
    });
  }
}
