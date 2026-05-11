import { createHmac } from "node:crypto";

/**
 * Build an `x-eg-signature` header value matching the consumer-side hmacVerify
 * middleware. Used by tests to call the protected webhook endpoint.
 */
export function buildSignatureHeader(
  body: object,
  secret: string,
  options: { timestampSeconds?: number } = {}
): { signature: string; bodyString: string } {
  const bodyString = JSON.stringify(body);
  const t =
    options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret)
    .update(`${t}.${bodyString}`)
    .digest("hex");
  return { signature: `t=${t},v1=${v1}`, bodyString };
}
