import { describe, it, expect, beforeEach } from "vitest";
import {
  loadAliasRouting,
  resolveProvider,
  _resetAliasRoutingCache,
} from "../../src/lib/inbound/alias-routing.js";

describe("loadAliasRouting", () => {
  it("returns empty array on undefined env value", () => {
    expect(loadAliasRouting(undefined)).toEqual([]);
  });

  it("returns empty array on empty string", () => {
    expect(loadAliasRouting("")).toEqual([]);
  });

  it("parses valid JSON array", () => {
    const input = JSON.stringify([
      { alias: "haro@inbox.test", provider: "haro" },
      { alias: "SOS@INBOX.TEST", provider: "sos" },
    ]);
    const result = loadAliasRouting(input);
    expect(result).toEqual([
      { alias: "haro@inbox.test", provider: "haro" },
      { alias: "sos@inbox.test", provider: "sos" },
    ]);
  });

  it("throws on invalid schema (missing provider)", () => {
    expect(() =>
      loadAliasRouting(JSON.stringify([{ alias: "x@y.com" }]))
    ).toThrow(/INBOUND_ALIAS_ROUTING invalid/);
  });

  it("throws on non-array JSON", () => {
    expect(() => loadAliasRouting('{"not":"array"}')).toThrow(
      /INBOUND_ALIAS_ROUTING invalid/
    );
  });
});

describe("resolveProvider", () => {
  beforeEach(() => {
    _resetAliasRoutingCache();
    process.env.INBOUND_ALIAS_ROUTING = JSON.stringify([
      { alias: "haro@inbox.test", provider: "haro" },
      { alias: "sos@inbox.test", provider: "sos" },
    ]);
  });

  it("matches exact alias case-insensitively", () => {
    expect(resolveProvider("haro@inbox.test")).toBe("haro");
    expect(resolveProvider("HARO@INBOX.TEST")).toBe("haro");
    expect(resolveProvider(" haro@inbox.test ")).toBe("haro");
  });

  it("returns null for unknown alias", () => {
    expect(resolveProvider("unknown@inbox.test")).toBeNull();
  });

  it("returns null when no routing configured", () => {
    delete process.env.INBOUND_ALIAS_ROUTING;
    _resetAliasRoutingCache();
    expect(resolveProvider("haro@inbox.test")).toBeNull();
  });
});
