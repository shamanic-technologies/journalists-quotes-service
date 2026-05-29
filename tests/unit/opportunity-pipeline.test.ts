import { describe, it, expect } from "vitest";
import {
  computeDelivery,
  pickRepresentativeSilver,
} from "../../src/lib/opportunity-pipeline.js";

describe("computeDelivery", () => {
  it("featured + featuredQuestionId → submittable via featured_api", () => {
    expect(
      computeDelivery({
        provider: "featured",
        featuredQuestionId: 42,
        pitchEmail: null,
      })
    ).toEqual({ submittable: true, deliveryMethod: "featured_api" });
  });

  it("email-sourced (pitchEmail) → submittable via email_reply", () => {
    expect(
      computeDelivery({
        provider: "haro",
        featuredQuestionId: null,
        pitchEmail: "reply@helpareporter.com",
      })
    ).toEqual({ submittable: true, deliveryMethod: "email_reply" });
  });

  it("featured discovery (null fqid, no email) → NOT submittable (external_manual)", () => {
    expect(
      computeDelivery({
        provider: "featured",
        featuredQuestionId: null,
        pitchEmail: null,
      })
    ).toEqual({ submittable: false, deliveryMethod: "external_manual" });
  });

  it("featured + fqid takes precedence over a stray pitchEmail", () => {
    expect(
      computeDelivery({
        provider: "featured",
        featuredQuestionId: 7,
        pitchEmail: "x@y.com",
      })
    ).toEqual({ submittable: true, deliveryMethod: "featured_api" });
  });
});

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
