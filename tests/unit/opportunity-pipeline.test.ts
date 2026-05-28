import { describe, it, expect } from "vitest";
import { pickRepresentativeSilver } from "../../src/lib/opportunity-pipeline.js";

describe("pickRepresentativeSilver", () => {
  const baseRow = {
    mediaOutlet: null,
    journalistName: null,
    opportunityText: "x",
    deadline: null,
    pitchUrl: null,
    pitchEmail: null,
    category: null,
    quoteOpportunityId: "g-1",
    isCanonical: false,
  };

  it("prefers Featured silver over email silver", () => {
    const rows = [
      {
        ...baseRow,
        id: "email-1",
        provider: "haro",
        ingestionChannel: "email",
        featuredQuestionId: null,
        fetchedAt: new Date("2026-01-02"),
      },
      {
        ...baseRow,
        id: "featured-1",
        provider: "featured",
        ingestionChannel: "api",
        featuredQuestionId: 42,
        fetchedAt: new Date("2026-01-01"),
      },
    ];
    expect(pickRepresentativeSilver(rows).id).toBe("featured-1");
  });

  it("picks most recently fetched featured row when multiple featured silvers exist", () => {
    const rows = [
      {
        ...baseRow,
        id: "featured-older",
        provider: "featured",
        ingestionChannel: "api",
        featuredQuestionId: 10,
        fetchedAt: new Date("2026-01-01"),
      },
      {
        ...baseRow,
        id: "featured-newer",
        provider: "featured",
        ingestionChannel: "api",
        featuredQuestionId: 20,
        fetchedAt: new Date("2026-01-05"),
      },
    ];
    expect(pickRepresentativeSilver(rows).id).toBe("featured-newer");
  });

  it("falls back to most recently fetched email row when no featured silver", () => {
    const rows = [
      {
        ...baseRow,
        id: "email-older",
        provider: "haro",
        ingestionChannel: "email",
        featuredQuestionId: null,
        fetchedAt: new Date("2026-01-01"),
      },
      {
        ...baseRow,
        id: "email-newer",
        provider: "haro",
        ingestionChannel: "email",
        featuredQuestionId: null,
        fetchedAt: new Date("2026-01-05"),
      },
    ];
    expect(pickRepresentativeSilver(rows).id).toBe("email-newer");
  });

  it("throws when no rows are given", () => {
    expect(() => pickRepresentativeSilver([])).toThrow();
  });
});
