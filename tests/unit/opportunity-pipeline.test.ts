import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  rankOpportunities,
  pickRepresentativeSilver,
} from "../../src/lib/opportunity-pipeline.js";
import { ragScore } from "../../src/lib/chat-client.js";

const { mockInsert, mockValues, mockOnConflict } = vi.hoisted(() => {
  const mockOnConflict = vi.fn(async () => undefined);
  const mockValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflict }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));
  return { mockInsert, mockValues, mockOnConflict };
});

vi.mock("../../src/db/index.js", () => ({
  db: { insert: mockInsert },
}));

vi.mock("../../src/lib/chat-client.js", () => ({
  ragScore: vi.fn(),
}));

const defaultRagScoreImpl = async (req: {
  documents: { id: string; text: string }[];
}) => ({
  results: req.documents.map((d, i) => ({
    id: d.id,
    score: 1 - i * 0.2,
    whyRelevant: `score-${i}`,
  })),
});

const baseOpportunity = {
  representativeSilverId: "00000000-0000-0000-0000-000000000999",
  provider: "featured",
  ingestionChannel: "api",
  featuredQuestionId: null,
  mediaOutlet: null,
  journalistName: null,
  deadline: null,
  pitchUrl: null,
  pitchEmail: null,
  category: null,
  pitchStatus: null,
};

beforeEach(() => {
  vi.mocked(ragScore).mockReset();
  vi.mocked(ragScore).mockImplementation(defaultRagScoreImpl as never);
  mockInsert.mockClear();
  mockValues.mockClear();
  mockOnConflict.mockClear();
});

describe("rankOpportunities", () => {
  it("returns empty when given no candidates", async () => {
    const out = await rankOpportunities({
      candidates: [],
      orgId: "org-1",
      brandIds: ["brand-1"],
      campaignId: "camp-1",
      scoreThreshold: 0.5,
    });
    expect(out).toEqual([]);
    expect(vi.mocked(ragScore)).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("ranks opportunities by score desc and filters below threshold", async () => {
    const candidates = [
      { ...baseOpportunity, opportunityId: "a", opportunityText: "A" },
      { ...baseOpportunity, opportunityId: "b", opportunityText: "B" },
      { ...baseOpportunity, opportunityId: "c", opportunityText: "C" },
      { ...baseOpportunity, opportunityId: "d", opportunityText: "D" },
    ];
    const out = await rankOpportunities({
      candidates,
      orgId: "org-1",
      brandIds: ["brand-1"],
      campaignId: "camp-1",
      scoreThreshold: 0.5,
    });
    expect(out.map((c) => c.opportunityId)).toEqual(["a", "b", "c"]);
    expect(out[0].score).toBeCloseTo(1.0);
    expect(out[0].whyRelevant).toBe("score-0");
    expect(out[2].score).toBeCloseTo(0.6);
  });

  it("attaches score and whyRelevant onto every returned row above threshold", async () => {
    const out = await rankOpportunities({
      candidates: [
        { ...baseOpportunity, opportunityId: "x", opportunityText: "X" },
      ],
      orgId: "org-1",
      brandIds: ["brand-1"],
      campaignId: "camp-1",
      scoreThreshold: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      opportunityId: "x",
      score: 1,
      whyRelevant: "score-0",
    });
  });

  it("chunks candidates into batches of 100 when input exceeds the chat-service cap", async () => {
    vi.mocked(ragScore).mockImplementation(
      (async (req: { documents: { id: string; text: string }[] }) => ({
        results: req.documents.map((d) => ({
          id: d.id,
          score: 0.9,
          whyRelevant: "ok",
        })),
      })) as never
    );

    const candidates = Array.from({ length: 250 }, (_, i) => ({
      ...baseOpportunity,
      opportunityId: `c-${i}`,
      opportunityText: `text-${i}`,
    }));

    const out = await rankOpportunities({
      candidates,
      orgId: "org-1",
      brandIds: ["brand-1"],
      campaignId: "camp-1",
      scoreThreshold: 0,
    });

    expect(vi.mocked(ragScore)).toHaveBeenCalledTimes(3);
    const callSizes = vi
      .mocked(ragScore)
      .mock.calls.map((c) => (c[0] as { documents: unknown[] }).documents.length);
    expect(callSizes.slice().sort((a, b) => b - a)).toEqual([100, 100, 50]);

    expect(out).toHaveLength(250);
    expect(out.every((r) => r.score === 0.9)).toBe(true);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const upsertedRows = (mockValues.mock.calls[0] as [unknown[]])[0];
    expect(upsertedRows).toHaveLength(250);
  });

  it("rejects when any chunk fails and writes no quote_priorities", async () => {
    let callCount = 0;
    vi.mocked(ragScore).mockImplementation(
      (async (req: { documents: { id: string; text: string }[] }) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error(
            "chat-service POST /orgs/rag/score failed (502): upstream"
          );
        }
        return {
          results: req.documents.map((d) => ({
            id: d.id,
            score: 0.9,
            whyRelevant: "ok",
          })),
        };
      }) as never
    );

    const candidates = Array.from({ length: 150 }, (_, i) => ({
      ...baseOpportunity,
      opportunityId: `c-${i}`,
      opportunityText: `text-${i}`,
    }));

    await expect(
      rankOpportunities({
        candidates,
        orgId: "org-1",
        brandIds: ["brand-1"],
        campaignId: "camp-1",
        scoreThreshold: 0,
      })
    ).rejects.toThrow("chat-service");

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("passes brandIds[] plural to ragScore (multi-brand)", async () => {
    let captured: unknown;
    vi.mocked(ragScore).mockImplementation(
      (async (req: unknown) => {
        captured = req;
        return { results: [] };
      }) as never
    );
    await rankOpportunities({
      candidates: [
        { ...baseOpportunity, opportunityId: "x", opportunityText: "X" },
      ],
      orgId: "org-1",
      brandIds: ["brand-1", "brand-2"],
      scoreThreshold: 0,
    });
    expect(captured).toMatchObject({ brandIds: ["brand-1", "brand-2"] });
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
