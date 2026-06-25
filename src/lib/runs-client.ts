function getRunsConfig() {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url) throw new Error("RUNS_SERVICE_URL is not set");
  if (!apiKey) throw new Error("RUNS_SERVICE_API_KEY is not set");
  return { url, apiKey };
}

export interface CreateRunResponse {
  id: string;
  parentRunId: string | null;
  serviceName: string;
  taskName: string;
}

export async function createChildRun(
  request: { parentRunId?: string; serviceName: string; taskName: string },
  orgId?: string,
  userId?: string,
  audienceId?: string,
  campaignId?: string,
  brandId?: string,
  featureSlug?: string
): Promise<CreateRunResponse> {
  const { url, apiKey } = getRunsConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (orgId) headers["x-org-id"] = orgId;
  if (userId) headers["x-user-id"] = userId;
  if (request.parentRunId) headers["x-run-id"] = request.parentRunId;
  // Tag the run row with the campaign audience so runs-service can
  // attribute this run's cost to the right audience (runs.audience_id).
  if (audienceId) headers["x-audience-id"] = audienceId;
  // Tag the run row with the campaign attribution trio so the daily-budget
  // gate (campaign-service sums runs_costs by runs.campaign_id) attributes
  // this run's downstream cost to the triggering campaign + brand + feature.
  // Absent outside the campaign flux.
  if (campaignId) headers["x-campaign-id"] = campaignId;
  if (brandId) headers["x-brand-id"] = brandId;
  if (featureSlug) headers["x-feature-slug"] = featureSlug;

  const response = await fetch(`${url}/v1/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      serviceName: request.serviceName,
      taskName: request.taskName,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Runs-service POST /v1/runs failed (${response.status}): ${body}`
    );
  }

  return response.json() as Promise<CreateRunResponse>;
}

export async function closeRun(
  runId: string,
  status: "completed" | "failed",
  orgId?: string,
  userId?: string
): Promise<void> {
  const { url, apiKey } = getRunsConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (orgId) headers["x-org-id"] = orgId;
  if (userId) headers["x-user-id"] = userId;

  const response = await fetch(`${url}/v1/runs/${runId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Runs-service PATCH /v1/runs/${runId} failed (${response.status}): ${body}`
    );
  }
}

export interface AddCostsItem {
  costName: string;
  costSource: "platform" | "org";
  quantity: number;
  status?: "provisioned" | "actual" | "cancelled";
}

export interface AddCostsIdentity {
  orgId: string;
  userId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  audienceId?: string;
}

export async function addCosts(
  runId: string,
  items: AddCostsItem[],
  identity: AddCostsIdentity
): Promise<void> {
  const { url, apiKey } = getRunsConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-run-id": runId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  if (identity.audienceId) headers["x-audience-id"] = identity.audienceId;

  const response = await fetch(`${url}/v1/runs/${runId}/costs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Runs-service POST /v1/runs/${runId}/costs failed (${response.status}): ${body}`
    );
  }
}
