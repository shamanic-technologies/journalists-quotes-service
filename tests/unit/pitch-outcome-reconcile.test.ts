import { describe, it, expect } from "vitest";
import {
  mapConnectivelyStatus,
  computePitchOutcomePatch,
  type ReconcilablePitch,
} from "../../src/lib/pitch-outcome-reconcile.js";
import {
  makeSubmittedOutcome,
  makePublishedArticle,
} from "../helpers/mock-eqrs.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");

function pitch(overrides: Partial<ReconcilablePitch> = {}): ReconcilablePitch {
  return {
    id: overrides.id ?? "pitch-1",
    status: overrides.status ?? "submitted",
    publicationSource: overrides.publicationSource ?? null,
    outletDomainRating: overrides.outletDomainRating ?? null,
    backlinkAttribution: overrides.backlinkAttribution ?? null,
    featuredArticleUrl: overrides.featuredArticleUrl ?? null,
    articleTitle: overrides.articleTitle ?? null,
    publishedAt: overrides.publishedAt ?? null,
  };
}

describe("mapConnectivelyStatus", () => {
  it("maps the four Connectively labels", () => {
    expect(mapConnectivelyStatus("Published")).toBe("published");
    expect(mapConnectivelyStatus("Selected")).toBe("selected");
    expect(mapConnectivelyStatus("Not Selected")).toBe("not_selected");
    expect(mapConnectivelyStatus("In Review")).toBeNull();
  });

  it("is case/whitespace-insensitive", () => {
    expect(mapConnectivelyStatus("  published ")).toBe("published");
    expect(mapConnectivelyStatus("NOT SELECTED")).toBe("not_selected");
  });

  it("never guesses an unknown label", () => {
    expect(mapConnectivelyStatus("Pending Review")).toBeNull();
    expect(mapConnectivelyStatus("")).toBeNull();
  });
});

describe("computePitchOutcomePatch — /submitted status + enrichment", () => {
  it("advances submitted -> published and stamps observed time", () => {
    const patch = computePitchOutcomePatch(
      pitch({ status: "submitted" }),
      makeSubmittedOutcome({
        featuredQuestionId: 1,
        profileId: 2,
        status: "Published",
        publicationSource: "The AJ Center",
        domainAuthority: 14,
        attribution: "DoFollow",
      }),
      null,
      NOW
    );
    expect(patch).not.toBeNull();
    expect(patch!.status).toBe("published");
    expect(patch!.outcomeObservedAt).toEqual(NOW);
    expect(patch!.publicationSource).toBe("The AJ Center");
    expect(patch!.outletDomainRating).toBe(14);
    expect(patch!.backlinkAttribution).toBe("DoFollow");
  });

  it("advances submitted -> selected and submitted -> not_selected", () => {
    const sel = computePitchOutcomePatch(
      pitch(),
      makeSubmittedOutcome({ featuredQuestionId: 1, profileId: 2, status: "Selected" }),
      null,
      NOW
    );
    expect(sel!.status).toBe("selected");
    const ns = computePitchOutcomePatch(
      pitch(),
      makeSubmittedOutcome({ featuredQuestionId: 1, profileId: 2, status: "Not Selected" }),
      null,
      NOW
    );
    expect(ns!.status).toBe("not_selected");
  });

  it("advances selected -> published (later publication)", () => {
    const patch = computePitchOutcomePatch(
      pitch({ status: "selected" }),
      makeSubmittedOutcome({ featuredQuestionId: 1, profileId: 2, status: "Published" }),
      null,
      NOW
    );
    expect(patch!.status).toBe("published");
  });

  it("keeps 'submitted' for 'In Review' but still refreshes enrichment", () => {
    const patch = computePitchOutcomePatch(
      pitch({ status: "submitted" }),
      makeSubmittedOutcome({
        featuredQuestionId: 1,
        profileId: 2,
        status: "In Review",
        domainAuthority: 23,
        attribution: "Unknown",
        publicationSource: "ExecutiveEDGE",
      }),
      null,
      NOW
    );
    expect(patch).not.toBeNull();
    expect(patch!.status).toBeUndefined();
    expect(patch!.outcomeObservedAt).toBeUndefined();
    expect(patch!.outletDomainRating).toBe(23);
    expect(patch!.publicationSource).toBe("ExecutiveEDGE");
  });

  it("is forward-only: never downgrades published -> selected", () => {
    const patch = computePitchOutcomePatch(
      pitch({
        status: "published",
        publicationSource: "The AJ Center",
        outletDomainRating: 14,
        backlinkAttribution: "DoFollow",
      }),
      makeSubmittedOutcome({
        featuredQuestionId: 1,
        profileId: 2,
        status: "Selected",
        publicationSource: "The AJ Center",
        domainAuthority: 14,
        attribution: "DoFollow",
      }),
      null,
      NOW
    );
    // status stays published, enrichment unchanged → full no-op
    expect(patch).toBeNull();
  });

  it("does not downgrade not_selected -> submitted (In Review after rejection)", () => {
    const patch = computePitchOutcomePatch(
      pitch({
        status: "not_selected",
        publicationSource: "X",
        outletDomainRating: 5,
        backlinkAttribution: "Unlinked",
      }),
      makeSubmittedOutcome({
        featuredQuestionId: 1,
        profileId: 2,
        status: "In Review",
        publicationSource: "X",
        domainAuthority: 5,
        attribution: "Unlinked",
      }),
      null,
      NOW
    );
    expect(patch).toBeNull();
  });

  it("is idempotent: a re-run with identical data is a no-op", () => {
    const outcome = makeSubmittedOutcome({
      featuredQuestionId: 1,
      profileId: 2,
      status: "Published",
      publicationSource: "The AJ Center",
      domainAuthority: 14,
      attribution: "DoFollow",
    });
    // already reconciled to published with matching enrichment
    const patch = computePitchOutcomePatch(
      pitch({
        status: "published",
        publicationSource: "The AJ Center",
        outletDomainRating: 14,
        backlinkAttribution: "DoFollow",
      }),
      outcome,
      null,
      NOW
    );
    expect(patch).toBeNull();
  });

  it("refreshes enrichment only when it changed (DR correction)", () => {
    const patch = computePitchOutcomePatch(
      pitch({
        status: "published",
        publicationSource: "The AJ Center",
        outletDomainRating: 10,
        backlinkAttribution: "DoFollow",
      }),
      makeSubmittedOutcome({
        featuredQuestionId: 1,
        profileId: 2,
        status: "Published",
        publicationSource: "The AJ Center",
        domainAuthority: 14,
        attribution: "DoFollow",
      }),
      null,
      NOW
    );
    expect(patch).not.toBeNull();
    expect(patch!.status).toBeUndefined(); // no status change
    expect(patch!.outletDomainRating).toBe(14);
  });
});

describe("computePitchOutcomePatch — /published article fields", () => {
  const PUB_DATE = "2026-07-22T00:00:00.000Z";

  it("persists article URL / title / publish date from the /published feed", () => {
    const patch = computePitchOutcomePatch(
      pitch({ status: "published" }),
      null,
      makePublishedArticle({
        featuredQuestionId: 1,
        profileId: 2,
        articleUrl: "https://brettfarmiloe.com/some-article/",
        articleTitle: "Some Article Title",
        publishDate: PUB_DATE,
      }),
      NOW
    );
    expect(patch).not.toBeNull();
    expect(patch!.featuredArticleUrl).toBe(
      "https://brettfarmiloe.com/some-article/"
    );
    expect(patch!.articleTitle).toBe("Some Article Title");
    expect(patch!.publishedAt).toEqual(new Date(PUB_DATE));
    // no /submitted outcome passed → no status touch
    expect(patch!.status).toBeUndefined();
  });

  it("combines a /submitted status advance with /published article fields", () => {
    const patch = computePitchOutcomePatch(
      pitch({ status: "submitted" }),
      makeSubmittedOutcome({
        featuredQuestionId: 1,
        profileId: 2,
        status: "Published",
        publicationSource: "Brett Farmiloe",
        domainAuthority: 21,
        attribution: "DoFollow",
      }),
      makePublishedArticle({
        featuredQuestionId: 1,
        profileId: 2,
        articleUrl: "https://brettfarmiloe.com/some-article/",
        articleTitle: "Some Article Title",
        publishDate: PUB_DATE,
      }),
      NOW
    );
    expect(patch!.status).toBe("published");
    expect(patch!.outcomeObservedAt).toEqual(NOW);
    expect(patch!.publicationSource).toBe("Brett Farmiloe");
    expect(patch!.featuredArticleUrl).toBe(
      "https://brettfarmiloe.com/some-article/"
    );
    expect(patch!.publishedAt).toEqual(new Date(PUB_DATE));
  });

  it("is idempotent: identical article data re-run is a no-op", () => {
    const patch = computePitchOutcomePatch(
      pitch({
        status: "published",
        featuredArticleUrl: "https://x.com/a",
        articleTitle: "T",
        publishedAt: new Date(PUB_DATE),
      }),
      null,
      makePublishedArticle({
        featuredQuestionId: 1,
        profileId: 2,
        articleUrl: "https://x.com/a",
        articleTitle: "T",
        publishDate: PUB_DATE,
      }),
      NOW
    );
    expect(patch).toBeNull();
  });

  it("never clobbers an existing article URL/title with a null from the feed", () => {
    const patch = computePitchOutcomePatch(
      pitch({
        status: "published",
        featuredArticleUrl: "https://x.com/a",
        articleTitle: "Kept Title",
        publishedAt: new Date(PUB_DATE),
      }),
      null,
      // provider omitted the title on this pass (null) — must NOT wipe it
      makePublishedArticle({
        featuredQuestionId: 1,
        profileId: 2,
        articleUrl: "https://x.com/a",
        articleTitle: null,
        publishDate: PUB_DATE,
      }),
      NOW
    );
    expect(patch).toBeNull();
  });

  it("fills only the missing article title (URL already stored)", () => {
    const patch = computePitchOutcomePatch(
      pitch({
        status: "published",
        featuredArticleUrl: "https://x.com/a",
        articleTitle: null,
        publishedAt: new Date(PUB_DATE),
      }),
      null,
      makePublishedArticle({
        featuredQuestionId: 1,
        profileId: 2,
        articleUrl: "https://x.com/a",
        articleTitle: "Now We Have A Title",
        publishDate: PUB_DATE,
      }),
      NOW
    );
    expect(patch).not.toBeNull();
    expect(patch!.articleTitle).toBe("Now We Have A Title");
    expect(patch!.featuredArticleUrl).toBeUndefined(); // unchanged
    expect(patch!.publishedAt).toBeUndefined(); // unchanged
  });

  it("returns null when neither feed matches", () => {
    expect(computePitchOutcomePatch(pitch(), null, null, NOW)).toBeNull();
  });
});
