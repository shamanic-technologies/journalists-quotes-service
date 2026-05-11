import { describe, it, expect } from "vitest";
import { computeFingerprint } from "../../src/lib/cluster/fingerprint.js";

describe("computeFingerprint", () => {
  it("returns the same fingerprint for whitespace and case variations", () => {
    const a = computeFingerprint(
      "Looking for marketing experts on AI tools",
      "TechCrunch"
    );
    const b = computeFingerprint(
      "  LOOKING for   marketing experts on AI tools  ",
      "techcrunch"
    );
    expect(a).toBe(b);
  });

  it("returns the same fingerprint for punctuation variations", () => {
    const a = computeFingerprint(
      "Looking for marketing experts on AI tools!",
      "TechCrunch"
    );
    const b = computeFingerprint(
      "Looking for marketing experts on AI tools",
      "TechCrunch"
    );
    expect(a).toBe(b);
  });

  it("differs when outlet differs", () => {
    const a = computeFingerprint("Same text", "Outlet A");
    const b = computeFingerprint("Same text", "Outlet B");
    expect(a).not.toBe(b);
  });

  it("differs when text differs", () => {
    const a = computeFingerprint("Text one", "Outlet");
    const b = computeFingerprint("Text two", "Outlet");
    expect(a).not.toBe(b);
  });

  it("accepts null outlet without throwing", () => {
    const a = computeFingerprint("Some opportunity text", null);
    const b = computeFingerprint("Some opportunity text", undefined);
    expect(a).toBe(b);
  });

  it("returns a 64-char hex digest", () => {
    const fp = computeFingerprint("Anything", "AnyOutlet");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
