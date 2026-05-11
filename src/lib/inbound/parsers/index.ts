import { parseHaroEmail, type ParsedHaroQuery } from "./haro.js";
import type { PostmarkInboundWebhook } from "../../../schemas.js";

export interface ParserResult {
  /** Provider-canonical rows ready for `provider_quote_requests` insert. */
  queries: ParsedHaroQuery[];
}

export type ProviderParser = (payload: PostmarkInboundWebhook) => ParserResult;

const haroParser: ProviderParser = (payload) => {
  const textBody = payload.TextBody ?? "";
  return { queries: parseHaroEmail(textBody) };
};

export const PARSERS: Record<string, ProviderParser | undefined> = {
  haro: haroParser,
};

export function getParser(provider: string | null): ProviderParser | null {
  if (!provider) return null;
  return PARSERS[provider] ?? null;
}
