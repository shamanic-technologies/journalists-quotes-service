import { describe, it, expect, vi } from "vitest";
import { rankCandidates } from "../../src/lib/opportunity-pipeline.js";

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => undefined),
      })),
    })),
  },
}));

vi.mock("../../src/lib/chat-client.js", () => ({
  ragScore: vi.fn(async (req: { documents: { id: string; text: string }[] }) => ({
    results: req.documents.map((d, i) => ({
      id: d.id,
      score: 1 - i * 0.2,
      whyRelevant: `score-${i}`,
    })),
  })),
}));

const baseCandidate = {
  provider: "featured",
  ingestionChannel: "api",
  featuredQuestionId: null,
  mediaOutlet: null,
  journalistName: null,
  deadline: null,
  pitchUrl: null,
  pitchEmail: null,
  category: null,
};

describe("rankCandidates", () => {
  it("returns empty when given no candidates", async () => {
    const out = await rankCandidates({
      candidates: [],
      orgId: "org-1",
      brandId: "brand-1",
      campaignId: "camp-1",
      scoreThreshold: 0.5,
    });
    expect(out).toEqual([]);
  });

  it("ranks candidates by score desc and filters below threshold", async () => {
    const candidates = [
      { ...baseCandidate, id: "a", opportunityText: "A" },
      { ...baseCandidate, id: "b", opportunityText: "B" },
      { ...baseCandidate, id: "c", opportunityText: "C" },
      { ...baseCandidate, id: "d", opportunityText: "D" },
    ];
    const out = await rankCandidates({
      candidates,
      orgId: "org-1",
      brandId: "brand-1",
      campaignId: "camp-1",
      scoreThreshold: 0.5,
    });
    // Mock assigns 1.0, 0.8, 0.6, 0.4 (i=0..3). Threshold 0.5 drops the last.
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(out[0].score).toBeCloseTo(1.0);
    expect(out[0].whyRelevant).toBe("score-0");
    expect(out[2].score).toBeCloseTo(0.6);
  });

  it("attaches score and whyRelevant onto every returned row above threshold", async () => {
    const out = await rankCandidates({
      candidates: [
        { ...baseCandidate, id: "x", opportunityText: "X" },
      ],
      orgId: "org-1",
      brandId: "brand-1",
      campaignId: "camp-1",
      scoreThreshold: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "x",
      score: 1,
      whyRelevant: "score-0",
    });
  });
});
