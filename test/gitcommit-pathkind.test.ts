// gitcommit-pathkind.test.ts — what KIND of path may be staged.
//
// The subtree check proves a pathspec belongs to Taste. It does not prove
// the pathspec is one file: the taste root itself, and every directory
// under it, passes that check too. `git add` handed a directory stages
// every file beneath it, so a writer returning a directory would publish
// the whole subtree with every other guard still green. These cases hold
// the type check that closes that, and they hold it through the injected
// seam so the filesystem shape is declared rather than built on disk.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  commitArtefact,
  commitRemoval,
  type CommitPlan,
  type GitResult,
  type GitRunner,
  type PathKind,
} from "../src/gitcommit.js";
import type { PreferenceCandidate } from "../src/schema.js";

const CWD = "/repo";
const PLAN: CommitPlan = { repoRoot: CWD, tasteRoot: join(CWD, ".omp") };
const ARTEFACT = join(CWD, ".omp", "skills", "taste-pc_kind01", "SKILL.md");

function candidate(): PreferenceCandidate {
  return {
    id: "pc_kind01",
    statement: "prefer pnpm over npm",
    class: "implementer",
    target: "skill",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_kind01"],
  };
}

/**
 * A seam that spawns nothing and answers the type probe from one declared
 * kind, so each case states the filesystem shape it is about instead of
 * making it. Every argv is recorded, so a test can prove staging never
 * happened as well as prove the throw.
 */
function seam(kind: PathKind): { git: GitRunner; argvs: string[][] } {
  const argvs: string[][] = [];
  const git: GitRunner = {
    run(_cwd, args): GitResult {
      argvs.push(args);
      return { status: 0, stdout: "" };
    },
    exists: () => true,
    pathKind: () => kind,
  };
  return { git, argvs };
}

describe("staging refuses a pathspec that is not the single file it claims to be", () => {
  it("REFUSES to publish a directory, and reaches git with nothing at all", () => {
    // The gap this closes: the directory is inside the taste subtree, so
    // every pre-existing check passes it. Staging it would have published
    // everything underneath.
    const dir = join(CWD, ".omp", "skills");
    const { git, argvs } = seam("directory");
    expect(() => commitArtefact(PLAN, CWD, dir, candidate(), git)).toThrow(
      /pathspec is a directory/,
    );
    expect(argvs).toEqual([]);
  });

  it("REFUSES to publish the taste root itself", () => {
    // The subtree check accepts the root as "inside itself", which is the
    // widest directory a pathspec could name.
    const { git, argvs } = seam("directory");
    expect(() => commitArtefact(PLAN, CWD, PLAN.tasteRoot, candidate(), git)).toThrow(
      /pathspec is a directory/,
    );
    expect(argvs).toEqual([]);
  });

  it("REFUSES to publish a path that is not there, rather than letting git say so", () => {
    const { git, argvs } = seam("absent");
    expect(() => commitArtefact(PLAN, CWD, ARTEFACT, candidate(), git)).toThrow(
      /not a regular file \(absent\)/,
    );
    expect(argvs).toEqual([]);
  });

  it("REFUSES to publish a path that exists but is not a regular file", () => {
    const { git, argvs } = seam("other");
    expect(() => commitArtefact(PLAN, CWD, ARTEFACT, candidate(), git)).toThrow(
      /not a regular file \(other\)/,
    );
    expect(argvs).toEqual([]);
  });

  it("REFUSES a removal whose pathspec is a directory", () => {
    const { git, argvs } = seam("directory");
    expect(() => commitRemoval(PLAN, CWD, join(CWD, ".omp", "skills"), "pl_kind01", git)).toThrow(
      /pathspec is a directory/,
    );
    expect(argvs).toEqual([]);
  });

  it("ACCEPTS a removal whose artefact is already gone, because the caller deletes it first", () => {
    // Asymmetry on purpose: a forget unlinks the artefact and only then
    // commits the deletion, so absence is the normal state here. Requiring
    // an existing file would refuse every real removal.
    const { git, argvs } = seam("absent");
    const args = commitRemoval(PLAN, CWD, ARTEFACT, "pl_kind01", git);
    expect(args).toEqual(["commit", "--only", "-m", "taste: forget promotion pl_kind01", "--", ARTEFACT]);
    expect(argvs[0]).toEqual(["add", "--", ARTEFACT]);
  });

  it("leaves the happy paths exactly as they were: one file in, the same two argv out", () => {
    const publish = seam("file");
    const publishArgs = commitArtefact(PLAN, CWD, ARTEFACT, candidate(), publish.git);
    expect(publish.argvs).toEqual([
      ["add", "--", ARTEFACT],
      publishArgs,
    ]);
    expect(publishArgs).toEqual([
      "commit",
      "--only",
      "-m",
      "taste: promote skill preference pc_kind01 (project scope)",
      "--",
      ARTEFACT,
    ]);

    // A removal may also name a file that is still on disk — an approval
    // reversal rewrites its config rather than deleting it — and that is
    // accepted just as absence is.
    const remove = seam("file");
    const removeArgs = commitRemoval(PLAN, CWD, ARTEFACT, "pl_kind01", remove.git);
    expect(remove.argvs).toEqual([
      ["add", "--", ARTEFACT],
      removeArgs,
    ]);
  });

  it("still refuses a pathspec outside the taste subtree before it ever asks what kind it is", () => {
    // Order matters: the subtree check is the outer gate and stays first,
    // so an escaping path is refused on escaping, not on its file type.
    const { git, argvs } = seam("file");
    expect(() => commitArtefact(PLAN, CWD, "/etc/passwd", candidate(), git)).toThrow(
      /escapes the taste subtree/,
    );
    expect(argvs).toEqual([]);
  });
});
