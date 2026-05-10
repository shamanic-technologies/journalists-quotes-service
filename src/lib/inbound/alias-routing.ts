import { z } from "zod";

const AliasRouteSchema = z.object({
  alias: z.string().min(1),
  provider: z.string().min(1),
});

const AliasRoutingSchema = z.array(AliasRouteSchema);

export interface AliasRoute {
  alias: string;
  provider: string;
}

let cached: AliasRoute[] | null = null;

export function loadAliasRouting(envValue: string | undefined): AliasRoute[] {
  if (!envValue || envValue.trim() === "") {
    return [];
  }
  const parsed = AliasRoutingSchema.safeParse(JSON.parse(envValue));
  if (!parsed.success) {
    throw new Error(
      `INBOUND_ALIAS_ROUTING invalid: ${parsed.error.message}`
    );
  }
  return parsed.data.map((r) => ({
    alias: r.alias.toLowerCase(),
    provider: r.provider,
  }));
}

export function getAliasRouting(): AliasRoute[] {
  if (cached === null) {
    cached = loadAliasRouting(process.env.INBOUND_ALIAS_ROUTING);
  }
  return cached;
}

export function _resetAliasRoutingCache(): void {
  cached = null;
}

/**
 * Resolve provider from a recipient alias.
 * Returns null if no rule matches; caller stores the email with provider=null.
 */
export function resolveProvider(toEmail: string): string | null {
  const lower = toEmail.toLowerCase().trim();
  const routes = getAliasRouting();
  for (const route of routes) {
    if (lower === route.alias) return route.provider;
  }
  return null;
}
