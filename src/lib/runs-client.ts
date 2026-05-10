const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL;
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY;

function getRunsConfig() {
  if (!RUNS_SERVICE_URL) throw new Error("RUNS_SERVICE_URL is not set");
  if (!RUNS_SERVICE_API_KEY) throw new Error("RUNS_SERVICE_API_KEY is not set");
  return { url: RUNS_SERVICE_URL, apiKey: RUNS_SERVICE_API_KEY };
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
  userId?: string
): Promise<CreateRunResponse> {
  const { url, apiKey } = getRunsConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (orgId) headers["x-org-id"] = orgId;
  if (userId) headers["x-user-id"] = userId;
  if (request.parentRunId) headers["x-run-id"] = request.parentRunId;

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
