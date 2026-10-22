/**
 * The reason an operation failed, safe to store in a column or return in a response body.
 *
 * drizzle-orm >= 0.44 wraps every driver error in a DrizzleQueryError whose message is
 * "Failed query: <SQL>\nparams: <values>". That SQL and its params must never reach a response
 * body or a stored field (information leak), and they hide the real reason, which the driver
 * error carries on `.cause`. Any other error keeps its own message.
 */
export function errorMessage(err: unknown, fallback = "Unknown error"): string {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && isDrizzleQueryError(cur); depth++) {
    const cause: unknown = (cur as Error).cause;
    if (cause === undefined || cause === null) return "database query failed";
    cur = cause;
  }
  if (isDrizzleQueryError(cur)) return "database query failed";
  if (cur instanceof Error) return cur.message || fallback;
  if (typeof cur === "string" && cur) return cur;
  return fallback;
}

// Matched by shape, not `instanceof`: no import of drizzle-orm here, so a test that mocks
// "drizzle-orm" or a second copy of the package cannot break error reporting.
function isDrizzleQueryError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Failed query: ");
}
