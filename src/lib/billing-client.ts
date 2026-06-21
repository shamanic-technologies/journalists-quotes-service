export interface CreditItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeCreditParams {
  items: CreditItem[];
  description: string;
  orgId: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  audienceId?: string;
}

export interface AuthorizeCreditResult {
  sufficient: boolean;
  balance_cents: number;
  required_cents: number;
}

export class BillingServiceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BillingServiceError";
  }
}

export async function authorizeCredit(
  params: AuthorizeCreditParams
): Promise<AuthorizeCreditResult> {
  const baseUrl = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error(
      "[journalists-quotes-service] BILLING_SERVICE_URL is required to authorize credit"
    );
  }
  if (!apiKey) {
    throw new Error(
      "[journalists-quotes-service] BILLING_SERVICE_API_KEY is required to authorize credit"
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "x-org-id": params.orgId,
  };
  if (params.userId) headers["x-user-id"] = params.userId;
  if (params.runId) headers["x-run-id"] = params.runId;
  if (params.brandId) headers["x-brand-id"] = params.brandId;
  if (params.campaignId) headers["x-campaign-id"] = params.campaignId;
  if (params.featureSlug) headers["x-feature-slug"] = params.featureSlug;
  if (params.workflowSlug) headers["x-workflow-slug"] = params.workflowSlug;
  if (params.audienceId) headers["x-audience-id"] = params.audienceId;

  const response = await fetch(`${baseUrl}/v1/customer_balance/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      items: params.items,
      description: params.description,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new BillingServiceError(
      `billing-service POST /v1/customer_balance/authorize failed (${response.status}): ${body}`,
      response.status
    );
  }

  return response.json() as Promise<AuthorizeCreditResult>;
}
