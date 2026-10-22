import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { errorMessage } from "../../src/lib/db-error.js";

const SQL = 'insert into "secrets" ("email") values ($1)';
const PARAMS = ["jane@example.com"];

function pgError(message: string): Error {
  return Object.assign(new Error(message), { code: "23505", constraint_name: "secrets_email_uq" });
}

describe("errorMessage", () => {
  it("returns the driver's reason from a drizzle query error, never the SQL or its params", () => {
    const err = new DrizzleQueryError(SQL, PARAMS, pgError('duplicate key value violates unique constraint "secrets_email_uq"'));
    const msg = errorMessage(err);
    expect(msg).toBe('duplicate key value violates unique constraint "secrets_email_uq"');
    expect(msg).not.toContain("Failed query");
    expect(msg).not.toContain("insert into");
    expect(msg).not.toContain("jane@example.com");
  });

  it("follows nested query errors down to the driver error", () => {
    const inner = new DrizzleQueryError(SQL, PARAMS, pgError("connection refused"));
    expect(errorMessage(new DrizzleQueryError("select 1", [], inner))).toBe("connection refused");
  });

  it("hides the SQL of a query error that carries no cause", () => {
    expect(errorMessage(new DrizzleQueryError(SQL, PARAMS, undefined as unknown as Error))).toBe("database query failed");
    expect(errorMessage(new Error(`Failed query: ${SQL}\nparams: ${PARAMS}`))).toBe("database query failed");
  });

  it("keeps the message of any other error, and the fallback for empty or unknown values", () => {
    expect(errorMessage(new Error("upstream timed out"))).toBe("upstream timed out");
    expect(errorMessage(new Error(""), "Internal server error")).toBe("Internal server error");
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(undefined, "Internal server error")).toBe("Internal server error");
    expect(errorMessage({ weird: true })).toBe("Unknown error");
  });
});
