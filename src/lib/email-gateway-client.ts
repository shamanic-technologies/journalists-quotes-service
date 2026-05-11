export interface EmailGatewaySendRequest {
  to: string;
  recipientFirstName: string;
  recipientLastName: string;
  recipientCompany: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  from?: string;
  replyTo?: string;
  idempotencyKey?: string;
  tag?: string;
  metadata?: Record<string, string>;
}

export interface EmailGatewaySendResponse {
  success: boolean;
  messageId?: string;
  provider: "transactional" | "broadcast";
  deduplicated?: boolean;
}

export class EmailGatewayError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "EmailGatewayError";
    this.status = status;
    this.details = details;
  }
}

interface ServiceContext {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

function getConfig(): { url: string; apiKey: string } {
  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url) throw new Error("EMAIL_GATEWAY_SERVICE_URL is not set");
  if (!apiKey) throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY is not set");
  return { url, apiKey };
}

function buildHeaders(ctx: ServiceContext, apiKey: string): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.campaignId) headers["x-campaign-id"] = ctx.campaignId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;
  if (ctx.workflowSlug) headers["x-workflow-slug"] = ctx.workflowSlug;
  if (ctx.featureSlug) headers["x-feature-slug"] = ctx.featureSlug;
  return headers;
}

/**
 * Send a transactional email via email-gateway-service `/orgs/send`.
 * Used to deliver expert-quote pitches to journalist reply aliases
 * (HARO and other email providers).
 *
 * Threading: for HARO, the recipient alias (`reply+<uuid>@helpareporter.com`)
 * itself routes the reply to the correct journalist — RFC2822 `In-Reply-To`
 * headers are not required. The email-gateway send schema does not currently
 * expose those headers anyway.
 */
export async function sendTransactionalEmail(
  request: EmailGatewaySendRequest,
  ctx: ServiceContext
): Promise<EmailGatewaySendResponse> {
  const { url, apiKey } = getConfig();
  const endpoint = `${url.replace(/\/$/, "")}/orgs/send`;

  const body = {
    type: "transactional" as const,
    to: request.to,
    recipientFirstName: request.recipientFirstName,
    recipientLastName: request.recipientLastName,
    recipientCompany: request.recipientCompany,
    subject: request.subject,
    textBody: request.textBody,
    htmlBody: request.htmlBody,
    from: request.from,
    replyTo: request.replyTo,
    idempotencyKey: request.idempotencyKey,
    tag: request.tag,
    metadata: request.metadata,
    campaignId: ctx.campaignId,
    workflowSlug: ctx.workflowSlug,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: buildHeaders(ctx, apiKey),
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    throw new EmailGatewayError(
      `email-gateway-service returned ${res.status}: ${text}`,
      res.status,
      parsed
    );
  }

  const json = parsed as EmailGatewaySendResponse;
  if (typeof json !== "object" || json === null || typeof json.success !== "boolean") {
    throw new EmailGatewayError(
      `email-gateway-service returned malformed response: ${text}`,
      res.status,
      parsed
    );
  }
  return json;
}
