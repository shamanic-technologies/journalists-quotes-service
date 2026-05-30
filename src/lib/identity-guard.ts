import type { Request } from "express";

export interface ResolvedOpportunityIdentity {
  userId: string;
  parentRunId: string;
  campaignId: string;
}

export class IdentityHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityHeaderError";
  }
}

/**
 * Resolve the identity headers that the score-as-you-go opportunity
 * routes (`/orgs/opportunities/next` + `/orgs/opportunities/discover`)
 * require. Both drive the LLM relevance judge — chat-service
 * `POST /complete`, a tier-mirrored downstream that requires
 * `x-user-id` + `x-run-id` — and both are always invoked inside a
 * campaign workflow, so `x-campaign-id` is mandatory too.
 *
 * Fail loud: a missing header throws → the route returns 400, never a
 * silent downstream failure one hop later (service-architecture
 * "org-routes guard"). `x-org-id` is enforced by `requireOrgId` and
 * `x-brand-id` by `parseBrandIdsHeader`; this covers the remaining
 * three.
 */
export function requireOpportunityIdentity(
  req: Request
): ResolvedOpportunityIdentity {
  if (!req.userId) {
    throw new IdentityHeaderError("x-user-id header is required");
  }
  if (!req.parentRunId) {
    throw new IdentityHeaderError("x-run-id header is required");
  }
  if (!req.campaignId) {
    throw new IdentityHeaderError("x-campaign-id header is required");
  }
  return {
    userId: req.userId,
    parentRunId: req.parentRunId,
    campaignId: req.campaignId,
  };
}
