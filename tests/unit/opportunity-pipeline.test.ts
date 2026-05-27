import { describe, it, expect, vi, beforeEach } from "vitest";
import { rankCandidates } from "../../src/lib/opportunity-pipeline.js";
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

beforeEach(() => {
  vi.mocked(ragScore).mockReset();
  vi.mocked(ragScore).mockImplementation(defaultRagScoreImpl as never);
  mockInsert.mockClear();
  mockValues.mockClear();
  mockOnConflict.mockClear();
});

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
    expect(vi.mocked(ragScore)).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
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
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(out[0].score).toBeCloseTo(1.0);
    expect(out[0].whyRelevant).toBe("score-0");
    expect(out[2].score).toBeCloseTo(0.6);
  });

  it("attaches score and whyRelevant onto every returned row above threshold", async () => {
    const out = await rankCandidates({
      candidates: [{ ...baseCandidate, id: "x", opportunityText: "X" }],
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
      ...baseCandidate,
      id: `c-${i}`,
      opportunityText: `text-${i}`,
    }));

    const out = await rankCandidates({
      candidates,
      orgId: "org-1",
      brandId: "brand-1",
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
      ...baseCandidate,
      id: `c-${i}`,
      opportunityText: `text-${i}`,
    }));

    await expect(
      rankCandidates({
        candidates,
        orgId: "org-1",
        brandId: "brand-1",
        campaignId: "camp-1",
        scoreThreshold: 0,
      })
    ).rejects.toThrow("chat-service");

    expect(mockInsert).not.toHaveBeenCalled();
  });
});
