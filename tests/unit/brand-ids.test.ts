import { describe, it, expect } from "vitest";
import {
  BrandIdsHeaderError,
  canonBrandIds,
  parseBrandIdsHeader,
} from "../../src/lib/brand-ids.js";

describe("canonBrandIds", () => {
  it("sorts ascending and dedups", () => {
    const out = canonBrandIds([
      "22222222-2222-2222-2222-222222222222",
      "11111111-1111-1111-1111-111111111111",
      "11111111-1111-1111-1111-111111111111",
    ]);
    expect(out).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("empty input → empty output", () => {
    expect(canonBrandIds([])).toEqual([]);
  });
});

describe("parseBrandIdsHeader", () => {
  it("parses a single UUID", () => {
    expect(
      parseBrandIdsHeader("11111111-1111-1111-1111-111111111111")
    ).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  it("parses CSV and canonicalizes (sort + dedup)", () => {
    expect(
      parseBrandIdsHeader(
        "33333333-3333-3333-3333-333333333333,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222"
      )
    ).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    ]);
  });

  it("tolerates whitespace inside the CSV", () => {
    expect(
      parseBrandIdsHeader(
        " 11111111-1111-1111-1111-111111111111 , 22222222-2222-2222-2222-222222222222 "
      )
    ).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("throws when header is missing", () => {
    expect(() => parseBrandIdsHeader(undefined)).toThrow(
      BrandIdsHeaderError
    );
  });

  it("throws when header is empty", () => {
    expect(() => parseBrandIdsHeader("")).toThrow(BrandIdsHeaderError);
    expect(() => parseBrandIdsHeader(" , ")).toThrow(BrandIdsHeaderError);
  });

  it("throws when any token is not a UUID", () => {
    expect(() =>
      parseBrandIdsHeader(
        "11111111-1111-1111-1111-111111111111,not-a-uuid"
      )
    ).toThrow(BrandIdsHeaderError);
  });
});
