import { describe, it, expect } from "vitest";
import { IRREVERSIBLE_FAMILIES, assertDenylistWellFormed, irreversibleFamily } from "../src/denylist.js";
import { subjectOf } from "../src/fingerprint.js";

describe("denylist: fingerprint-normal entries", () => {
  it("every entry passes the well-formed self-check (no flags, no wildcards, round-trips through subjectOf)", () => {
    expect(() => assertDenylistWellFormed()).not.toThrow();
  });

  it("every entry is bash-prefixed and has no leading-hyphen (flag) tokens or wildcards", () => {
    for (const key of Object.keys(IRREVERSIBLE_FAMILIES)) {
      expect(key.startsWith("bash:")).toBe(true);
      expect(key).not.toContain("*");
      for (const tok of key.slice("bash:".length).split(/\s+/)) {
        // Leading hyphen is a flag; interior hyphens are legal (ssh-keygen).
        expect(tok.startsWith("-")).toBe(false);
      }
    }
  });
});

describe("denylist: irreversibleFamily matches every form the fingerprinter emits", () => {
  const cases: Array<[string, string]> = [
    ["rm -rf build/", "bash:rm"],
    ["rm foo.txt", "bash:rm"],
    // Fingerprinter absorbs a bare positional word into the head; the
    // prefix match still catches this because "bash:rm foo *" starts with
    // "bash:rm ". That is the whole point of family-space matching.
    ["rm foo", "bash:rm"],
    ["rm foo bar baz", "bash:rm"],
    ["git push --force origin main", "bash:git push"],
    ["git push origin main", "bash:git push"],
    ["git commit --amend --no-edit", "bash:git commit"],
    ["git commit -m wip", "bash:git commit"],
    ["git tag v1.2.3", "bash:git tag"],
    ["npm publish --access public", "bash:npm publish"],
    ["pnpm publish", "bash:pnpm publish"],
    ["cargo publish --token XXX", "bash:cargo publish"],
    ["gh auth login", "bash:gh auth"],
    ["aws configure set foo bar", "bash:aws configure"],
    ["gcloud auth application-default login", "bash:gcloud auth"],
    ["ssh-keygen -t ed25519", "bash:ssh-keygen"],
    ["alembic upgrade head", "bash:alembic upgrade"],
    ["prisma migrate deploy", "bash:prisma migrate"],
    ["knex migrate up", "bash:knex migrate"],
  ];

  for (const [command, expected] of cases) {
    it(`${JSON.stringify(command)} matches family ${expected}`, () => {
      const subject = subjectOf("bash", { command });
      expect(irreversibleFamily(subject)).toBe(expected);
    });
  }
});

describe("denylist: benign commands do NOT match a family", () => {
  const benign = [
    "ls -la",
    "pnpm add recharts",
    "vitest run",
    "cat foo.txt",
    "grep -r x .",
    // Starts with "rm" but is a different command; trailing-space guard
    // rejects it.
    "rmdir emptydir",
    "git status",
    "git log",
  ];
  for (const command of benign) {
    it(`${JSON.stringify(command)} is NOT on the denylist`, () => {
      const subject = subjectOf("bash", { command });
      expect(irreversibleFamily(subject)).toBeUndefined();
    });
  }
});

describe("denylist: known gap flagged rather than silently hidden", () => {
  // knex/prisma-style colon-subcommands normalise to `bash:<argv[0]> *`
  // because the fingerprinter treats `:` as a subcommand-token break. A
  // family entry keyed on `bash:knex migrate` therefore does NOT match
  // `knex migrate:latest`. Closing this gap needs the spec's
  // "pre-normalisation raw args" escape hatch, which is intentionally out
  // of scope for this slice; documenting the gap as an assertion so a
  // later slice that closes it will make this test go RED and force the
  // author to update the expectation.
  it("knex migrate:latest is a known miss under family-space matching alone", () => {
    const subject = subjectOf("bash", { command: "knex migrate:latest" });
    expect(subject).toBe("bash:knex *");
    expect(irreversibleFamily(subject)).toBeUndefined();
  });
});
