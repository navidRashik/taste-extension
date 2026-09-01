import { describe, it, expect } from "vitest";
import {
  isTasteSignal,
  isPreferenceCandidate,
  isPromotionLedgerEntry,
  parseChecked,
  parseCheckedArray,
  type TasteSignal,
  type PreferenceCandidate,
  type PromotionLedgerEntry,
} from "../src/schema.js";

const validSignal: TasteSignal = {
  id: "01J000000000000000000SIG",
  kind: "edit",
  strength: 3,
  tool: "write",
  subject: "pkg:script:install",
  evidence: { before: "npm i", after: "pnpm i" },
  scopeHint: "project",
  repo: "git@github.com:acme/app.git",
  turn: 4,
  at: 1_700_000_000_000,
};

const validCandidate: PreferenceCandidate = {
  id: "01J000000000000000000CND",
  statement: "Use pnpm, not npm, for installs in this repo.",
  class: "implementer",
  target: "rule",
  confidence: 0.8,
  scope: "project",
  evidence: [validSignal.id],
  controls: { positive: "pnpm add recharts", negative: "npm install recharts" },
};

const validEntry: PromotionLedgerEntry = {
  id: "01J000000000000000000LED",
  candidateId: validCandidate.id,
  target: "rule",
  scope: "project",
  path: ".omp/rules/prefer-pnpm.md",
  at: 1_700_000_000_001,
  approvedBy: "navid@2026-09-01",
};

describe("isTasteSignal", () => {
  it("accepts a well-formed signal", () => {
    expect(isTasteSignal(validSignal)).toBe(true);
  });

  it("rejects a bad kind", () => {
    expect(isTasteSignal({ ...validSignal, kind: "approve" })).toBe(false);
  });

  it("rejects an out-of-range strength", () => {
    expect(isTasteSignal({ ...validSignal, strength: 4 })).toBe(false);
  });

  it("rejects a non-numeric turn", () => {
    expect(isTasteSignal({ ...validSignal, turn: "4" })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isTasteSignal(null)).toBe(false);
    expect(isTasteSignal([validSignal])).toBe(false);
    expect(isTasteSignal("x")).toBe(false);
  });
});

describe("isPreferenceCandidate", () => {
  it("accepts a well-formed candidate with controls", () => {
    expect(isPreferenceCandidate(validCandidate)).toBe(true);
  });

  it("accepts a candidate without controls", () => {
    const { controls, ...rest } = validCandidate;
    void controls;
    expect(isPreferenceCandidate(rest)).toBe(true);
  });

  it("rejects an unknown class", () => {
    expect(isPreferenceCandidate({ ...validCandidate, class: "vibe" })).toBe(false);
  });

  it("rejects controls missing the negative side", () => {
    expect(isPreferenceCandidate({ ...validCandidate, controls: { positive: "x" } })).toBe(false);
  });

  it("rejects non-string evidence ids", () => {
    expect(isPreferenceCandidate({ ...validCandidate, evidence: [1, 2] })).toBe(false);
  });
});

describe("isPromotionLedgerEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(isPromotionLedgerEntry(validEntry)).toBe(true);
  });

  it("accepts an entry without an approval token", () => {
    const { approvedBy, ...rest } = validEntry;
    void approvedBy;
    expect(isPromotionLedgerEntry(rest)).toBe(true);
  });

  it("rejects a non-boolean quarantined flag", () => {
    expect(isPromotionLedgerEntry({ ...validEntry, quarantined: "yes" })).toBe(false);
  });
});

describe("parseChecked", () => {
  it("round-trips a valid object", () => {
    expect(parseChecked(JSON.stringify(validSignal), isTasteSignal)).toEqual(validSignal);
  });

  it("returns null on malformed JSON", () => {
    expect(parseChecked("{not json", isTasteSignal)).toBeNull();
  });

  it("returns null on a shape mismatch", () => {
    expect(parseChecked(JSON.stringify({ id: "x" }), isTasteSignal)).toBeNull();
  });
});

describe("parseCheckedArray", () => {
  it("round-trips an array of valid objects", () => {
    const raw = JSON.stringify([validSignal, { ...validSignal, id: "01J000000000000000000SI2" }]);
    const out = parseCheckedArray(raw, isTasteSignal);
    expect(out).toHaveLength(2);
  });

  it("rejects the whole batch if one row is malformed", () => {
    const raw = JSON.stringify([validSignal, { ...validSignal, kind: "nope" }]);
    expect(parseCheckedArray(raw, isTasteSignal)).toBeNull();
  });

  it("returns null when the payload is not an array", () => {
    expect(parseCheckedArray(JSON.stringify(validSignal), isTasteSignal)).toBeNull();
  });
});
