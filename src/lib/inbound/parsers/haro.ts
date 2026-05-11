export interface ParsedHaroQuery {
  /** UUID parsed from `reply+<uuid>@helpareporter.com`; stable per HARO query. */
  externalId: string;
  /** Journalist name as printed by HARO. */
  journalistName: string | null;
  category: string | null;
  /** Headline / "Summary: ..." line. */
  summary: string | null;
  /** Full query body (multi-paragraph). */
  opportunityText: string;
  mediaOutlet: string | null;
  /** Best-effort Date or null if parse fails. */
  deadline: Date | null;
  /** Original deadline string from the email. */
  deadlineRaw: string | null;
  /**
   * Reply alias HARO assigns; this is the address we send the pitch to —
   * HARO masks the real journalist email.
   */
  pitchEmail: string;
  journalistProfileUrl: string | null;
  /** Original raw section text, for debugging / re-parsing. */
  rawSection: string;
}

const SECTION_START_RE = /^(\d+)\)\s+Summary:\s*(.*)$/m;
const REPLY_EMAIL_RE = /reply\+([a-f0-9-]+)@helpareporter\.com/i;
const FIELD_RE = (label: string) =>
  new RegExp(`^${label}\\s*:\\s*(.+?)(?=^\\S|$\\Z)`, "ms");

function stripTrailingFieldMarkers(value: string): string {
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function extractEmail(section: string): string | null {
  const match = section.match(REPLY_EMAIL_RE);
  if (!match) return null;
  return `reply+${match[1]}@helpareporter.com`;
}

function extractExternalId(pitchEmail: string): string | null {
  const match = pitchEmail.match(REPLY_EMAIL_RE);
  return match ? match[1] : null;
}

function extractField(section: string, label: string): string | null {
  const re = new RegExp(
    `^${label}\\s*:\\s*([\\s\\S]*?)(?=^[A-Z][A-Za-z ]{1,40}:|^Query\\s*:|^Back to Top|^-{5,}|\\z)`,
    "m"
  );
  const match = section.match(re);
  if (!match) return null;
  return stripTrailingFieldMarkers(match[1]);
}

function extractQueryBody(section: string): string {
  const idx = section.search(/^Query\s*:\s*$/m);
  if (idx === -1) return "";
  const after = section.slice(idx).replace(/^Query\s*:\s*$/m, "").trim();
  // Trim trailing "Back to Top" + separator lines
  return after
    .replace(/\n-{5,}\s*$/m, "")
    .replace(/\n+Back to Top\s*$/m, "")
    .trim();
}

function extractMediaOutlet(rawValue: string | null): string | null {
  if (!rawValue) return null;
  // "Western Hotelier (https://westernhotelier.com)" -> "Western Hotelier"
  const parenIdx = rawValue.indexOf("(http");
  if (parenIdx !== -1) return rawValue.slice(0, parenIdx).trim();
  return rawValue.trim();
}

const MONTH_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function parseDeadline(raw: string | null, now: Date = new Date()): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Format examples:
  //   "12:00 AM ET - 31 July"
  //   "5:00 PM ET - Tuesday"
  //   "12:00 AM ET - 13 May"
  const dayMonth = trimmed.match(/(\d{1,2})\s+([A-Za-z]+)/);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const monthName = dayMonth[2].toLowerCase();
    const month = MONTH_MAP[monthName];
    if (month === undefined) return null;
    const year = now.getUTCFullYear();
    // If the date has already passed this year by > 30 days, assume next year.
    const candidate = new Date(Date.UTC(year, month, day, 4, 0, 0));
    if (candidate.getTime() < now.getTime() - 30 * 86400_000) {
      return new Date(Date.UTC(year + 1, month, day, 4, 0, 0));
    }
    return candidate;
  }
  return null;
}

/**
 * Parse a HARO digest email TextBody into one row per query.
 * Postmark already MIME-decodes inbound bodies, so the input is plain text.
 *
 * Returns 0..N queries. Sections that cannot extract a reply email are skipped.
 */
export function parseHaroEmail(textBody: string): ParsedHaroQuery[] {
  // Splits on lines like "1) Summary: ..." at the start of each detailed section.
  const sectionStarts: { index: number; queryNum: number; summary: string }[] =
    [];
  const sectionRe = /^(\d+)\)\s+Summary:\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(textBody)) !== null) {
    sectionStarts.push({
      index: m.index,
      queryNum: Number(m[1]),
      summary: m[2].trim(),
    });
  }

  // Use only the *detailed* sections, not the index header. We detect detail
  // sections by requiring a following "Name:" or "Email:" field within ~500 chars.
  const detailed = sectionStarts.filter((s) => {
    const slice = textBody.slice(s.index, s.index + 500);
    return /^Name\s*:/m.test(slice) || /^Email\s*:/m.test(slice);
  });

  const queries: ParsedHaroQuery[] = [];
  for (let i = 0; i < detailed.length; i++) {
    const start = detailed[i].index;
    const end = i + 1 < detailed.length ? detailed[i + 1].index : textBody.length;
    const section = textBody.slice(start, end);

    const pitchEmail = extractEmail(section);
    if (!pitchEmail) continue;
    const externalId = extractExternalId(pitchEmail);
    if (!externalId) continue;

    const summary = detailed[i].summary || extractField(section, "Summary");
    const journalistName = extractField(section, "Name");
    const category = extractField(section, "Category");
    const journalistProfileUrl = extractField(section, "HARO Journalist Profile URL");
    const mediaOutletRaw = extractField(section, "Media Outlet");
    const mediaOutlet = extractMediaOutlet(mediaOutletRaw);
    const deadlineRaw = extractField(section, "Deadline");
    const deadline = parseDeadline(deadlineRaw);
    const queryBody = extractQueryBody(section);

    queries.push({
      externalId,
      journalistName,
      category,
      summary,
      opportunityText: queryBody || section.trim(),
      mediaOutlet,
      deadline,
      deadlineRaw,
      pitchEmail,
      journalistProfileUrl,
      rawSection: section.trim(),
    });
  }

  return queries;
}
