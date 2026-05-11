import { createHash } from "node:crypto";

const PUNCT_AND_SYMBOLS_RE = /[\p{P}\p{S}]/gu;
const WHITESPACE_RE = /\s+/g;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(PUNCT_AND_SYMBOLS_RE, " ")
    .replace(WHITESPACE_RE, " ")
    .trim();
}

/**
 * Stable fingerprint of an opportunity: SHA256 over normalized
 * (opportunity_text + canonical_outlet). Same demand across providers
 * collides when text + outlet match.
 */
export function computeFingerprint(
  opportunityText: string,
  canonicalOutlet: string | null | undefined
): string {
  const outlet = normalize(canonicalOutlet ?? "");
  const text = normalize(opportunityText);
  return createHash("sha256").update(`${text}|${outlet}`).digest("hex");
}
