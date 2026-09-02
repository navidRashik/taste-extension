# Architecture

How Taste is built, and why each safety choice is where it is. The diagrams carry the *what*; the
prose exists to explain the *why*.

Taste is one OMP extension module. Its default export registers a handler for each of eight harness
events and one slash command, and every one of those handlers is a leaf on a very short tree: observe,
count, distil, filter, write, reverse. Nothing in it runs on the interactive thread longer than a map
lookup, and nothing in it can throw into a session.

---

## Component map

```mermaid
flowchart TB
  subgraph ENTRY["Entry point"]
    IDX["index.ts<br/>registers 8 event handlers + /taste<br/>owns the safely wrapper and the health record"]
  end

  subgraph GATING["Gating — read on every single handler call"]
    CFG["config.ts<br/>3-layer resolution, cached on mtime+size+inode<br/>enabled false by default"]
  end

  subgraph CAPTURE["Stage 1 — Capture"]
    CAP["capture.ts<br/>events → accept / reject / edit signals<br/>per-ctx WeakMap state, dies with the session"]
    RED["redact.ts<br/>the ONLY boundary between raw text and disk"]
    FPR["fingerprint.ts<br/>subjectOf: the recurrence axis both<br/>capture and inference agree on"]
    CAP --> RED --> FPR
  end

  subgraph ROLLUP["Stage 2 — Rollup"]
    RUP["rollup.ts<br/>in-memory bucket map, hot path is O of 1<br/>flushed once per session to state.json"]
  end

  subgraph INFER["Stage 3 — Inference"]
    INFC["inference.ts<br/>recurrence gate, decay, supersession,<br/>single-flight + recursion guard"]
    INV["invoker.ts<br/>spawns omp -p --smol via pi.exec<br/>parses ONE fixed-shape JSON reply"]
    INFC --> INV
  end

  subgraph FILTER["Stage 4 — Safety spine"]
    DEN["denylist.ts<br/>IRREVERSIBLE_FAMILIES, fingerprint-keyed<br/>self-checks itself at import time"]
    PRM["promote.ts<br/>pre-filter, class filter, dispatcher, ledger"]
    DEN --> PRM
  end

  subgraph WRITE["Stage 5 — Promotion targets"]
    WRT["writers.ts<br/>skill, memory, rule<br/>atomic write + read-back proof"]
    APV["approval.ts<br/>structural line merge into config.yml<br/>proven reversible before it is kept"]
    ALW["allowlist.ts<br/>NON_MUTATING_FAMILIES positive list<br/>proven disjoint from the denylist at import"]
    TTS["ttsr.ts<br/>two-sided negative-control runner"]
    GIT["gitcommit.ts<br/>project-scope publication, argv-guarded"]
    APV --> ALW
  end

  subgraph LIVE["Stage 6-7 — Apply and reverse"]
    APL["apply.ts<br/>session_start trigger, ledger fold, staleness"]
    FGT["forget.ts<br/>the only undo; writes tombstones"]
    CMD["command.ts<br/>/taste — the only user-visible surface"]
  end

  SCH["schema.ts<br/>on-disk contracts + hand-written guards.<br/>A malformed row parses to null, never throws."]

  IDX --> CFG
  IDX --> CAPTURE
  CAPTURE --> ROLLUP --> INFER --> FILTER
  FILTER --> WRT & APV & TTS & GIT
  WRITE --> LIVE
  SCH -.->|"validates every disk read"| ROLLUP
  SCH -.-> INFER
  SCH -.-> FILTER
  SCH -.-> LIVE
```

**Why `config.ts` is read on every handler call rather than once at load.** A kill switch that needs a
restart is not a kill switch. `safely()` re-resolves the config per invocation; the cost is amortised
by a cache keyed on the layer files' stat tuple, so the steady-state cost is three `statSync` calls and
a map lookup.

**Why `redact.ts` sits *upstream* of `fingerprint.ts` and not beside it.** If redaction ran after
normalisation, a token-shaped literal could survive as a substring of the subject and then be counted,
persisted and shipped into an inference prompt. Ordering it first makes "no secret reaches the subject"
a structural property rather than a review item.

---

## Stage 1 — Capture: events to signals

Eight events are registered. Only four of them ever bank a signal; the other four exist to maintain
the state the banking depends on.

```mermaid
flowchart LR
  SS["session_start"] --> A1["track main session file<br/>reset per-ctx capture state<br/>seed rollup from disk<br/>run the application path"]

  TC["tool_call"] --> A2["remember lastAction:<br/>tool, subject, turn, redacted rawArgs.<br/>Banks nothing."]

  TR["tool_result"] --> A3["for write/edit/apply_patch:<br/>snapshot the file the agent wrote.<br/>Skips binary and files over 256 KB.<br/>Banks nothing."]

  IN["input"] --> A4["1 · snapshot diverged → EDIT signal, strength 3<br/>2 · correction verb + a bound lastAction → REJECT, strength 2<br/>3 · finalise pending accept, but only if step 2 did not<br/>cancel it — this ordering IS the two-state machine"]

  TE["turn_end"] --> A5["queue a PENDING ACCEPT for the turn's<br/>unchallenged action. Banks nothing yet."]

  TT["ttsr_triggered"] --> A6["a guard fired on the agent's own args<br/>→ REJECT block, strength 2<br/>lastAction nulled: it is no longer unchallenged"]

  TA["tool_approval_resolved"] --> A7["a human refused the call<br/>→ REJECT denial, strength 2<br/>lastAction nulled"]

  ST["session_stop"] --> A8["finalise any surviving pending accept → ACCEPT, strength 1<br/>flush rollup to state.json<br/>THEN run one inference pass"]

  A4 --> LEDGER
  A6 --> LEDGER
  A7 --> LEDGER
  A8 --> LEDGER

  LEDGER["bank in capture.ts<br/>pi.appendEntry under sh.omp.taste.signal<br/>AND rollupTouch with an explicit field projection —<br/>one function, so the two writes can never diverge"]
```

**Why an accept is never banked when it is observed.** An accept is the absence of a correction, and
absence is not observable at the moment the action happens. `turn_end` therefore only *queues* it. The
next `input` runs the correction path first and the finalisation path last, so a correction arriving in
that same input **cancels** the queued accept instead of banking it alongside a contradicting reject.
`session_stop` finalises whatever survived, because a session can end before the next input ever
arrives.

**Why a subagent's signals are dropped.** A subagent session has no human in it to learn from. Its
traffic would look exactly like unchallenged agent behaviour and would inflate accept counts for
whatever the subagent happened to do. `safely()` suppresses it with a session-file-leaf predicate, and
capture state lives in a `WeakMap` keyed on the `ExtensionContext` object, so even if suppression were
bypassed a subagent could not contaminate the main session's state.

**Why the fingerprint discards the literal.** Recurrence must count a *family* of actions. `npm install
recharts` and `npm install lodash` both normalise to `bash:npm install *`; a file edit normalises to
`edit:*.ts:describe` — extension plus a construct token, never the path. Counting literals would mean
nothing ever recurs.

---

## Stage 2 — Rollup: bounded by construction

The rollup is two tiers of one shape. An in-process `globalThis` map keyed by
`(scopeHint, repo, subject)` absorbs every touch at O(1); `state.json` under `~/.omp/agent/taste/` is
written exactly once per session, at `session_stop`.

| Bound | Value | What it stops |
|---|---|---|
| `MAX_PER_BUCKET` | 32 signals, ring | A hot subject growing a bucket without limit |
| `MAX_SEEN_IDS` | 1024 ids, ring | The dedupe set outliving its usefulness |
| `MAX_BUCKETS` | 4096 | Total state size; oldest-touched are evicted first |
| `RETENTION_MS` | 30 days | Buckets nobody has touched in a month |
| `ROLLUP_SNIPPET_CAP` | 200 chars | Snippet egress into the accumulator |
| `SNAPSHOT_CAP` | 128 paths per session | An agent that writes thousands of files |
| `MAX_SNAPSHOT_BYTES` | 256 KB | Diffing a file too large to be worth diffing |
| `HUNK_CAP` | 4096 chars per side | An edit hunk ballooning the ledger |

The disk mutation is `acquire lock → read existing → merge → write temp → rename → release`. Two
sessions stopping at the same instant merge rather than clobber, because the merge unions the seen-id
sets — the same signal id touched by both peers still counts once. A crash between temp write and
rename leaves the previous good file for the next read to parse, and a lock older than 30 seconds is
broken so a crashed process cannot wedge the accumulator forever.

Compaction preserves the surviving occurrence count. Trimming a bucket's signal ring must never look
like the preference stopped recurring.

---

## Stage 3 — Inference: off the interactive thread

At `session_stop`, after the flush, `runInference` walks the rollup and keeps only buckets that pass
the recurrence gate: **3 signals**, or **2 strength-3 edits** as a shortcut, because a human rewriting
the agent's own output twice is a louder signal than three light accepts.

Each surviving bucket is sanitised into an `InferenceInput` and handed to the summariser. In production
that is `invoker.ts`, which spawns `omp -p --smol=default --mode json --no-session --no-title
--no-extensions --no-skills <prompt>` through `pi.exec` with a 15-second budget. The reply must parse
as a single JSON object carrying `statement`, a known `class` and a known `target`; anything else —
prose, a wrong enum, a timeout, a non-zero exit — yields `null` and that bucket simply produces no
candidate this pass.

Confidence is arithmetic, not model output:

```
confidence = baseConfidence(bucket)          # recurrence x strength, saturating at ~1.0 by N=3
           x 0.5 ^ (idleTime / 14 days)      # exponential decay, asymptotes to zero
           x supersessionFactor(signals)     # cut when newer accepts contradict older rejects
```

**Why the model never sets confidence.** A summariser is good at naming what a cluster of corrections
has in common and bad at knowing how much evidence there was. Recurrence, decay and supersession are
facts the rollup already holds, so they are computed here and the model is asked for one sentence and
two enums.

**Why the pass is guarded twice.** `runInference` checks its single-flight slot *before* the recursion
marker, then sets the marker once around the whole concurrent batch. Checking the marker first would
misclassify a sibling call inside the same batch as a spawned child. The child itself sees the
environment marker and short-circuits, and `--no-extensions` in the child argv is the belt to that
brace — Taste cannot recurse into itself.

**Why the whole pass is fail-open.** Every layer — load, gate, summarise, derive, persist — returns
`{ ran: false, reason }` rather than throwing. The worst outcome of a broken inference pass is that
Taste learns nothing this session.

---

## Stage 4-5 — Promotion: the decision flowchart

This is the load-bearing diagram. Everything above it is bookkeeping; everything below it writes to
disk.

```mermaid
flowchart TB
  START["promote candidate, ctx, opts"] --> SUBJ["subjectForCandidate:<br/>resolve the fingerprint subject from the rollup<br/>using the candidate's evidence signal ids"]
  SUBJ --> PATH{"opts.approvedBy set?"}

  PATH -->|"NO — automatic path"| DENY{"irreversibleFamily subject<br/>denylist.ts, runs FIRST"}
  PATH -->|"YES — human approved via /taste promote"| SUPP

  DENY -->|"MATCH"| Q1["return queued<br/>reason: irreversible-family:bash:git push<br/>A MISLABELLED rm CAN NEVER AUTO-ARM.<br/>The human may still approve it later."]
  DENY -->|"no match"| CLS{"candidate.class"}

  CLS -->|"scope · behaviour · commitment"| Q2["return queued<br/>reason: decision-class:behaviour<br/>NEVER AUTO-ARMS"]
  CLS -->|"implementer"| SUPP{"SUPPORTED_TARGETS<br/>skill · memory · rule · approval"}

  SUPP -->|"unknown target"| UNS["return unsupported"]
  SUPP -->|"supported"| PRE{"project scope AND<br/>a committed target?"}

  PRE -->|"yes"| PF["preflightAutoCommit BEFORE any write.<br/>A repo that cannot take a clean single-path commit<br/>refuses with NOTHING on disk."]
  PRE -->|"no"| DISP
  PF --> DISP{"dispatch by target"}

  DISP -->|"skill"| WSK["writers.ts: SKILL.md into skills slot<br/>atomic write, then read back byte-for-byte"]
  DISP -->|"memory"| WME["writers.ts: ctx.memory.save if the runtime exposes it,<br/>else stage a JSON row under pending-memories"]
  DISP -->|"approval"| WAP["approval.ts: family MUST be on the non-mutating allowlist,<br/>rule validated, merged into config.yml by line insertion,<br/>proven by removing those lines and recovering the prior bytes"]
  DISP -->|"rule"| WRU["armRule: write the .md, then TWO-SIDED CONTROL —<br/>positive MUST trigger, negative MUST stay silent"]

  WRU -->|"either side fails"| DEL["unlink the staged rule file<br/>and rethrow"]
  DEL --> QUAR
  WSK --> COMMIT
  WME --> COMMIT
  WAP --> COMMIT
  WRU -->|"both controls pass"| COMMIT

  COMMIT{"a commit plan was taken?"} -->|"yes"| GC["commitArtefact:<br/>re-validate pathspec inside the taste subtree,<br/>stage exactly one file, commit with --only"]
  COMMIT -->|"no"| LED
  GC --> LED["append PromotionLedgerEntry to promotion-ledger.jsonl<br/>with approvedBy when a human approved.<br/>return promoted"]

  WSK -.->|"any throw"| QUAR
  WME -.->|"any throw"| QUAR
  WAP -.->|"any throw"| QUAR
  GC -.->|"any throw"| QUAR
  PF -.->|"any throw"| QUAR

  QUAR["QUARANTINED<br/>append a ledger row with quarantined true and the reason.<br/>The caller never sees a half-armed artefact reported as promoted."]
```

### Why the denylist runs before the class check

The class label comes from a language model. The denylist does not. If the class filter ran first, a
model that mislabelled a preference about `rm -rf` as `implementer` would carry that candidate all the
way to a writer. Running a deterministic, fingerprint-keyed family check *ahead* of the label means the
worst a mislabel can do is send something to the review queue that a human would have approved anyway —
the failure is in the safe direction. `denylist.ts` covers deletion, the `git push` / `commit` / `tag`
publication family, `npm` / `pnpm` / `yarn` / `cargo publish`, credential writes such as `gh auth`,
`aws configure`, `gcloud auth` and `ssh-keygen`, and data-plane migrations such as `alembic upgrade`,
`prisma migrate` and `knex migrate`.

Entries are keyed in **fingerprint space** and the module proves it at import time:
`assertDenylistWellFormed()` composes a real command from each entry, runs it through `subjectOf()`, and
throws unless the fingerprinter emits the same head. An entry written as `bash:rm -rf` could never match
a real subject — flags are stripped during normalisation — so that class of maintainer bug fails loud
at load rather than silently never matching.

Matching is a prefix match on `<family> ` with the trailing space required. `bash:rmdir *` does not
start with `bash:rm `, so the narrowing cannot broaden to a different command, while every genuine
`bash:rm …` subject is caught — including the shapes where the fingerprinter absorbed a bare positional
word into the head.

### Why a guard rule needs a two-sided control

A guard nobody has seen fire is not a guard. Before any rule Taste writes is trusted, `ttsr.ts` shells
out to the harness's own rule tester twice:

- **Positive** — the offending snippet from the candidate's real backing evidence **must** trigger the
  rule. A rule silent on its own reason for existing is broken.
- **Negative** — a benign snippet from the same subject family **must not** trigger. A rule that fires
  on legitimate input is a liability.

Either failing deletes the staged file and quarantines. A runner fault — bad JSON, missing binary,
timeout — returns `false`, which is safe on the negative side and forces quarantine on the positive
side, so a broken runner can never arm a rule.

The negative snippet comes from the summariser, but it is only accepted if it normalises to the
*positive's* subject family under the shared fingerprinter. A control that does not belong to the
family it claims to test proves nothing, so both sides are dropped and the writer quarantines rather
than arming on synthesised proof.

Approval does not weaken this. `opts.approvedBy` bypasses the class filter, because that is what human
approval means, but it does **not** bypass the controls — the control is a safety property of the
artefact itself, not of the path that produced it.

### Why an auto-approval needs a positive list

A learned approval removes a human from the loop for every future invocation of a command family, which
is the largest blast radius of any target. `allowlist.ts` is therefore expressed positively: a family
earns auto-approval by being on the list, never by failing to be on the denylist. Absence is refusal.

`assertAllowlistWellFormed()` runs at import and catches two failure modes: an entry no real fingerprint
could match, and an entry whose prefix subsumes a denied family. That second check is why the bare
`bash:git` family is deliberately absent — it would prefix-match `bash:git push`. Only the read-only
porcelain is listed: `git status`, `git diff`, `git log`, `git show`, `git blame`.

The entry is appended to the **end** of the ordered `bash.patterns` list in the scoped `config.yml`.
First match wins, so appending guarantees a learned `allow` can never override a `deny` or `prompt` a
human wrote by hand. The merge is pure line insertion, and the write is proven both ways: the file must
read back as written, *and* removing exactly the inserted lines must recover the previous content
byte-for-byte. Either proof failing throws, and the promoter quarantines.

### Why every writer re-reads what it wrote

A write is only "done" when the artefact can be read back. `atomicWrite` is write-temp-plus-rename, so a
concurrent writer cannot leave a torn file and a crash before the rename leaves the previous good file.
The read-back is the second half: a round-trip mismatch throws, the promoter quarantines, and the
ledger records the failure. A half-written artefact never reaches the ledger claiming to be armed.

Filenames are derived from the candidate id through a traversal-proof slug, never from the candidate's
prose. The statement text originates in a human's own correction and could contain anything.

---

## Stage 6 — Session lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant H as Human
  participant OMP as OMP harness
  participant IDX as index.ts
  participant CAP as capture.ts
  participant RU as rollup.ts
  participant AP as apply.ts
  participant PR as promote.ts
  participant INF as inference.ts
  participant CH as smol child process

  Note over OMP,IDX: SESSION START
  OMP->>IDX: session_start
  IDX->>IDX: trackMainSession, then enter safely
  IDX->>CAP: resetCaptureState for this ctx
  IDX->>RU: ensureLoaded, seed buckets from state.json
  IDX->>AP: applyAtSessionStart
  AP->>AP: enabled? autoPromote? else return disabled / not-opted-in
  AP->>AP: fold promotion-ledger.jsonl into armed / tombstoned / quarantined
  loop each candidate in candidates.json, max 8 per start
    AP->>AP: not implementer -> count as queued, never read into a write
    AP->>AP: already armed, tombstoned, or confidence below 0.25 -> skip
    AP->>PR: promote candidate
    PR-->>AP: promoted / queued / quarantined
  end
  AP->>OMP: sendMessage sh.omp.taste.applied, deliverAs nextTurn
  Note over H,AP: The human is told what was armed. Nothing decision-class is mentioned.

  Note over H,RU: THE SESSION ITSELF
  loop every turn
    OMP->>IDX: tool_call, tool_result, input, turn_end, ttsr_triggered, tool_approval_resolved
    IDX->>IDX: re-resolve config, drop if disabled or subagent
    IDX->>CAP: handler body
    CAP->>RU: rollupTouch, in memory only
  end

  Note over OMP,CH: SESSION STOP — order matters
  OMP->>IDX: session_stop
  IDX->>CAP: onSessionStop, finalise a surviving pending accept
  IDX->>RU: flushAccumulator, lock and merge into state.json
  IDX->>INF: runInference
  INF->>INF: single-flight, then set the recursion marker for the batch
  INF->>INF: keep buckets passing the gate, cap at 64, newest first
  par one child per surviving bucket, 30s total budget
    INF->>CH: pi.exec omp -p --smol, 15s each
    CH-->>INF: one JSON object, or null
  end
  INF->>INF: write candidates.json atomically
  Note over INF: Nothing is armed here. Arming happens at the NEXT session start.
```

**Why inference runs at stop and application at start.** The pass is a summariser over the freshly
flushed rollup, so flushing first is what makes the current session count toward recurrence. Running it
after the human's last turn keeps the interactive thread free of it entirely. Application then happens
at the next start, which is also the moment the harness scans for skills, rules, memories and approval
config — so a promoted artefact is live the instant it exists, with no reload machinery of Taste's own.

**Why `applyPromotions` re-checks the class the promoter already checks.** It is an outer gate, and it
means a decision-class statement is never even *read into* a write path, let alone refused inside one.
Defence in depth costs one comparison.

**Why staleness never disarms anything.** An armed promotion whose confidence decayed below `0.25`, or
whose backing candidate aged out of the accumulator entirely, is surfaced in `/taste status` with the
exact command to reverse it. Retracting an artefact a human has been relying on is a decision only that
human may take.

---

## Config resolution and cache invalidation

```mermaid
flowchart TB
  CALL["resolveTasteConfig cwd<br/>called on EVERY handler invocation"] --> KEY["statKey: stat all three layer files"]

  KEY --> TUP["Per layer, join mtimeMs : size : inode<br/>Absent or unstatable file contributes a dash.<br/>Layer order is significant."]

  TUP --> HIT{"tuple equals the cached tuple for this cwd?"}
  HIT -->|"yes"| RET["return cached TasteConfig<br/>zero file reads"]
  HIT -->|"no"| READ["read all three layers"]

  READ --> MERGE["merge lowest to highest:<br/>TASTE_DEFAULTS, then user, then project, then local.<br/>Only well-typed known fields survive readLayer;<br/>an unreadable or malformed layer contributes nothing."]
  MERGE --> STORE["cache under cwd, return"]
```

**Why the identity is a triple and not just mtime.** Filesystem mtime granularity can be one second. A
settings write landing in the same second as a previous one would leave the tuple unchanged and strand
the mid-session kill switch — the single worst failure this module could have. `size` catches a
same-second content change; `inode` catches an atomic temp-file replace that reused the timestamp.

**Why a malformed layer contributes nothing rather than throwing.** This is the seam the entire learner
gates on. A JSON syntax error in a settings file must degrade Taste to its defaults, which are off, not
break the session that read it.

**Why the project toggle writes to the *local* layer.** `/taste enable` without `--user` writes
`<cwd>/.omp/settings.local.json`, the highest-precedence layer. A toggle that a committed team file
could silently outrank would not be a toggle. `/taste enable --user` writes the user layer, which
applies to every checkout that has no local override of its own.

---

## The git auto-commit safety boundary

A learned team convention only pays off if it reaches the team, so a **project-scope** artefact whose
target has a file in the repo is committed into that repo. This is the only place Taste mutates state a
human shares, so the boundary is drawn tightly.

```mermaid
flowchart TB
  ENTRY["project scope AND COMMITTED_TARGETS target<br/>skill yes · rule yes · approval yes · memory NO"] --> PRE

  subgraph PRE["preflightAutoCommit — runs BEFORE a byte is written"]
    P1{"walk up for a .git directory"} -->|"none found"| NULLP["return null — nothing to publish into.<br/>Not a refusal: the artefact is still written."]
    P1 -->|"found"| P2{"is cwd/.omp inside the repo root?"}
    P2 -->|"no"| REF["THROW — the promotion quarantines<br/>and NOTHING is written to disk"]
    P2 -->|"yes"| P3{"rebase, merge, cherry-pick,<br/>revert or bisect in progress?"}
    P3 -->|"yes"| REF
    P3 -->|"no"| P4{"is HEAD detached?"}
    P4 -->|"yes"| REF
    P4 -->|"no"| P5{"is the .omp subtree gitignored?"}
    P5 -->|"yes"| REF
    P5 -->|"no"| P6{"does the .omp subtree carry<br/>working-tree modifications?"}
    P6 -->|"yes — someone else's edit"| REF
    P6 -->|"clean"| PLAN["CommitPlan: repoRoot + tasteRoot"]
  end

  PLAN --> WRITE["the writer runs — artefact lands on disk"]

  WRITE --> C1{"does the artefact path resolve<br/>INSIDE tasteRoot?"}
  C1 -->|"no"| REF2["THROW — pathspec escapes the taste subtree.<br/>Nothing is staged."]
  C1 -->|"yes"| C2["commitMessageFor: built from structural fields only —<br/>target, candidate id, scope. Never the learned prose.<br/>Then PROVEN attribution-free by regex, not assumed."]

  C2 --> C3{"runner.pathKind of the pathspec"}
  C3 -->|"directory"| REF3["THROW — git add on a directory<br/>stages EVERYTHING beneath it.<br/>Checked, never trusted."]
  C3 -->|"not a regular file"| REF3
  C3 -->|"regular file"| C4["git add -- PATH"]

  C4 --> C5["git commit --only -m MESSAGE -- PATH<br/>--only ignores the rest of the index, so whatever<br/>the human had staged is never swept in.<br/>-- ends the option list, so a leading-dash path is a path."]

  C5 --> DONE["published"]

  GUARD["assertNarrowArgv — enforced inside the git helper,<br/>so it covers the probes and the staging call too.<br/>REFUSES: push · -A · --all · -a · -f · --force · --amend<br/>and the ENTIRE --no-... family, so a future git option<br/>cannot slip past a stale list."]
  GUARD -.->|"every argv this module builds"| C4
  GUARD -.-> C5
  GUARD -.-> PRE
```

**Why the preflight runs before the write and not after.** `git commit --only` needs the subtree to be
clean of edits Taste did not make, and the only moment that is knowable is before Taste makes one. A
repository that cannot take a clean single-path commit therefore refuses the promotion with nothing on
disk, rather than leaving an artefact the team never receives.

**Why a directory pathspec is refused explicitly.** Every other check proves the path is *inside* the
taste subtree. None of them proves what *kind* of thing it is, and `git add` given a directory stages
every file beneath it — so a writer that returned a directory would publish the whole subtree while
every existing check passed. The kind is settled at the single point staging happens.

**Why the `--no-…` family is refused wholesale.** The ones that matter switch off a repository's own
hooks and signature requirements. A learned auto-commit that can skip the checks a human commit must
pass is not a narrow write. Refusing the family rather than enumerating members also means a future git
option cannot slip past a stale list.

**Why the commit message is built from structural fields.** The learned statement is derived from a
human's own correction text and could carry anything, including an attribution token. The message is
assembled from `target`, candidate id and scope only, and is then *proven* attribution-free by regex
rather than assumed to be.

**Why a memory promotion is never committed.** It has no file in the repo — it lands in the harness's
memory runtime or in the profile state root.

---

## Stage 7 — Undo

Removing the extension does not neutralise what it wrote. A promoted skill stays in the catalog, a
guard rule stays armed, an approval entry stays in effect. Undo therefore has to actually delete the
artefact, and it has to be safe against a ledger that could name any path at all.

```mermaid
flowchart TB
  F["forgetPromotion entry, ctx"] --> P0{"entry.path"}
  P0 -->|"empty"| R0["refused: the promotion wrote no artefact"]
  P0 -->|"memory:runtime"| R1["refused: a memory held by the harness runtime<br/>cannot be removed by taste"]
  P0 -->|"a real path"| SCOPE{"does it resolve inside<br/>scopeRoot for its OWN ledger row's scope,<br/>or inside the taste state dir?"}

  SCOPE -->|"no"| R2["refused, artefact UNTOUCHED:<br/>path escapes the scoped roots.<br/>Reported, never swallowed."]
  SCOPE -->|"yes"| PLAN["take the commit plan FIRST, while the subtree is still clean.<br/>A dirty subtree is someone else's edit: undo still runs<br/>and the removal is reported as unpublished."]

  PLAN --> RM{"entry.target"}
  RM -->|"approval"| RMA["lift out exactly the lines the promotion inserted,<br/>then prove the rest of the shared config survived"]
  RM -->|"skill"| RMS["unlink the file, then rmdir the taste- directory<br/>only if it is now empty"]
  RM -->|"rule · staged memory"| RMF["unlink the file"]

  RMA --> CM
  RMS --> CM
  RMF --> CM
  CM{"commit plan taken?"} -->|"yes"| PUB["commitRemoval — same narrow write as the promotion"]
  CM -->|"no"| TOMB
  PUB --> TOMB["append a TOMBSTONE row to promotion-ledger.jsonl.<br/>The ledger is append-only: a reversal is a NEW row naming<br/>the row it undoes, never an edit of history."]

  TOMB --> EFFECT["ledgerView replays rows in order and drops the armed entry.<br/>The candidate id joins tombstonedCandidates, and the<br/>AUTOMATIC PATH WILL NEVER RE-ARM IT."]
```

**Why the approval target is never deleted as a file.** Its artefact is a shared `config.yml` a human
also writes. The reversal lifts out exactly the lines the promotion inserted, mirroring how they were
added, and proves the result by read-back.

**Why every refusal is returned rather than thrown.** `/taste forget --all` must keep going and report
precisely which artefacts are still in effect and why. A throw in the middle would leave the human with
a half-finished reversal and no list.

**Why a removal that could not be published is still a removal.** The artefact is out of effect, which
is what undo promised. The unpublished state is reported, not hidden.

---

## The fail-open envelope

Every event handler goes through `safely(label, handler)` in `index.ts`, which enforces three
invariants uniformly:

1. **Fail-open** — a throw is recorded to the health record and swallowed. Never rethrown.
2. **Inert when disabled** — the enabled flag is re-read per call, so the kill switch is immediate.
3. **Main-session-only** — subagent traffic is suppressed before the handler body runs.

The health record is bounded: a rolling error count plus the 20 most recent short-circuits. Each entry
stores only a `timestamp`, Taste's own internal handler label, and the error's *constructor name* —
deliberately **not** the error message, because a message can carry a secret-bearing token such as a
fetch URL with credentials or a rejected shell command line.

`/taste status` prints that count. This matters more than it looks: a learner quietly doing nothing must
never be indistinguishable from a learner quietly failing, so the panel always names the reason for
silence — switched off here, a subagent session, nothing observed yet, or *n* handler errors.

The `/taste` command is the one exception to the envelope, because it is invoked by a human rather than
by the event bus. It carries its own equivalent: an unexpected fault is recorded to the same health
record and reported in the panel. It is also registered unconditionally, whatever the config says,
because a human must be able to read the panel — and to reverse what was already armed — in a scope
where learning is currently switched off.

---

## On-disk state

| Path | Written by | Contents |
|---|---|---|
| `~/.omp/agent/taste/state.json` | `rollup.ts` | The bucket accumulator, versioned, locked, atomically renamed |
| `~/.omp/agent/taste/candidates.json` | `inference.ts` | The current pass's candidates; rewritten wholesale each pass |
| `~/.omp/agent/taste/promotion-ledger.jsonl` | `promote.ts`, `forget.ts` | Append-only audit trail: promotions, quarantines, approver tokens, tombstones |
| `~/.omp/agent/taste/pending-memories/` | `writers.ts` | Memory candidates staged when the harness memory backend is off |
| `<cwd>/.omp/skills/taste-<candidate-id>/SKILL.md` | `writers.ts` | A managed skill, project scope |
| `<cwd>/.omp/rules/taste-<candidate-id>.md` | `writers.ts` | A TTSR guard rule, project scope |
| `<cwd>/.omp/config.yml` | `approval.ts` | One appended `bash.patterns` entry, project scope |
| `<cwd>/.omp/settings.local.json` | `command.ts` | The project opt-in written by `/taste enable` |
| `~/.omp/agent/settings.json` | `command.ts` | The user opt-in written by `/taste enable --user` |

User-scope artefacts use `~/.omp/agent/` in place of `<cwd>/.omp/` and are never committed anywhere.
Every path under the profile root honours `OMP_TASTE_HOME`, which is how the test suite stays hermetic
and how a non-standard install can relocate state.
