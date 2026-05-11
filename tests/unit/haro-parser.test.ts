import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHaroEmail } from "../../src/lib/inbound/parsers/haro.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE = readFileSync(
  join(__dirname, "..", "fixtures", "haro-sample.eml"),
  "utf8"
);

/**
 * Lightweight extraction of the `text/plain` part from the raw multipart
 * fixture (decodes quoted-printable). In production, Postmark performs this
 * step and passes the decoded body in `TextBody` to the inbound webhook.
 */
function extractTextPart(eml: string): string {
  const boundaryMatch = eml.match(/boundary="?([^"\r\n;]+)"?/);
  if (!boundaryMatch) throw new Error("No multipart boundary in fixture");
  const boundary = boundaryMatch[1];
  const parts = eml.split(`--${boundary}`);
  for (const part of parts) {
    if (/Content-Type:\s*text\/plain/i.test(part)) {
      const headerEnd = part.search(/\r?\n\r?\n/);
      if (headerEnd === -1) continue;
      const body = part.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
      return decodeQuotedPrintable(body);
    }
  }
  throw new Error("No text/plain part found in fixture");
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

describe("parseHaroEmail", () => {
  const textBody = extractTextPart(FIXTURE);

  it("extracts all 20 queries from the fixture", () => {
    const queries = parseHaroEmail(textBody);
    expect(queries).toHaveLength(20);
  });

  it("populates externalId, pitchEmail, journalistName, mediaOutlet on the first query", () => {
    const queries = parseHaroEmail(textBody);
    const first = queries[0];
    expect(first.pitchEmail).toBe(
      "reply+08394f7b-11b0-48d5-b458-afdfaff90324@helpareporter.com"
    );
    expect(first.externalId).toBe("08394f7b-11b0-48d5-b458-afdfaff90324");
    expect(first.journalistName).toBe("Merilee Kern");
    expect(first.category).toBe("Travel");
    expect(first.mediaOutlet).toContain("JustLuxe");
    expect(first.opportunityText.length).toBeGreaterThan(0);
  });

  it("never returns a query without externalId or pitchEmail", () => {
    const queries = parseHaroEmail(textBody);
    for (const q of queries) {
      expect(q.externalId).toMatch(/^[a-f0-9-]{36}$/i);
      expect(q.pitchEmail).toMatch(
        /^reply\+[a-f0-9-]+@helpareporter\.com$/i
      );
    }
  });

  it("produces unique externalIds across queries", () => {
    const queries = parseHaroEmail(textBody);
    const ids = new Set(queries.map((q) => q.externalId));
    expect(ids.size).toBe(queries.length);
  });

  it("returns empty array on non-HARO text", () => {
    expect(parseHaroEmail("not a haro digest")).toEqual([]);
    expect(parseHaroEmail("")).toEqual([]);
  });
});
