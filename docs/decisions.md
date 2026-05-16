# Architecture Decision Records (ADR)

> **Rebrand ADR cluster.** The post-Epic-A/C/D/G/F reality is fixed by
> four load-bearing ADRs that subsequent decisions cite:
>
> - [`20260512-coupling-stance`](#adr-20260512-coupling-stance-two-surface-coupling-stance) — Claude Code-first, runtime-pluggable dispatcher (Epic G).
> - [`20260512-destructive-replan-retired`](#adr-20260512-destructive-replan-retired-epic-1182--retire-delete-epicjs-re-plan--edit-spec--reconcile) — declarative `epic.yaml` + reconciler (Epic D).
> - [`20260512-loop-adoption`](#adr-20260512-loop-adoption-adopt-built-in-loop-no-homegrown-surface-to-reconcile) — adopt built-in `/loop`; no homegrown surface to reconcile (Epic G).
> - The absolute quality floors and floor-vs-ratchet policy live in
>   [`quality-gates.md`](quality-gates.md) (Epic F Story #1602) — they
>   are tooling commitments rather than architectural ADRs.
>
> Older ADRs remain authoritative on the architectural question they
> answered at the time; cross-cuts that the Mandrel rebrand supersedes
> are flagged in the entries themselves.

## ADR 20260514-drop-churn-idle: Drop `churn` + `idle` from active perf-signal taxonomy

**Status:** Accepted
**Date:** 2026-05-14
**Epic:** [#1721](https://github.com/dsj1984/mandrel/issues/1721) —
performance-signal detectors
**Supersedes (in part):**
[ADR 20260507-1030a — Performance-signal telemetry](#adr-20260507-1030a-performance-signal-telemetry--events-local-summaries-on-tickets)
(updates the active-detector subset; the events-local / summaries-on-
tickets architecture is unchanged)

### Context

ADR 20260507-1030a pinned a seven-kind perf-signal taxonomy
(`friction`, `hotspot`, `rework`, `churn`, `idle`, `retry`, `trace`)
and reserved a slot in `SIGNALS_DEFAULTS` for each of the five
detectors. When Epic #1721 sat down to actually ship the missing three
(`hotspot`, `rework`, `retry`), the design review for `churn` and
`idle` exposed two problems:

- **`churn` semantically duplicates `rework` + `retry`.** The original
  intent was "the same surface keeps getting touched" — but rework
  already counts file edits past a per-file threshold, and retry
  counts repeated failed Bash invocations. Whatever a hypothetical
  churn detector would surface is either a strict subset of one of
  those two, or a noisier rollup that would mostly fire as a duplicate
  of an event that already landed.
- **`idle` (gap between tool calls) is too noisy to act on.** The
  signal as specified — fire when the gap exceeds
  `idle.gapSeconds` — has no meaningful denominator. Plan-mode
  pauses, model thinking time, deliberate human-in-the-loop pauses,
  and the seconds-long startup of a `gh` spawn all look identical to
  the detector. Without a way to distinguish "agent stalled" from
  "agent waiting on an external process or operator", the signal
  generates more friction than it surfaces.

### Decision

1. **Drop `churn` and `idle` from the active detector set.** Neither
   ships a detector module; neither carries a config key on
   `delivery.signals`. The wired detector set is exactly
   `{ rework, retry, hotspot }`.
2. **Keep `CHURN` and `IDLE` in the
   [`EVENT_KINDS`](../.agents/scripts/lib/signals/schema.js)
   enumeration.** The schema entries remain reserved for future use so
   a re-introduction does not need a schema bump or a coordinated
   producer/consumer migration. The aggregator's `signalCounts`
   surface continues to carry both keys at zero so a downstream
   consumer that referenced them does not break.
3. **Drop the unused config keys.** `delivery.signals.churn` and
   `delivery.signals.idle` are removed from `SIGNALS_DEFAULTS` and the
   `agentrc.schema.json` validation block. Operators who carried them
   in `.agentrc.json` from a pre-Epic-#1721 template see them ignored,
   not rejected — the schema is permissive on unknown nested keys
   under `delivery.signals` to keep the migration silent.
4. **Update `docs/architecture.md`** to name the three shipped
   detectors explicitly (no "future" qualifier) and to note that the
   schema retains the two reserved kinds.

### Consequences

- **Smaller shipping surface, same architecture.** The events-local /
  summaries-on-tickets contract from ADR 20260507-1030a is unchanged;
  only the active-detector subset narrows.
- **Detector set is now provable end-to-end.** Each shipped detector
  has a pure module under `lib/signals/detectors/`, a wiring layer in
  the orchestrator (`post-merge-pipeline.js` for rework + retry,
  `epic-runner/progress-reporter.js` for hotspot), and a render-surface
  test in `tests/lib/observability/render/`.
- **Operators with leftover config keys are not punished.** Carrying
  `delivery.signals.churn` or `.idle` in a project's `.agentrc.json`
  is a no-op rather than an error. The next operator-friendly
  template refresh removes the stale keys without an audible failure.
- **Reintroducing churn or idle later is cheap.** The schema entries
  remain; only a detector module + a wiring layer + a render test
  would be required, with no coordination across the producer ↔
  consumer boundary.

---

## ADR 20260512-destructive-replan-retired: Epic #1182 — retire `delete-epic.js`; re-plan = edit-spec + reconcile

**Status:** Accepted
**Date:** 2026-05-12
**Epic:** [#1182](https://github.com/dsj1984/mandrel/issues/1182) —
v6 Epic D, "Declarative `epic.yaml` + reconciler"
**PRD:** [#1482](https://github.com/dsj1984/mandrel/issues/1482)
**Tech Spec:** [#1483](https://github.com/dsj1984/mandrel/issues/1483)
**Closing Story:** [#1502](https://github.com/dsj1984/mandrel/issues/1502)
— "Remove `delete-epic.js` + `delete-epic-tickets` workflow"

### Context

Through v5.x the only re-plan path for an Epic was destructive: an operator
ran `/delete-epic-tickets <epicId>` (the `delete-epic.js` engine,
~208 LOC of GraphQL `deleteIssue` mutations), then `/delete-epic-branches`
to scrub local + worktree state, then re-ran `/epic-plan`. Every re-plan
therefore (a) round-tripped through GitHub-issue deletion, (b) depended on
the local cleanup script's regex for branch enumeration, and (c) had no
diffable description of the structural shape it was reverting from. Two
auto-memory entries surfaced this friction repeatedly:

- **`post-merge-close ignores test sandbox tempRoot`** — `phase-timings.json`
  + reap-failure signals leaked to real repo `temp/epic-<eid>/` regardless
  of `cwd:` / `tempRoot`. The destructive-replan path made this worse by
  forcing operators back through close + cleanup whenever a Story needed
  re-shaping.
- **`delete-epic-branches misses flat story-NNNN naming`** — the cleanup
  script's regex expected `story/epic-<id>/<n>` and silently ignored flat
  `story-NNNN` naming. Operators discovered this only mid-replan, when
  stale local branches collided with the new plan.

Both entries were named in the PRD (#1482) as motivating Epic #1182.

### Decision

Epic #1182 ships:

- `.agents/epics/<id>.yaml` as the structural SSOT for an Epic (hierarchy,
  dependencies, wave grouping, gate/baseline refs, labels).
- `epic-reconcile.js` as the diff+apply reconciler. Default mode is
  `--dry-run`; mutation requires `--apply`; structural close ops require
  `--explicit-delete` AND the Story absent from the spec AND no
  `agent::done|review|executing` execution-state label.
- Distinct treatment of structural drift (Story added/removed in spec) vs
  execution drift (wave-runner-driven label flips). The reconciler never
  closes a merged Story and never re-opens an operator-removed one.

Story #1502 closes the loop by **removing the destructive surface
entirely**:

- `.agents/scripts/delete-epic.js` (208 LOC) — deleted.
- `.agents/workflows/delete-epic-tickets.md` — deleted (the corresponding
  `.claude/commands/` entry is regenerated by `sync:commands` and dropped).
- All in-tree references that named `delete-epic.js` or
  `/delete-epic-tickets` (SDLC.md, `docs/workflows.md`, the orchestration
  README index, the provider GraphQL header comments, the maintainability
  baseline) — rewritten to point at `epic-reconcile.js --explicit-delete`
  or removed.
- `delete-epic-branches.js` is **retained** as a worktree + local-branch
  cleanup utility. It no longer fronts GH state. Its companion workflow
  (`/delete-epic-branches`) remains the right tool for "scrap and reset"
  branch hygiene. Flat `story-NNNN` branch regex coverage is tracked by
  the `delete-epic-branches-naming` self-healing check and was out of
  scope for this Epic.

### Consequences

- Re-plan is **edit-spec + reconcile**. The destructive replay loop that
  drove the cited incidents no longer exists in the SDL.
- Operators who land on the old `/delete-epic-tickets` command via muscle
  memory hit a missing-command error; the SDLC.md command table and
  `docs/workflows.md` table both surface `epic-reconcile.js --explicit-delete`
  as the supersedent.
- The test-sandbox `tempRoot` amplifier is removed: operators are no
  longer forced into the close + cleanup hot path to re-shape a Story.
  The underlying `tempRoot` bug is not itself fixed by this ADR — only
  its blast radius is bounded.
- Flat `story-NNNN` cleanup remains tracked by
  `delete-epic-branches-naming`; this ADR explicitly records that it was
  surfaced in the PRD but not in scope for resolution here.

---

## ADR 20260512-coupling-stance: Two-surface coupling stance

**Status:** Accepted
**Date:** 2026-05-12
**Supersedes:**

- Implicit assumption that the entire framework — dispatcher, workflow,
  hooks, skills, and slash commands — must remain runtime-neutral.

### Context

The framework spans two distinct surfaces with different portability
profiles:

1. The **dispatcher / `.agents/scripts/` library** is a runtime-neutral
   orchestration core. It runs as plain Node.js, holds the ticket /
   branch / worktree contracts, and is the integration boundary that
   any execution adapter implements against. Keeping this surface
   runtime-neutral preserves the option to add additional execution
   adapters later (Codex, Antigravity, subprocess, MCP) without
   rewriting the orchestration core.
2. The **workflow / `.claude/` / hook / skill surface** consists of the
   slash commands, agent definitions, hook scripts, and skill markdown
   files that operators interact with day to day. This surface is
   tightly coupled to Claude Code as the reference runtime — it relies
   on Claude Code's slash-command execution model, hook lifecycle,
   skill loading, and sub-agent dispatch primitives. Treating it as
   runtime-neutral has produced adapter-layer stubs for runtimes that
   were never implemented (`// antigravity:`, `// 'claude-code':`,
   `// codex:`, `// subprocess:`, `// mcp:` slots in
   `.agents/scripts/lib/adapter-factory.js`) and has discouraged
   adoption of Claude Code built-ins (`/goal`, `/simplify`,
   `/security-review`, `/loop`, `/fewer-permission-prompts`,
   `/insights`) that would shrink the framework's homegrown surface
   area.

The framework is — in practice and by design — a **Claude Code-first
opinionated workflow framework with a runtime-pluggable dispatcher**.
This ADR makes that coupling stance explicit so subsequent phases of
the Mandrel rebrand and downstream Epics reference a single source of truth
instead of re-litigating the question per change.

### Decision

The framework adopts a **two-surface coupling stance**:

- The **dispatcher surface** (`.agents/scripts/`) stays runtime-neutral.
  Adapters are added on demand, not pre-declared. The reference adapter
  is `manual`. Additional adapters are accepted on their own merits as
  separate epics.
- The **workflow surface** (`.claude/` slash commands, agent
  definitions, hooks, skills, and the workflow documents under
  `.agents/workflows/`) is **Claude Code-first**. Portability of this
  surface to other runtimes is an explicit non-goal. Claude Code
  built-ins are preferred over homegrown re-implementations when their
  contracts match or can be wrapped to match the framework's artifact
  expectations.

Where overlap exists between a Claude Code built-in and a homegrown
wrapper, the default reconciliation is the **hybrid pattern**: the
homegrown wrapper remains the public entry point and owns the
artifact contract (structured `audit-*-results.md` files, audit
orchestrator integration, exit codes, evidence-gate hooks); the
built-in supplies the analysis or fix loop as a delegated sub-step.
The wrapper validates the built-in's output against the original
findings before closing.

The ADR is written with name-neutral phrasing — "the framework" rather
than a brand name — so the Mandrel rebrand epic could supply the brand
name without rewriting this ADR text.

### Consequences

- **Adapter-layer stubs come down.** The pre-declared adapter slots in
  `.agents/scripts/lib/adapter-factory.js` for unimplemented runtimes
  are removed. The `IExecutionAdapter` header documentation is
  rewritten to state the two-surface stance and link back to this ADR.
  Adding a future adapter is in scope for that adapter's own epic, not
  a precondition the dispatcher must continually carry.
- **Built-in adoption is in-bounds.** Adopting Claude Code built-ins
  (`/simplify`, `/security-review`, `/loop`, `/fewer-permission-prompts`,
  `/insights`, etc.) inside the workflow surface does not violate the
  framework's coupling contract. Such adoption is encouraged where the
  built-in's contract matches the framework's artifact expectations or
  can be wrapped via the hybrid pattern. As of this writing only
  `/fewer-permission-prompts` is wired in (referenced by `/agents-update`
  Step 3.6); the others remain candidates. Note that `/goal` is a
  *prompt-side* directive the operator types — it is not reachable from
  the agent's tool surface and cannot be invoked from a workflow body.
- **The overlap matrix is mandatory.** Each overlapping responsibility
  between a Claude Code built-in and a homegrown surface element must
  be recorded in `docs/decisions.md` with: wrapper name, built-in
  name, exact sub-step delegation point, post-return validation, and
  rationale. Unrecorded overlaps are treated as drift and addressed in
  the next maintenance pass. The catalog of Claude Code commands
  itself is a maintained artifact (`docs/claude-code-catalog.md`) with
  a refresh cadence pinned to Claude Code minor version bumps.
- **Portability of the workflow surface is a non-goal.** Proposals to
  abstract the slash-command, hook, or skill surface away from Claude
  Code primitives are rejected by default. If a future runtime
  warrants a parallel workflow surface, that is a separate epic with
  its own ADR superseding this one.

---

## ADR 20260510-sdl-collapse: 5.40.0 — collapse to /epic-plan + /epic-deliver, fold retro into deliver tail

**Status:** Accepted
**Date:** 2026-05-10
**Supersedes:**

- Prior decisions documenting `epic::auto-close` as the runtime
  authorization for autonomous merge-to-main (now obsolete: the SDL
  no longer merges to `main` — the operator does, via the GitHub UI).
- Prior decisions documenting `agentSettings.epicClose.runRetro`
  toggle (now obsolete: the retro is always-on inside the new
  `/epic-deliver` tail; the configuration knob has been deleted from
  the schema).
- Two-skill execution surface decisions that named `/epic-execute` +
  `/epic-close` as the canonical critical path. The 5.40 critical
  path is `/epic-plan` + `/epic-deliver`.

### Context

By v5.39 the SDL critical path was three slash commands —
`/epic-plan`, `/epic-execute`, `/epic-close` — with the close phase
silently merging to `main` from inside an LLM session.  Three failure
modes accumulated against that shape:

1. **Implicit merge-to-main from an LLM session.**  The close phase
   ran `git merge` against `main` from inside the operator's IDE.  No
   GitHub PR existed, no required-checks dashboard was consulted, no
   reviewer trail was recorded.  The branch-protection story was
   ad-hoc and easy to skip.
2. **Retro firing after merge-to-main.**  Because the retro was the
   last step of close, it ran with the operator's local env access
   (env vars, MCP servers, credentials) but only after the
   irrevocable merge.  Any retro-detected regression had no clean
   rollback path.
3. **Two slash commands for one continuous flow.**  Operators
   routinely typed `/epic-close` immediately after `/epic-execute`
   returned.  The split offered no real choice — a human gate
   between "execute" and "close" was nominal at best.  Meanwhile
   `epic::auto-close` and `BookendChainer` existed solely to skip
   that nominal gate, adding mid-run authorization complexity that
   nothing benefited from.

### Decision

Collapse the v5.39 critical path to two slash commands:

- **`/epic-plan`** stays the planning entry point and gains an
  optional **ideation mode** (`/epic-plan` with no args, or
  `/epic-plan --idea "<seed>"`) that sharpens a raw idea into an
  Epic body, runs cross-Epic duplicate search via the new
  `lib/duplicate-search.js`, opens the GitHub Issue with only
  `type::epic`, then proceeds into the existing PRD + Tech Spec +
  decomposition flow.  The existing-Epic mode (`/epic-plan <id>`)
  is preserved verbatim.
- **`/epic-deliver`** replaces the v5.39 `/epic-execute` +
  `/epic-close` pair.  Six phases run end-to-end: prepare → wave
  loop → close-validation → code-review → retro → finalize.  The
  finalize phase opens a pull request from `epic/<id>` to `main`
  and **stops**; the operator merges the PR through the GitHub UI.
  There is no in-script merge to `main`.

The retro fires inside Phase 5, **before** the PR is opened, so it
keeps full env access in the operator's local session and any
retro-detected concern can be fixed on the Epic branch before the
human merge gate is reached.

The runtime engine renames in lockstep: `epic-runner.js` (top-level
CLI) → `epic-deliver-runner.js`; `epic-execute-prepare.js` →
`epic-deliver-prepare.js`; `epic-finalize.js` →
`epic-deliver-finalize.js`.  `epic-close.js` is deleted entirely;
the close-tail logic is folded into the deliver runner alongside two
new in-process modules (`lib/orchestration/code-review.js` extracted
from the helper, and `lib/orchestration/retro-runner.js` extracted
from the now-deleted retro helper).

The supporting deletions land atomically:

- `BookendChainer` and the `epic::auto-close` snapshot label.
- The `agent::review` epic-level label (the PR's existence is the
  equivalent signal at the Epic level).
- `risk::medium`, `execution::sequential`, and `execution::concurrent`
  labels.
- `agentSettings.epicClose` config block (including `runRetro`).
- `orchestration.hitl` empty placeholder block.
- `agentSettings.riskGates` config block (heuristics moved to
  `agentSettings.planning.riskHeuristics`).
- `orchestration.runners.epicRunner` → renamed to
  `orchestration.runners.deliverRunner`.
- `orchestration.runners.closeRetry` → renamed to
  `orchestration.runners.storyMergeRetry`.
- The resolver wrapper key `settings` → renamed to `agentSettings`
  (matches the `.agentrc.json` literal top-level key, fixing the
  silent override-drop bug where every accessor read
  `cfg?.agentSettings?.X ?? cfg?.X` against a wrapper that never
  carried `agentSettings`).

`agentSettings.quality.prGate` is promoted from schema-only to
default config and gains an `enforceBranchProtection` boolean
(default `true`).  `/agents-bootstrap-github` gains an
`ensureMainBranchProtection({ checks })` step that creates or merges
branch protection on `main` with the configured `prGate.checks` as
required status checks.  Branch protection is now load-bearing
because the operator's PR merge is the sole promotion gate.

`agentSettings.limits.maxTickets` default bumps 40 → 60.

### Consequences

- **One human gate at the end of the SDL.**  The PR merge is the
  explicit, auditable promotion to `main` — required-checks history,
  reviewer trail, and the GitHub branch-protection enforcement all
  apply.  The framework no longer authorizes its own merge.
- **Retro is always-on.**  The `epicClose.runRetro` toggle is gone.
  Operators who genuinely need to skip a retro on a one-off pass an
  explicit `--skip-retro` flag to `/epic-deliver`.  This trades a
  configuration knob for a hot-path CLI flag, which is the right
  trade for a rarely-skipped step.
- **No mid-run authorization.**  `epic::auto-close`, `BookendChainer`,
  and the snapshot-label semantics are gone.  Every `/epic-deliver`
  run completes with the same exit condition: a PR opens and the
  operator merges.
- **Branch protection is load-bearing.**  Consumers that previously
  relied on the in-script merge to gate red trees from `main` must
  ensure `enforceBranchProtection: true` and re-run
  `/agents-bootstrap-github` so the required-checks set is wired up.
  The default flips this on; the migration path is documented in
  the 5.40.0 CHANGELOG entry.
- **Resolver-key alignment fixes the silent override-drop bug.**
  Any consumer that did `const { settings } = resolveConfig()` must
  rename the destructure to `agentSettings`.  This is one mechanical
  change per call site; the framework's ~50 call sites are updated
  in the same PR via Story #1155.
- **Targeted retired-surface tests guard future regressions.**
  Schema, workflow, and live-import tests reject retired config keys,
  command names, and module imports at the boundary that still matters.
  Historical narrative remains in docs and archives without forcing a
  repo-wide forbidden-token sweep into every CI run.
- **Operator workflow simplification.**  Two commands replace three
  on the SDL critical path.  Ideation entry replaces an opaque manual
  Epic-body-authoring step.  The HITL touchpoints reduce from
  "blocker resolution + close hand-off" to "blocker resolution + PR
  merge".

### Migration

See the 5.40.0 entry in [`CHANGELOG.md`](CHANGELOG.md) for the
full operator migration script (config renames, command-shape
updates, retired-surface test wiring).  The CHANGELOG carries
side-by-side `.agentrc.json` before/after blocks for every removed,
renamed, moved, promoted, and bumped key.

---

## ADR 20260508-flatten: Retire `/wave-execute`; `/epic-execute` owns the wave loop directly

**Status:** Accepted
**Date:** 2026-05-08
**Supersedes:** ADR 20260507-1114a (Wave-runner is a custom sub-agent type)

### Context

The three-level topology — `/epic-execute` → `wave-runner` →
`/wave-execute` → `/story-execute` — depended on a custom `wave-runner`
sub-agent type whose frontmatter granted the `Agent` tool to the
wave-level child. That contract was documented in framework code, but
**the agent file was never scaffolded into consumer projects** by
`agents-bootstrap-project` or `agents-update`. Downstream consumers
running `/epic-execute` saw the host harness reject `subagent_type:
wave-runner` with "Agent type not found" before any Story sub-agent
could be dispatched, halting at wave 0. The host-driven flat fan-out
(documented as emergency-only in ADR 20260507-1114a) had to be reached
for under any circumstance — meaning the supposedly "supported"
architecture was unreachable from a clean consumer install.

Even if the agent file were scaffolded, the topology has a second
load-bearing harness assumption: that custom sub-agent types continue to
be granted nested `Agent`. That assumption has wobbled across releases;
the `subagent-agent-tool-required` self-healing check now guards the
current flat fan-out contract. Two-level dispatch with the host LLM as
the wave dispatcher needs neither assumption.

### Decision

Retire `/wave-execute` entirely. `/epic-execute` (the host LLM) owns the
wave loop and fans Stories out directly, one assistant turn per wave,
with `subagent_type: general-purpose`. The custom `wave-runner` agent
type is removed.

Concrete changes:

- Delete `.agents/workflows/wave-execute.md`,
  `.claude/commands/wave-execute.md`, and `.claude/agents/wave-runner.md`.
- Delete `.agents/scripts/wave-prepare.js`,
  `.agents/scripts/wave-record.js`, and `.agents/scripts/epic-rollup.js`.
- Merge their behavior into `.agents/scripts/epic-execute-record-wave.js`,
  which now: parses / reconciles / verifies the per-Story returns,
  appends the wave outcome to `state.waves[]`, and re-renders the unified
  `epic-run-progress` rollup from the checkpoint.
- Delete the `wave-run-progress` structured-comment type and its writer
  (`wave-run-progress-writer.js`). `epic-run-progress` becomes the
  single operator-facing summary, grouped by wave.
- `epic-execute.md` Step 2 absorbs the per-wave fan-out (one assistant
  turn per wave; pump-and-refill at `concurrencyCap`).

### Consequences

- Works on every Claude Code release — no dependency on custom-sub-agent
  `Agent` grants and no dependency on framework-shipped agent files.
- One execution model. The host-driven flat fan-out documented as
  emergency-only in #1072 / #1114 is now *the* architecture.
- Per-wave operator re-entry (`/wave-execute <epicId> <waveN>`) is no
  longer a slash command. Manual re-entry is `/epic-execute <id>`
  (resumes from checkpoint, re-fires the next undispatched wave) or
  `/story-execute <id>` per Story. Strictly fewer escape hatches.
- Existing Epics with `wave-run-progress` comments on their tickets are
  unaffected — nothing reads those comments anymore; they remain as
  cosmetic leftovers and do not block resume.
- Bumps the framework to a new minor version (5.39.0). No data
  migration is required.

---

## ADR 20260507-1114a: Wave-runner is a custom sub-agent type, not `general-purpose` (superseded)

**Status:** Superseded by ADR 20260508-flatten
**Date:** 2026-05-07
**Epic:** #1114
**Story:** #1122

### Context

The orchestration topology described in tech spec #902 assumed three
levels of in-session sub-agent fan-out: `/epic-execute` dispatches one
`/wave-execute` per wave through the `Agent` tool, and each
`/wave-execute` dispatches one `/story-execute` per Story in its plan.
The design assumption was that sub-agents inherit their parent's tool
permissions, so a `/wave-execute` invoked as a `general-purpose`
sub-agent would itself have the `Agent` tool available for the per-Story
fan-out.

That assumption did not survive contact with the harness. During Epic
#1072's first wave, the wave-level fan-out failed entirely: the
`general-purpose` wave sub-agent reported that the `Agent` tool was not
in its grant list, and the Story dispatch had to be performed by an
ad-hoc host-driven flat fan-out instead — the host LLM emitting one
`Agent` tool call per Story directly, bypassing `/wave-execute` entirely.
The flat workaround loses the wave-level rollup, the parse-failure
reconciler, and the per-wave checkpoint, so it was tagged as
emergency-only rather than the supported architecture. Epic #1114
re-opened the question with a Q6 probe.

### Decision

Define a custom sub-agent type at `.claude/agents/wave-runner.md` whose
frontmatter declares `tools: Agent, Read, Bash, Edit, Write, Glob, Grep,
Skill`. The `tools: Agent` line is what the harness reads to decide
whether a sub-agent of that type carries the `Agent` tool — naming the
tool explicitly in a per-agent config file is the supported way to grant
nested-`Agent` capability to a sub-agent in this Claude Code release.
`/epic-execute` Step 2 and `/wave-execute` Step 2 both dispatch via
`subagent_type: wave-runner` rather than `general-purpose`.

The host-driven flat fan-out remains documented as an emergency-only
fallback, not the supported architecture. The probe artefact
(`tests/wave-runner-probe.test.js`) checks that the agent file's
frontmatter declares the required tools and explicitly skips the
nested-`Agent` dispatch step with a clear reason when the harness is
unreachable from `node --test` — it never silently passes.

### Consequences

- The three-level fan-out topology described in tech spec #902 holds: a
  `/wave-execute` invoked as a `wave-runner` sub-agent has the `Agent`
  tool and can dispatch its per-Story children.
- `subagent_type: general-purpose` for wave-level dispatch is forbidden.
  The harness-constraint section in `wave-execute.md` and the
  cross-reference from `epic-execute.md` Step 2 spell this out so the
  next operator does not rediscover the constraint by hitting the same
  failure mode.
- A future Claude Code release that disallows nested `Agent` even for
  custom agent types would re-block this architecture. The probe test
  is the canonical regression catcher for the artefact shape; the
  live-dispatch verification is harness-coupled and runs implicitly the
  next time `/wave-execute` is exercised end-to-end.
- Story sub-agents (children of the wave-runner) are themselves
  dispatched as `wave-runner` per Task #1137. They nominally do not
  need the `Agent` tool — they iterate Tasks sequentially via
  `helpers/task-execute.md` — but the extra grant is harmless and keeps
  the topology uniform.

---

## ADR 20260507-1072a: Bounded fanout, tightened module boundaries, dead-module sweep

**Status:** Accepted
**Date:** 2026-05-07
**Epic:** #1072

### Context

Audit work on the orchestration scripts surfaced three drift categories
that had accumulated quietly across Epics: (1) several hot loops over
GitHub mutations and the filesystem still used unbounded `Promise.all`,
risking rate-limit storms on large Epics and resource exhaustion on
recursive fs scans; (2) module boundaries had eroded — `lib/orchestration/index.js`
re-exported scripts and providers upward, the audit-suite had no clear
SDK home, and the GitHub HTTP client lived as a sibling of the structured
GitHub provider rather than under `providers/github/`; (3) two `lib/`
modules (`fs-utils.js`, `runtime-context.js`) had no remaining importers
but were still indexed by docs and baselines. The drift was not a single
incident — each item was a known small thing that had been deferred.

### Decision

Treat the cleanup as a single coherent Epic rather than fan-out across
maintenance work:

1. **Bounded concurrency is the default.** Every `Promise.all` over
   GitHub or fs work flows through `concurrentMap` with a story-specific
   cap (3 for mutation paths, 8 for sibling-read fan-outs, 64 for fs
   scans), with tests that assert `maxInFlight ≤ cap` rather than just
   correctness.
2. **Module boundaries are one-way.** `lib/orchestration/index.js` no
   longer re-exports providers or scripts; the audit-suite has its own
   `lib/audit-suite/` SDK exporting `runAuditSuite` / `selectAudits`;
   the HTTP client moved under `providers/github/http-client.js`. The
   barrel imports from these locations, never the other way.
3. **Dead code is deleted, not archived.** `fs-utils.js` and
   `runtime-context.js` are gone; their docs references migrate to the
   surviving three-context pattern in `lib/orchestration/context.js`.
   A canonical `lib/branch-name-guard.js` collapses two duplicate
   safety guards.

### Consequences

- New consumers see uniform `concurrentMap` usage at fan-out sites;
  raw `Promise.all` over network/fs work is now a code-review smell.
- The orchestration barrel becomes a true facade — touching it does
  not pull in the scripts CLI surface or providers, which keeps test
  doubles small.
- Operators gain `.agents/scripts/README.md` as the entry-point index
  for the script surface, replacing the prior need to grep package.json
  scripts and CLI banners.

## ADR 20260507-1030a: Performance-signal telemetry — events local, summaries on tickets

**Status:** Accepted
**Date:** 2026-05-07
**Epic:** #1030

### Context

Before Epic #1030 the framework had a single observability surface:
`diagnose-friction.js` posted one structured comment per friction event
directly onto the originating Task ticket. As the orchestrator grew —
hotspots, rework, churn, idle, retry, plus raw tool-call traces — that
fan-out hit two ceilings simultaneously. Tickets accumulated dozens of
machine-noise comments per Story, drowning the human review surface.
And every event paid a synchronous round-trip through the GitHub API,
forcing detectors to either rate-limit (losing signal) or batch in
process (losing tail records when sub-agents exit abruptly).

A separate gap sat next to that: detector thresholds were hard-coded in
each module. Operators tuning hotspot sensitivity for their own repo
had no override surface, and the framework had no canonical place to
declare default values that the `.agentrc.json` template could mirror.

### Decision

1. **Split events from summaries.** Detectors and the runtime trace hook
   write append-only NDJSON to local disk under
   `temp/epic-<eid>/story-<sid>/signals.ndjson` (and a sibling
   `traces.ndjson` for `kind: trace`). GitHub tickets receive **summary
   payloads only** — one
   [`structured:story-perf-summary`](../.agents/schemas/story-perf-summary.schema.json)
   comment per Story at close, one
   [`structured:epic-perf-report`](../.agents/schemas/epic-perf-report.schema.json)
   per Epic alongside the retro. The seven-kind taxonomy
   (`friction`, `hotspot`, `rework`, `churn`, `idle`, `retry`, `trace`)
   is the closed enum on
   [`signal-event.schema.json`](../.agents/schemas/signal-event.schema.json).
2. **Per-Epic temp tree, reaped with the worktree.** The on-disk layout
   `temp/epic-<eid>/story-<sid>/` lets the analyzer scan a single
   Story's stream cheaply and lets `WorktreeManager.reap` clean every
   in-flight artifact in one sweep when the Epic closes. Lazy directory
   creation on first write keeps zero-signal Stories from touching the
   disk at all.
3. **Best-effort, unbuffered writer.** `signals-writer.js` opens, writes
   one newline-terminated JSON line, and closes per call. fs / JSON
   failures are swallowed via `Logger.warn` so observability MUST NOT
   take down a wave. In-process buffering is forbidden by the Tech Spec
   because per-Story sub-agents may exit abruptly and a buffered tail
   would silently disappear on `process.exit`.
4. **Detector thresholds are operator-tunable.**
   `agentSettings.limits.signals` is the single declarative surface;
   `SIGNALS_DEFAULTS` in `.agents/scripts/lib/config/limits.js` is the
   canonical default block (`hotspot.p95Multiplier=1.25`,
   `rework.editsPerFile=5`, `churn.repeatCount=4`,
   `idle.gapSeconds=120`, `retry.repeatCount=3`). The resolver
   shallow-merges per-detector overrides so an operator can re-tune a
   single key without re-listing the others, and `getSignals(config)` is
   the runtime accessor the detector layer imports.

### Consequences

- **Bounded ticket surface.** A Story carries at most one perf summary
  comment regardless of how many signals fired; an Epic carries one
  perf report. Reviewers see one consolidated table per closure boundary
  instead of an event log.
- **Detectors can fire freely.** Local NDJSON writes are bounded by
  disk I/O, not GitHub rate limits, so detectors no longer self-throttle.
  Raw tool-call traces become economically viable as a data source.
- **Reap is observability cleanup too.** Closing an Epic and reaping its
  worktrees deletes the corresponding NDJSON streams. There is no
  separate retention policy and no orphan-data risk.
- **Schema rejections become loud at the ticket boundary.** The closed
  `signal-event.schema.json` enum and the `additionalProperties: false`
  guards on the summary schemas mean a producer drift fails AJV at
  close time, not at consumer parse time.
- **Operator overrides survive template re-bootstraps.**
  `.agents/full-agentrc.json` mirrors `SIGNALS_DEFAULTS` exactly
  (the `tests/config/limits-template-drift.test.js` guard fails on any
  divergence), so an operator who copied the template wholesale and one
  who merged it on top of an existing block resolve to the same
  thresholds.
- **Documentation lock-in.** The Friction Telemetry section of
  `docs/architecture.md` is rewritten to the events-local /
  summaries-on-tickets model; `docs/data-dictionary.md` carries
  field-level rows for `signals.ndjson`, `story-perf-summary`, and
  `epic-perf-report`; this ADR is the canonical why.

---

## ADR 20260505-990a: Audit remediation — `.agents` framework hardening + concept removal

**Status:** Accepted
**Date:** 2026-05-05
**Epic:** #990

### Context

A targeted audit of `.agents/` produced 24 anti-pattern findings spanning
instructions, schemas, orchestration scripts, and templates. After triage,
20 were accepted and 4 were rejected as misapplied. Layered on top, the
operator added four cross-cutting cleanups: remove unused `model_tier`,
reject auto-spec, slim the heavyweight `.agents/README.md`, and strip
residual legacy code paths.

The framework had three classes of drift: half-implemented features the
contract still round-tripped (`model_tier` emitted everywhere, routed
nowhere); loose schema contracts (`additionalProperties: false` largely
absent, free-text discriminators, one schema file containing instance
data); and reference rot in the README (~790 lines mixing activation,
configuration, and engineering runbook content, most duplicated in
canonical docs).

Two real workflow bugs surfaced mid-Epic while dogfooding `/epic-execute`
against the remediation itself: `withEpicMergeLock` failing on the
worktree gitlink (`mkdir <worktree>/.git` throws because `.git` is a
file), and JSON format drift propagating across waves because
`.lintstagedrc` only globbed `**/*.js` and `*.md`. Both were fixed
inline so the Epic could complete.

### Decision

1. **Eliminate `model_tier` end-to-end.** Delete `model-resolver.js`,
   strip the field from the dispatch-manifest schema, every producer,
   the formatter, and the validator's `complexity::high|fast`
   enforcement (its only purpose was tier derivation). The orchestrator
   does not select models; the executing agent or external router does.
2. **Reject auto-spec.** Audit findings 8 and 10 proposed an
   `epic::auto-spec` autonomous-planning branch. The plan-then-confirm
   STOP gate is preserved unchanged.
3. **Slim `.agents/README.md`** to ≤ 150 lines: activation + a single
   "where to look" pointer table. Detailed reference content moves to
   `docs/configuration.md`, new `docs/quality-gates.md`, and the
   root `.agents/README.md` sections for distributed-submodule
   conventions. (Windows git-perf guidance was historically a fourth
   target; superseded by `.agents/scripts/check-windows-git-perf.js` in
   5.36.3.)
4. **Tighten schemas:** `additionalProperties: false` on
   `audit-results`, `friction-event`, and `agentrc` root; `if/then`
   conditional requirements on `healthRefresh.cadence`; closed enum on
   `validation-evidence.gateName`; drop the empty-string member from
   `dispatch-manifest.mode`. Mirror everything to the runtime AJV
   schemas.
5. **Rename `audit-rules.schema.json` → `audit-rules.json`** (it is
   instance data, not a schema) and add a real
   `audit-rules.manifest.schema.json` validating it.
6. **Preserve failure signals** in `context-hydration-engine.js` (catch
   handler emits `[failed to load #id: msg]` markers instead of empty
   strings) and `providers/github/issues.js` (`getSubTickets` warns
   when partial-load count diverges).
7. **Strip residual legacy behavior** with proven zero callers:
   `dispatcher.js --epic` flag, the DEBUG-gated CLI exit code, the
   `task/<archivedEpic>/<taskN>` branch shape, residual `Logger.fatal`
   calls inside `lib/`. Annotate surviving callers in 6 files.
8. **Self-heal mid-Epic workflow bugs.** Fix `withEpicMergeLock` to
   resolve the parent gitdir via `git rev-parse --git-common-dir`
   (lock is shared across worktrees by design). Add a
   `runFormatAutofix` step at the start of `story-close.js` that
   creates a `style:` fixup commit when `biome format --write`
   rewrites files. Extend `.lintstagedrc` to format
   `**/*.{json,jsonc,json5}`.

### Consequences

- **Manifest contract change.** `dispatch-manifest.json` no longer
  includes `model_tier` on either shape. Every internal consumer (tests,
  formatters, runners) was updated; no external contract was breaking.
- **Schema rejections become loud.** Payloads with extra keys, free-text
  `gateName` values, or empty `mode` strings now fail validation. This
  is the goal — the previous silent acceptance hid drift.
- **Story-close is self-healing on Windows worktrees.** The lock no
  longer crashes on the gitlink, and format drift carried in from
  upstream waves is committed automatically as a `style:` fixup. The
  `/epic-execute` loop runs hands-off when no real failure occurs.
- **README halved.** The slim version (≤ 150 lines) is the entry point;
  detail lives at stable canonical URLs that downstream consumers can
  bookmark.
- **Audit-rules tooling can validate the manifest.** Future audit
  additions are type-checked against the new manifest schema.

### Out of scope (rejected audit findings)

- **No `epic::auto-spec`** branch (findings 8, 10).
- **No softening of the "output ENTIRE file" rule** (finding 4) — the
  rule guards `Write` safety, not token economy.
- **No conditional / scoped `docsContextFiles` reads** (finding 3) —
  the small mandatory set is the contract.
- **No `console.warn` in `env-loader.js` silent-fail path**
  (finding 14) — `.env` is genuinely optional.
- **No `minItems: 1` cardinality on `listOrExtenderOfStrings`**
  (finding 17) — empty list is a legitimate "explicitly nothing"
  override.

The rationale for each rejection is recorded in
`temp/implementation-plan.md` so the next reviewer of the audit sees
why each was set aside.

---

## ADR 20260501-900a: Epic-centric workflow rework — four-skill split, single-session fan-out, retire GitHub triggers

**Status:** Accepted
**Date:** 2026-05-01
**Epic:** #900
**Story:** #918

### Context

The execution surface had accreted in three layers that no longer
matched the ticket model:

1. A **single mega-skill** (`/sprint-execute`) that routed by `type::`
   label (Epic Mode vs. Story Mode) and fanned out subprocess Claude
   sessions for each Story.
2. A **GitHub-triggered remote orchestrator** (`epic-orchestrator.yml`,
   `remote-bootstrap.js`, `agent::dispatching` / `agent::planning` /
   `agent::decomposing` trigger labels) that existed only to invoke the
   slash commands headlessly on a GitHub-hosted runner.
3. A **claim-based pool mode** (`pool-claim.js`, `lib/pool-mode.js`,
   `in-progress-by:<sessionId>` claim labels) that arbitrated no-id
   `/sprint-execute` launches across N web tabs.

In the operator's day-to-day flow — single Claude Code session, no
remote dispatch — every layer above was dead weight: extra labels, a
parallel YAML, a bootstrap script, subprocess machinery, a claim race,
and a routing CLI (`sprint-execute-router.js`) whose only job was to
reverse the single-CLI design. The "sprint" nomenclature itself
mismatched the Epic-centric ticket model on which everything sits.

Six framing questions drove the scope.

- **Q1.** Which trigger labels go? Just the three trigger-only labels, or
  the whole `agent::review-spec`/`agent::ready` set too?
- **Q2.** How does the wave loop fan out Stories — keep `claude -p`
  subprocesses, or use the Agent tool inside the single session?
- **Q3.** Should `task-execute` be its own slash command, or a path-
  included helper read inline by `/story-execute`?
- **Q4.** What is renamed in the sprint→epic sweep? Slash commands and
  helper `.md` files only, or top-level scripts and config keys too?
  Structured-comment markers? `lib/orchestration/*` paths?
- **Q5.** How does multi-level progress collation work — one shared
  `epic-run-progress` comment written by all levels, or per-level
  comments that parents collate?
- **Q6.** With remote triggers gone, what survives of the planner CLI
  surface? `--phase spec|decompose`? `--auto-dispatch`?
  `epic-plan-state` checkpoint?

### Decision

Adopt the answers below for Epic #900; defer alternatives to a future
ADR if the trade-off proves wrong.

- **Q1 — minimal label cleanup.** Delete only the three trigger-only
  labels: `agent::dispatching`, `agent::planning`, `agent::decomposing`.
  Keep `agent::review-spec`, `agent::ready`, `agent::executing`,
  `agent::review`, `agent::blocked`, `agent::done` — they still encode
  lifecycle state independent of triggers.
- **Q2 — single-session Agent-tool fan-out.** `/wave-execute` launches
  Story sub-agents through the Agent tool in one assistant turn (capped
  at `concurrencyCap`). No `claude -p` subprocess spawn, no headless
  `--dangerously-skip-permissions` contract, no idle-watchdog, no
  progress-log tailing via `Monitor`. Worktree filesystem isolation is
  preserved; only the process boundary disappears.
- **Q3 — `task-execute.md` is a helper, not a slash command.** The
  per-Task discipline (`## Instructions` reading, scope guard,
  `assert-branch`, conventional commit) is a procedural module read
  inline by `/story-execute` — not registered in `.claude/commands/`.
  Tasks are not directly executable; they are implemented by the
  parent Story's loop.
- **Q4 — rename the operator-visible surface; keep internal markers
  and lib paths.**
  - Renamed: slash commands (`/epic-plan`, `/epic-close`), the new
    skill files (`epic-execute.md`, `wave-execute.md`,
    `story-execute.md`), top-level scripts (`epic-plan*.js`,
    `story-*.js`, `epic-*.js`), helper `.md` files under
    `workflows/helpers/`, and the config key
    `agentSettings.sprintClose.runRetro` →
    `agentSettings.epicClose.runRetro` (with a one-release shim that
    logs a deprecation warning when the legacy key is read).
  - Kept: structured-comment markers (`epic-run-state`,
    `epic-plan-state`, `dispatch-manifest`, `story-init`,
    `code-review`, `retro-complete` — already epic-shaped where it
    matters; renaming would orphan history on existing Epics) and
    `lib/orchestration/*` module paths (internal facade decomposition;
    the public-facing renames already deliver the nomenclature win
    without churning every import path).
- **Q5 — per-level progress, parents collate.** `/story-execute` writes
  a `story-run-progress` structured comment per Task transition.
  `/wave-execute` reads child story progress comments and writes a
  wave-level rolled-up `wave-run-progress` comment. `/epic-execute`
  reads child wave progress and renders the wave-level table inside
  the operator-facing `epic-run-progress` summary at the top of the
  Epic. Each level owns the comment for its own children; no shared
  writer contention.
- **Q6 — drop dead planner flags; keep checkpoint.** With remote
  triggers gone, `/epic-plan` no longer needs `--phase spec|decompose`
  (existed only so two GH labels could fire two halves) or
  `--auto-dispatch` (applied `agent::dispatching`, which no longer
  exists). The unified two-phase flow with the operator confirmation
  gate is the only mode. The `epic-plan-state` checkpoint comment is
  retained — it costs nothing and helps re-plans.

### Rationale

The four-skill split mirrors how the engine already decomposes work
(`wave-scheduler`, `story-launcher`, `wave-observer` are existing
internal submodules); promoting them to slash commands lets the
operator stop or resume at any level and removes the "this skill
routes by label" indirection. Single-session Agent-tool fan-out trades
process isolation (which the worktree boundary already provided at the
filesystem level) for in-session context budget; in practice the wave
loop spends most of its time waiting on Story sub-agents and the
in-session model was never the bottleneck. Per-level progress
collation localises ownership of each comment to the level that
generates it — no two writers contend for the same comment marker —
at the cost of one extra structured-comment marker
(`wave-run-progress`) per wave, which is cheap.

The label-cleanup scope is deliberately narrow: deleting only the
three trigger-only labels means downstream consumers running existing
state machines on `agent::review`/`agent::done` see no change. The
config-key rename ships with a one-release shim so a typical
`.agentrc.json` update is a no-op until 5.32.0.

### Implications

- **For operators.** The `/sprint-*` muscle memory is gone. New flow:
  `/epic-plan <id>` → `/epic-execute <id>` → `/epic-close <id>`. For
  a single Story off the dispatch table, run `/story-execute <id>`
  directly. The four-skill split lets you stop or resume at any
  level.
- **For repos that used the GitHub-trigger path.** That surface is
  deleted. The `agent::dispatching` label, the
  `epic-orchestrator.yml` workflow, and the `remote-bootstrap.js`
  script are gone. Drive Epics from a local Claude Code session
  going forward; if you genuinely need a GitHub-Action driver,
  re-introduce it as an out-of-tree workflow that invokes the local
  CLI scripts directly.
- **For consumer `.agentrc.json` files.** Rename
  `agentSettings.sprintClose.runRetro` → `agentSettings.epicClose.runRetro`
  on your next edit. The legacy key still reads with a one-shot
  deprecation warning until removal in 5.32.0.
- **For sub-agent prompt budget.** Story sub-agents now share the
  parent session's context budget instead of getting a fresh
  subprocess. The Story prompt deliberately scopes to one Story so
  the budget remains predictable; a runaway Story burns parent
  budget rather than its own.
- **For history continuity.** Structured-comment markers and
  `lib/orchestration/*` paths are unchanged, so existing Epics in
  flight at the cutover boundary continue to validate against the
  same readers.

### References

- Epic #900 body — full goals, non-goals, story decomposition, and
  Q1–Q6 framing.
- ADR 20260427-868a — open-root dispatch-manifest schema +
  AJV fixture drift test (the pattern this Epic adopts for the
  `wave-run-progress` comment shape).
- `docs/CHANGELOG.md` 5.31.0 entry — consumer-visible migration
  block for this Epic.

---

## ADR 20260427-868a: Open-root dispatch-manifest schema; AJV fixture drift test as enforcement boundary

**Status:** Accepted
**Date:** 2026-04-27
**Epic:** #857
**Story:** #868

### Context

`.agents/schemas/dispatch-manifest.json` had `additionalProperties: false`
at the root and a `required` list pinned to one of two manifest variants
(epic-dispatch). The runtime emits two distinct manifest shapes:

1. **epic-dispatch** — written by `dispatcher.js` via `buildManifest()`
   in `.agents/scripts/lib/orchestration/manifest-builder.js`. Persisted to
   `temp/dispatch-manifest-<epicId>.json`.
2. **story-execution** — returned by `executeStory()` in
   `.agents/scripts/lib/orchestration/story-executor.js`. In-memory only.

`buildManifest()` also emits fields the schema did not declare:
`storyManifest[].storyTitle`, `storyManifest[].type`,
`storyManifest[].tasks[].status`, and root-level `agentTelemetry`. With
`additionalProperties: false`, every fresh runtime field caused validation
failure. With a single-variant `required` list, the story-execution shape
could not be validated by the same schema at all.

Two design options were considered:

- **Strict-with-explicit-fields.** Keep `additionalProperties: false` and
  exhaustively list every emitted field. Catches all drift, including new
  unannounced fields. Forces a schema commit for every new runtime field.
- **Open-root + drift test.** Drop root `additionalProperties: false`, list
  the known fields, and rely on a fixture-based AJV drift test running
  `buildManifest()` and `executeStory()` against representative inputs to
  catch shape regressions on every CI build.

### Decision

Adopt the **open-root + drift test** model. Concretely:

1. Drop `additionalProperties: false` at the schema root. Inner objects
   (`summary`, wave items, `dispatched[]`,
   `storyManifest[]`, `storyManifest[].tasks[]`, `stories[]`,
   `stories[].tasks[]`) keep `additionalProperties: false` — those shapes
   are stable and benefit from strict validation.
2. Use a `oneOf` discriminator on the root `type` field
   (`"epic-dispatch" | "story-execution"`) to gate variant-specific
   `required` fields. The epic-dispatch branch tolerates an absent `type`
   for back-compat with the current `buildManifest()` output; new emitters
   should set `type: "epic-dispatch"` explicitly.
3. Add the runtime fields to `properties`: root `agentTelemetry`
   (`object`, `additionalProperties: true`); `storyManifest[].storyTitle`;
   `storyManifest[].type` (group classification:
   `"story" | "feature" | "ungrouped"`); `storyManifest[].tasks[].status`.
4. Add `stories[]` at the root for the story-execution variant.
5. Land the AJV fixture drift test
   (`tests/enforcement/manifest-schema.test.js`) in the same Story so the
   enforcement boundary is in place before the loosened root reaches main.

### Rationale

False-rejection has historically been the more disruptive failure mode for
this contract: a runtime field added without a schema commit blocks every
dispatch run that writes a manifest. Open-root with a CI-blocking drift
test inverts that bias — runtime additions ship without ceremony, but a
shape regression (missing required field, wrong type, wrong enum value)
fails the suite on the same commit that introduces it.

The AJV drift test is run on every CI build via `npm test`, so the
enforcement window is the same as the previous strict-root window. The
trade is "schema diff per new field" for "fixture diff when runtime shape
changes" — the latter is a coarser but more robust drift signal.

### Implications

- **For schema authors:** new optional runtime fields require no schema
  edit; new required fields must be added to the variant's `required`
  list AND covered by a fixture in `manifest-schema.test.js`.
- **For runtime authors:** emitted shape must validate against the schema;
  the AJV error path is surfaced verbatim by the drift test, so failures
  read as `instancePath: keyword` (e.g., `/storyManifest/0: required`).
- **For external consumers:** the schema describes a permissive root; do
  not rely on `additionalProperties: false` to reject unknown root keys.
  Inner objects remain strict.

### Out of scope

- **Splitting into `dispatch-manifest.epic-dispatch.json` and
  `dispatch-manifest.story-execution.json`.** A second consumer needing
  the variants apart is the trigger for that split; today's single-file
  `oneOf` is simpler.
- **Adding `agentTelemetry` to `required`.** Optional by design; the
  executor decides whether to attach telemetry.

## ADR 20260426-829a: Strip-then-analyze for TypeScript scoring; keep typhonjs-escomplex

**Status:** Accepted
**Date:** 2026-04-26
**Epic:** #829

### Context

The maintainability and CRAP gates only scored `.js` and `.mjs`. TS-first
consumer repos (e.g. athlete-portal) hit a degenerate state on
`mandrel` 5.28.1: 21 candidate files scanned, 0 rows written,
because every `.js`/`.mjs` candidate was build-time scaffolding (eslint
configs, `astro.config.mjs`) not exercised by tests. The actual product
surface — TypeScript — was invisible to both gates, so neither
maintainability nor CRAP could produce a useful baseline against the
code consumers care about. Cyclomatic-complexity gating on the real
source was impossible.

The kernel — `typhonjs-escomplex@0.1.0` — uses an Esprima parser that
rejects TypeScript type annotations and JSX outright.

### Decision

Pre-transpile TypeScript and TSX sources to plain JavaScript in memory
via `ts.transpileModule`, then feed the result to the existing escomplex
kernel. `JsxEmit.ReactJSX` is used so JSX expressions become function
calls escomplex can read; `JsxEmit.Preserve` would leave JSX in the
output and Esprima would choke.

Rationale for keeping escomplex rather than swapping kernels:

1. **Type annotations carry no control flow.** `if (x: string)` and
   `if (x)` produce identical cyclomatic and cognitive complexity.
   A TS file's score via strip-then-analyze equals what its
   `tsc --target esnext` JS output would score under escomplex —
   semantics-preserving for every metric the kernel emits.
2. **Existing JS-only consumers see no scoring drift.** The CRAP
   `kernelVersion` bump (1.0.0 → 1.1.0) and MI report kernel bump
   (1.0.0 → 1.1.0) are version-label changes only; the per-file and
   per-method scores for unchanged JS sources are byte-identical.
   A snapshot test in `tests/baselines-byte-identical-js-only.test.js`
   pins this contract.
3. **Replacing escomplex is a multi-week project.** A `ts-morph` +
   custom walker rewrite would invalidate every consumer's committed
   baseline, force a coordinated refresh across the install base, and
   bake in a new kernel that hasn't seen the years of edge-case
   hardening escomplex has. The strip-then-analyze approach piggybacks
   on a battle-tested kernel and ships in a single point release.

`tsTranspilerVersion` is added to the CRAP baseline envelope so
consumers can detect transpiler drift. Both `kernelVersion` and
`tsTranspilerVersion` mismatches **warn**, not fail — consumers
pin-and-bump and need runway to refresh deliberately rather than
discovering the version bump from a hard CI red. `escomplexVersion`
mismatch continues to fail closed: a different kernel can change
scoring semantics without warning, which is exactly the silent drift
the gate exists to catch.

### Alternatives considered

- **Replace `typhonjs-escomplex` with a TS-native walker (`ts-morph`).**
  Rejected. Multi-week effort, kernel risk, and a forced baseline
  refresh across all consumers with no compensating gain in scoring
  fidelity for the JS path.
- **Run a TS strip via custom regex / `@swc/core` / `esbuild`.**
  Rejected. Each adds a dep that's heavier than `typescript` (which
  most consumers already have as a dev-dep) and offers no upside over
  `ts.transpileModule` for this use case.
- **Use `tsc --noEmit` for a project-wide compile.** Rejected. Requires
  a resolvable `tsconfig.json` in the consumer; we deliberately don't
  trust consumer tsconfigs because they may reference paths the gate
  has no business resolving.

### Known limitations

`ts.transpileModule` does not preserve source line numbers verbatim.
JSX runtime imports add a leading line; interface elision shifts
subsequent code. Per-method coverage lookup against a vitest
`coverage-final.json` (which keys lines on the source) will see drifted
line numbers from escomplex (which sees the transpiled output). The
existing `compareCrap` line-drift fallback (same file + method, nearest
startLine wins) absorbs this for baseline comparison; per-method
coverage values may resolve to null on the first scan of a new TS
method, in which case the row is skipped from the baseline rather than
scored as zero. Sourcemap-based line remapping is a future enhancement
and out of scope for 5.29.0.

### Consequences

TS-first repos can adopt the gates without rewriting their build to
emit JS. Existing JS-only repos see a one-time warning on first
`crap:check` / `maintainability:check` after upgrading, directing them
to `npm run crap:update` / `npm run maintainability:update`. Their
score numbers don't change. The scoring kernel is unchanged, so future
ADRs about complexity ranges and tier thresholds remain valid.

## ADR 20260425-773a: CRAP gate becomes hard-enforcing

**Status:** Accepted
**Date:** 2026-04-25
**Epic:** #773

### Context

The CRAP gate (Change Risk Anti-Patterns: `c² · (1 − cov)³ + c`) shipped in
the codebase but no canonical `baselines/crap.json` existed because no
automated coverage capture flowed into the gate. The gate self-skipped on
the missing baseline, producing false-clean reports across all three
firing sites (close-validation, pre-push, CI).

### Decision

Bootstrap `baselines/crap.json` from a real `npm run test:coverage` +
escomplex pass and ship it as the canonical baseline. Remove the
informational early-return from `check-crap.js` so a missing baseline
becomes a hard fail with a clear bootstrap-instruction message at all
three firing sites. Operators bootstrap explicitly via
`npm run crap:update` + a `baseline-refresh:` commit.

### Consequences

A regression now actually blocks merge instead of producing a false
"clean" report. The top-10 method hotspots above CRAP 50 were eliminated
in the same Epic; the long-tail of ten methods at CRAP 50–72 is tracked
as a follow-on story.

## ADR 20260425-773b: Decompose two further large modules behind byte-identical facades

**Status:** Accepted
**Date:** 2026-04-25
**Epic:** #773

### Context

`providers/github.js` and `lib/worktree/lifecycle-manager.js` were the
next two MI-ratchet outliers after the v5.13.0 facade pass. Both had
absorbed ~50% growth since the previous decomposition and were now the
single largest concentrations of provider-side and worktree-side code.

### Decision

Apply the **facade + responsibility-bounded submodules** pattern (already
documented in `docs/patterns.md`) to both. Each top-level file becomes a
≤250 LOC facade re-exporting submodules under `providers/github/*` and
`lib/worktree/lifecycle/*`. Submodules thread a shared `ctx` rather than
importing each other (ctx-threading discipline). Public class surface and
import paths stay byte-identical; only internals move.

### Consequences

Same pattern as v5.13.0, three more concrete applications. Future growth
in either area lands in a focused submodule rather than re-bloating the
facade. Tests pass unchanged because the public surface is preserved.

## ADR 20260425-730a: Consolidate `agentSettings` into a grouped, schema-validated contract

**Status:** Accepted
**Date:** 2026-04-25
**Epic:** #730

### Context

`.agentrc.json` had accumulated a flat `agentSettings` namespace with ~25
peer keys spanning paths, commands, quality gates, limits, and friction
thresholds. The shape made three problems compounded over time:

1. **Discoverability.** A new operator could not tell which keys were
   required, which had defaults, or how related keys grouped — there was no
   typed surface for tooling and no canonical reference for humans.
2. **Validation gaps.** `agentSettings` was schema-permissive; typos in
   optional keys (e.g. `riskGates.heuristics`) silently disappeared during
   the previous template-diff sync, and the resolver's code-level fallbacks
   masked missing required values until a script blew up downstream.
3. **Baseline drift.** Three canonical ratchet baselines lived in three
   different locations under three different naming conventions, and the
   epic-runner's per-wave drift snapshots collided in repo-wide greps with
   the canonical files.

### Decision

Reorganise `agentSettings` into four typed sub-blocks
(`paths`, `commands`, `quality`, `limits`), unify the canonical ratchet
baselines under `/baselines/`, and drive the sync helper from the schema
instead of a structural diff against the template.

Concretely:

- **Grouped contract.** Every former flat key moves under one of the four
  sub-blocks. There are no flat-key reads anywhere in the resolver or in any
  consumer; each sub-block is read through a typed accessor (`getPaths`,
  `getCommands`, `getQuality`, `getLimits`).
- **Hard-required `paths`.** `paths.agentRoot`, `paths.docsRoot`, and
  `paths.tempRoot` are schema-required. The resolver no longer applies
  code-level `?? '.agents'` / `?? 'docs'` / `?? 'temp'` fallbacks; a missing
  value is a validation error with a clear `instancePath`.
- **`null` for disabled commands.** `commands.typecheck` and `commands.build`
  accept `string | null`; an empty string is rejected. `null` is the
  canonical "not applicable" value.
- **Conditional `orchestration.github` requirement.** When
  `orchestration.provider` is `"github"`, the `github` block (with required
  `owner` and `repo`) is schema-required.
- **Static JSON Schema mirror.** Both shipped configs declare
  `"$schema": "./.agents/schemas/agentrc.schema.json"`. The runtime AJV
  schemas in `lib/config-schema.js` and `lib/config-settings-schema.js`
  remain authoritative; the static mirror exists for editor tooling and
  human readers, kept in sync by a drift test.
- **Schema-driven sync helper.** `agents-sync-config` now validates the
  project config against the schema, adds template-introduced keys, and
  preserves every project-side key that validates — including optional keys
  absent from the template (e.g. `orchestration.concurrency`, `closeRetry`,
  `poolMode`). Validation failures abort with a diagnostic instead of
  silently stripping unknown keys.
- **Canonical baselines under `/baselines/`.** `baselines/lint.json`,
  `baselines/crap.json`, and `baselines/maintainability.json` are the
  default-configured paths. The epic-runner's per-wave drift snapshots use
  intentionally distinct filenames (`wave-mi-snapshot.json`,
  `wave-crap-snapshot.json`) under `.agents/state/` so a repo-wide grep
  never confuses one with the other.
- **New configuration reference doc.** `docs/configuration.md` documents
  every configurable key, its default, whether it is required, and the
  baseline conventions. The `.agents/README.md` "Key Settings" table is
  the high-traffic subset; the doc is the canonical source.

### Consequences

- **Breaking for consumers carrying flat-shaped configs.** Migration is
  mechanical (every former flat key has a single grouped equivalent) and
  documented in the v5.26.0 changelog entry. Validation now fails closed,
  so operators learn about misconfiguration at startup instead of at the
  call site that needed the missing value.
- **Editor support comes for free.** Any editor with JSON Schema support
  picks up autocomplete and inline validation from the `$schema` pointer.
- **Future schema changes are cheaper.** Adding a new sub-block in the
  grouped shape is a localised change (one schema edit, one resolver
  accessor, one row in the reference doc); previously the same change
  threaded through multiple flat-key sites.
- **Sync helper trades silent strip for loud abort.** A typo in an optional
  key now aborts the sync with a diagnostic instead of vanishing on round-
  trip. Operators see misconfiguration; the rare false-positive abort is
  the right trade.

### Alternatives considered

- **Keep the flat shape, add a doc.** Rejected: documentation alone does
  not fix the validation gap or the silent-strip behaviour, and the
  resolver's flat-key fallbacks would still mask missing required values.
- **Split `.agentrc.json` into multiple files** (one per concern).
  Rejected: increases the surface operators must reason about and the sync
  helper must reconcile. A single file with a typed grouped shape captures
  the same separation without the file-count tax.
- **Keep `crap-baseline.json` and `maintainability-baseline.json` at repo
  root.** Rejected: collides in greps with the per-wave drift snapshots
  and offers no upside over the unified `/baselines/` directory.

---

## ADR 20260424-702a: Retire mandrel MCP

**Status:** Accepted
**Date:** 2026-04-24
**Epic:** #702

**Supersedes:** ADR-20260422-441b (_Canonical structured-comment writer is the MCP tool_),
which is retained below for historical context only — its conclusion no longer
applies now that the MCP server is gone.

### Context

Version 5.0 introduced the `mandrel` MCP server
(`.agents/scripts/mcp-orchestration.js`) as a JSON-RPC 2.0 facade over the
orchestration SDK. The stated goal was letting an MCP-capable host (Claude
Desktop, Cursor) call `dispatch_wave`, `hydrate_context`,
`transition_ticket_state`, `cascade_completion`, `post_structured_comment`,
`select_audits`, and `run_audit_suite` natively instead of spawning shell
subprocesses.

By early 2026-04 two costs had compounded against that value:

- **Surface duplication.** Every orchestration capability already shipped as
  a Node CLI wrapper around the same SDK (`dispatcher.js`,
  `context-hydrator.js`, `update-ticket-state.js`,
  `post-structured-comment.js`, `audit-orchestrator.js`). The MCP server was
  a second entry point to the same code path — two schemas to keep in sync,
  two permission surfaces to validate, two places for a structured-comment
  marker to drift. Epic #380's retro-routing regression (a retro body was
  mis-posted through the webhook because the MCP tool's `type` enum missed
  `retro`) and Epic #441's marker-shape fixes (ADR-20260422-441b) were both
  direct consequences of that duplication.
- **Operator ergonomics.** `.mcp.json` became the canonical home for
  `NOTIFICATION_WEBHOOK_URL` (v5.8.0 consolidation), which meant operators
  had to provision one file for secrets that their IDE's MCP host would
  also read. Fresh checkouts needed the file before `/sprint-execute` would
  find a webhook. Worktrees had to bootstrap-copy it into every isolated
  tree. Every surface that resolved the webhook had to traverse two code
  paths. Epic #710 traced the test webhook leak behaviour back to this
  dual sourcing.

### Decision

Retire the `mandrel` MCP server and its companion artefacts:

- Delete `.agents/scripts/mcp-orchestration.js` and everything under
  `.agents/scripts/lib/mcp/` and `.agents/scripts/mcp/`.
- Delete the dedicated MCP docs (`.agents/MCP.md`, `docs/mcp-setup.md`).
- Drop the `mandrel` block from `.agents/default-mcp.json` and stop
  shipping a template that advertises the server.
- Collapse webhook resolution to env-only: `NOTIFICATION_WEBHOOK_URL` is
  read from the process environment (loaded from `.env` locally, or set in
  the Claude Code web environment-variables UI). `.mcp.json` is no longer
  consulted.
- Keep the existing Node CLI wrappers under `.agents/scripts/` as the sole
  consumer interface to the orchestration SDK.

Third-party MCP servers an operator wants to wire into their IDE
(`@modelcontextprotocol/server-github`, `context7`, etc.) remain
unaffected — `.mcp.json` is still a valid file in that role, it just
doesn't carry a framework-shipped entry anymore.

### Where the capabilities live now

| Retired MCP tool                               | Successor                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__mandrel__dispatch_wave`          | `node .agents/scripts/dispatcher.js --epic <id>` (same SDK, same dispatch-manifest output).                                                  |
| `mcp__mandrel__hydrate_context`        | `node .agents/scripts/hydrate-context.js --ticket <id> --epic <id>` for the JSON envelope; `context-hydrator.js` remains the raw-prompt wrapper. |
| `mcp__mandrel__transition_ticket_state`| `node .agents/scripts/update-ticket-state.js --task <id> --state <state>` (auto-cascades on `agent::done`).                                  |
| `mcp__mandrel__cascade_completion`     | Inlined into `update-ticket-state.js`; also runs at Story close inside `story-close.js`.                                              |
| `mcp__mandrel__post_structured_comment`| `node .agents/scripts/post-structured-comment.js --ticket <id> --marker <marker> --body-file <path>`; direct `provider.postComment` in lib code. |
| `mcp__mandrel__select_audits`          | `node .agents/scripts/select-audits.js --ticket <id> --gate <gate>`.                                                                         |
| `mcp__mandrel__run_audit_suite`        | `node .agents/scripts/run-audit-suite.js --audits <comma-list>`.                                                                             |

The SDK modules under `.agents/scripts/lib/orchestration/` (the things
these tools delegated into) are unchanged — the retirement is a surface
removal, not a logic change.

### Consequences

- **Positive:** One entry point per capability; one schema per argument
  shape; one place for a marker contract to live. Structured-comment
  `type` drift (ADR-20260422-441b) is no longer a possible failure mode
  because there is no parallel writer.
- **Positive:** `.mcp.json` is no longer load-bearing for framework
  orchestration. Operators provision secrets in `.env` (local) or the
  Claude Code web env-var UI (web); `.mcp.json` is reserved for the
  MCP host's own discovery of third-party servers.
- **Positive:** Worktree bootstrap drops `.mcp.json` from its copy list;
  one fewer file to keep in sync across isolated trees.
- **Negative (breaking):** Operators who previously relied on the IDE
  invoking tools natively must now invoke the Node CLIs directly (or let
  the `/sprint-*` workflows invoke them, which they already did). The
  CLI mapping above is the migration list.
- **Negative (breaking):** Operators who kept `NOTIFICATION_WEBHOOK_URL`
  or `GITHUB_TOKEN` only in `.mcp.json` must move them to `.env` (local)
  or the Claude Code web env-var UI. The notifier resolver no longer
  reads `.mcp.json`.
- **Negative (fork-aware):** Consumer repos that pulled
  `.agents/default-mcp.json` into their own `.mcp.json` must remove the
  `mandrel` entry during their next submodule bump; leaving it
  in place resolves to a now-missing script path.

### Alternatives considered

- **Keep the MCP server, deduplicate the schemas.** Rejected: the
  duplication was *between* the MCP tool layer and the CLI wrappers, not
  within the tool layer. Consolidating one side still leaves two surfaces.
- **Delete the Node CLIs instead, keep MCP as the only surface.** Rejected:
  the CLIs are invoked directly by the `/sprint-*` workflows, by
  `remote-bootstrap.js` under GitHub Actions, and by consumer projects'
  own scripts. They are not optional; the MCP server was.
- **Keep the MCP server but move webhook resolution to env-only.**
  Rejected: solves the leak symptom without addressing the duplication
  cost. The Epic #710 audit concluded the surface itself was the
  liability, not the specific webhook lookup.

---

## ADR 20260424-668a: Resolve `worktreeIsolation.enabled` from environment, not config

**Status:** Accepted
**Date:** 2026-04-24
**Epic:** #668

### Context

Two execution environments coexist for `/sprint-execute`: local Claude Code
sessions on a developer machine (one shared filesystem, multiple agents) and
web Claude Code sessions at claude.ai/code (each session is its own sandboxed
clone). The shared-filesystem coordination problem that `.worktrees/` solves
locally does not exist on web — the session itself is already an isolated
clone. A single committed `orchestration.worktreeIsolation.enabled` value
cannot serve both: flipping it between local and web runs would pollute git
history and confuse other contributors.

### Decision

`orchestration.worktreeIsolation.enabled` becomes a **resolved** value, not
just a read value. `resolveWorktreeEnabled(opts, env)` in
`lib/config-resolver.js` consults environment signals before falling back to
the committed config. Precedence:

1. `env.AP_WORKTREE_ENABLED === 'true'` → `true` (explicit operator override).
2. `env.AP_WORKTREE_ENABLED === 'false'` → `false` (explicit operator
   override).
3. `env.CLAUDE_CODE_REMOTE === 'true'` → `false` (web-session auto-detect).
4. Otherwise → committed `orchestration.worktreeIsolation.enabled`.

The same resolver also publishes `runtime.sessionId`, preferring
`CLAUDE_CODE_REMOTE_SESSION_ID` when available (set automatically inside web
sessions) and falling back to a hostname+pid+random short-id. The committed
config is read-only at runtime; no workflow writes it.

### Consequences

- **Positive:** One committed config, two execution environments, no git-
  history thrash. Web sessions auto-disable worktrees; local sessions retain
  the v5.7.0 isolation behaviour. Operators can force either mode locally with
  one env var.
- **Positive:** `runtime.sessionId` is available as a stable per-process
  identity surfaced in the startup `[ENV] sessionId=…` log line for
  operator log-correlation, with no separate identity layer required.
  *(The original consumer of this id — the claim-protocol pool mode —
  was retired in story #909; the field is preserved for diagnostics
  only.)*
- **Negative:** The resolver consumes process environment, not config — typos
  in env var names fall through silently to the next rule. Mitigated by
  string-equality matching (`'true'` / `'false'` literal) so `"0"` / `""` /
  truthy-but-non-matching values cannot accidentally flip the flag.
- **Negative:** The worktree-off path is exercised less often than the
  worktree-on path on local machines. Mitigated by a diff test that runs the
  same fixture both ways and asserts the on-branch logs are byte-identical to
  a saved baseline.

### Alternatives considered

- **Two committed configs (`.agentrc.web.json` / `.agentrc.local.json`).**
  Rejected: would require runtime selection logic anyway and operators would
  still hand-edit one to ship.
- **Auto-detect via `git worktree list` size or filesystem inspection.**
  Rejected: indirect signal, unreliable in CI and exotic environments. The
  explicit `CLAUDE_CODE_REMOTE` marker Anthropic ships in web is the right
  contract.
- **Dedicated `/sprint-execute-web` slash command.** Rejected: forks the
  codepath. The Epic's hard requirement was operator parity — the same
  command, with the same contract, working in both environments.

---

## Earlier ADRs (001 / 002 / 003)

ADRs 001–003 (April 9–17, 2026) predate the Epic-#900 terminology rework
and have been moved to
[`archive/decisions-pre-900.md`](archive/decisions-pre-900.md). ADR 004
(Gherkin Standards) remains active and is documented below.

## ADR 004: Gherkin Standards as Sole SSOT for BDD Tags & Forbidden Patterns

**Status:** Accepted
**Date:** 2026-04-19
**Epic:** #269

### Context

Epic #269 introduces a BDD authoring framework: one rule
(`.agents/rules/gherkin-standards.md`), two skills
(`skills/stack/qa/gherkin-authoring`, `skills/stack/qa/playwright-bdd`), one
workflow (`/run-bdd-suite`), and a pyramid-aware rewrite of
`testing-standards.md`. Without a single source of truth for the tag taxonomy
and forbidden patterns, the two skills and every consuming project would
inevitably drift into parallel vocabularies — exactly the failure mode that
made Cucumber suites unmaintainable in earlier industry cycles.

### Decision

`.agents/rules/gherkin-standards.md` is the **sole** SSOT for:

- the canonical tag taxonomy (`@smoke`, `@risk-high`, `@platform-*`,
  `@domain-*`, `@flaky`);
- the forbidden-pattern list (SQL/ORM calls, status codes, DOM selectors, raw
  URLs, payloads, framework names, explicit waits);
- Scenario Outline conventions, selector discipline, and the step-reuse
  protocol.

Skills and workflows MUST reference the rule rather than restate it. Additions
to the taxonomy require a PR that updates the rule before use. The
`testing-standards.md` pyramid rule is the companion SSOT for tier-placement of
assertions; acceptance-tier scenarios defer shape-of-data concerns to contract
tests rather than encoding them in `.feature` files.

### Consequences

*   **Positive:**
    *   One place to look for the tag grammar; reviewers can mechanically
        reject unknown tags.
    *   `gherkin-authoring` and `playwright-bdd` stay focused on *how* and
        *when* without redefining *what*.
    *   The audit from Task #294 becomes a repeatable pattern — grep the
        skills for redefinition, point at the rule.
*   **Negative:**
    *   Rule-level changes are higher friction than editing a skill; adding a
        new domain tag requires a PR to the rule.
*   **Mitigation:**
    *   `@domain-<slug>` is extensible by design — consumers pick their own
        slug without touching the rule. Only the top-level tag *categories*
        are closed.

---

## ADR: Decompose oversized orchestration modules via facade pattern

**Status:** Accepted
**Date:** 2026-04-20
**Epic:** #297

### Context

Three orchestration-SDK modules grew past the point where a single file
usefully described a single responsibility: `lib/worktree-manager.js`
(1,234 LOC), `lib/orchestration/dispatch-engine.js` (874 LOC), and
`lib/presentation/manifest-renderer.js` (600 LOC). The 5.12.3 clean-code
audit flagged them as the top structural-complexity outliers in the
repository. The DRY portion of the audit had already been addressed via
new shared utilities (`lib/risk-gate.js`, `lib/label-constants.js`,
`lib/path-security.js`, `lib/error-formatting.js`,
`lib/issue-link-parser.js`). What remained was purely a structural
decomposition.

### Decision

Split each target file into cohesive submodules, then reduce the original
file to a **thin facade** that re-exports the same public symbols.

- `lib/worktree-manager.js` → 223-LOC facade composing `lib/worktree/`
  submodules (`lifecycle-manager`, `node-modules-strategy`,
  `bootstrapper`, `inspector`).
- `lib/orchestration/dispatch-engine.js` → 196-LOC coordinator composing
  `wave-dispatcher`, `risk-gate-handler`, `health-check-service`,
  `epic-lifecycle-detector`, `dispatch-pipeline`, and `dispatch-logger`.
- `lib/presentation/manifest-renderer.js` → 175-LOC facade composing
  `manifest-formatter` (pure) and `manifest-persistence` (fs I/O).

The facade files are the **only** part of the stable public surface;
submodule paths are internal implementation detail.

### Consequences

*   **Positive:**
    *   No caller needs to change — `dispatcher.js`,
        `mcp-orchestration.js`, `sprint-story-{init,close}.js`, and every
        test file continue to import from the existing paths.
    *   Each submodule owns one responsibility and is individually
        unit-testable; 65 new per-submodule tests landed alongside the
        refactor (13 manifest + 35 worktree + 17 orchestration).
    *   Future behaviour changes touch the submodule that owns the
        concern, not a 1,000-LOC grab-bag.
*   **Negative:**
    *   The facade carries a handful of backwards-compat `_*` delegate
        methods on `WorktreeManager` so the existing 46-test
        `worktree-manager.test.js` keeps passing without edits. They are
        technical debt to be retired once those tests migrate to
        per-submodule imports.
    *   One new lazy-VerboseLogger implementation (`dispatch-logger.js`)
        duplicates the pattern used elsewhere in the codebase.
*   **Mitigation:**
    *   Retro action items track both the delegate retirement and the
        lazy-logger consolidation.
    *   Downstream consumers are explicitly told (in `architecture.md`
        and this ADR) that only the facade paths are stable — submodule
        paths may be renamed without a major version bump.

---

## ADR-20260421: Epic-level remote orchestration via GitHub label trigger

*   **Status:** Accepted (Epic #321, v5.14.0).
*   **Context:** Before v5.14.0 `/sprint-execute` was story-scoped and
    operator-driven: the operator picked Stories off the dispatch table
    and launched each in its own window. Wave advancement and bookend
    chaining (review → retro → close) were manual. The orchestration
    primitives to automate this already existed (`dispatch_wave`,
    `Graph.computeWaves()`, `cascadeCompletion`), but no long-running
    driver tied them together.
*   **Decision:** A new `/sprint-execute-epic` skill wraps a composed
    `EpicRunner` coordinator that walks the wave DAG, fans out per-story
    executor sub-agents (bounded by `concurrencyCap`), checkpoints
    progress on the Epic via the `epic-run-state` structured comment,
    and halts only at `agent::review` or on blocker escalation. A
    GitHub Actions workflow (`epic-orchestrator.yml`) fires on
    `agent::dispatching` label application, boots a Claude remote
    agent, and launches the same skill against the same engine. Local
    and remote runs share code path.
*   **Alternatives considered:**
    *   Build a separate "epic executor" service running outside
        GitHub — rejected because it would reinvent the dispatcher and
        require its own state store.
    *   Extend `/sprint-execute` to accept either Story or Epic IDs
        (single command, switch on type) — rejected for v5.14.0 to keep
        the rename/alias story clean; planned for Epic #349.
    *   Runtime HITL approval on every wave boundary — rejected; the
        Epic's whole value proposition is HITL-minimal execution.
*   **Consequences:**
    *   Three operator touchpoints on the happy path: dispatch,
        blocker resolution, review hand-off.
    *   `epic::auto-close` authorizes autonomous merge-to-main, so
        branch protection on `main` becomes the primary defense for
        destructive actions.
    *   `risk::high` runtime gating is retired (see ADR below); the
        label remains as retro-visible metadata.
    *   The remote-agent environment has a new secret surface
        (`ENV_FILE`, `MCP_JSON`, `GITHUB_TOKEN`); `::add-mask::` +
        `0600` file perms in `remote-bootstrap.js` are the contract.

---

## ADR-20260421: Retire `risk::high` runtime gating

*   **Status:** Accepted (Epic #321 Story #334, v5.14.0).
*   **Context:** `risk-gate-handler.js` halted the dispatcher on
    `risk::high` tasks, and `story-close.js` halted close for
    `risk::high` stories. In the new HITL-minimal model this becomes
    two per-ticket gates the orchestrator must pause on — incompatible
    with unattended remote runs.
*   **Decision:** The runtime halt is removed. `handleRiskHighGate`
    reduces to a log-only warning; `wave-dispatcher.js` dispatches
    `risk::high` tasks unconditionally; `story-close.js` gates
    only when both `hitl.riskHighApproval` **and**
    `hitl.riskHighRuntimeGate` are explicitly `true` (both default
    `false`). The label is preserved — retros and planning can still
    query it as metadata.
*   **Alternatives considered:** rename the label to
    `metadata::risk-high` to make its informational nature legible —
    deferred to Epic #349 as it is a breaking taxonomy change.
*   **Consequences:**
    *   Destructive-action containment moves from runtime approval to
        (a) GitHub branch protection on `main`, (b) executor sub-agent
        `agent::blocked` escalation when an unauthorized destructive
        action is detected, (c) `epic::auto-close` as a deliberate
        opt-in that must be set at dispatch.
    *   `handleHighRiskGate` in `story-close.js` becomes dead
        code behind a hidden opt-in flag — cleanup tracked in Epic
        #349 Wave 0.

---

## ADR-20260422: Two-stage Windows worktree reap (fs.rm retry + deferred sweep)

*   **Status:** Accepted (Epic #380 Story #386, v5.15.1).
*   **Context:** The v5.7.0 worktree-per-story model ships a clean
    `reap` path for POSIX, but on Windows `git worktree remove` + the
    follow-up `fs.rm` routinely fail with `EBUSY` / `ENOTEMPTY` because
    antivirus, indexing, and `node_modules` file handles hold the
    directory open for seconds after the merge completes. The v5.15.0
    symptom was `branchDeleted: false` from `/sprint-story-close` plus
    orphan `.worktrees/story-<id>/` residue that broke the next
    `npm run lint` (nested `biome.json` in the orphan was picked up).
*   **Decision:** Reap is now a two-stage operation inside
    `lifecycle-manager.js`:

    1. Primary path retries `fs.rm(..., { recursive: true, force: true,
       maxRetries, retryDelay })` on `EBUSY` / `ENOTEMPTY`.
    2. Anything still pinned after retry is queued into
       `.worktrees/.pending-cleanup.json` and drained on the next
       worktree-manager run by `worktree-sweep.js`.

*   **Explicitly rejected approaches:**
    *   **Shelling out to `rm -rf` / `cmd /c rd /s /q`** — makes the
        deletion opaque to Node, silently succeeds while antivirus is
        still scanning, and would require per-platform branching. The
        `fs.rm` retry path surfaces real errors and is test-drivable
        with an injected adapter.
    *   **Switching the default `node_modules` strategy to `symlink` or
        `pnpm-store`** to shrink the reap surface — rejected; the
        `per-worktree` strategy is the only one that is correct on every
        platform and CI image, and the original Epic #229 ADR
        (ADR 003) documents why. The Windows reap problem is worth
        fixing on its own terms without touching the install model.
    *   **Global mutex around reap** — rejected for the same reason the
        fetch path refused one: it would erase the parallelism the
        worktree model is designed to enable.
*   **Consequences:**
    *   `/sprint-story-close` reports `branchDeleted: true` on Windows
        across the common antivirus failure modes; the remaining tail
        is handled asynchronously by the sweep.
    *   New artefact: `.worktrees/.pending-cleanup.json` (see
        `docs/data-dictionary.md#8-epic-380-artefacts-v5151`).
    *   Orphan-worktree biome lint block (documented in operator
        auto-memory) disappears once the sweep drains a queued entry.

---

## ADR-20260422: `/sprint-retro` routes through provider.postComment, not notify.js

*   **Status:** Accepted (Epic #380 Story #388, v5.15.1).
*   **Context:** `notify.js` dispatches via the Make.com webhook
    configured in `orchestration.notificationWebhookUrl`. It is the
    right surface for operator pings ("your story needs review") but
    the wrong surface for retro bodies, which are long-form markdown
    with internal-only friction analysis. v5.15.0 routed retros through
    `notify.js`; the webhook forwarded every retro to Slack, leaking
    draft content and friction citations to channels that should never
    have seen them.
*   **Decision:** `/sprint-retro` posts the retro body via
    `provider.postComment` (or the MCP `post_structured_comment` tool
    when running under the MCP harness). The ticket issue is the SSOT
    for retros; no external webhook is invoked. A `retro-partial`
    structured-comment checkpoint is written during collection so a
    crashed retro resumes without re-reading the friction log.
*   **Alternatives considered:**
    *   Keep `notify.js` but filter retro payloads at the webhook side —
        rejected; the webhook is out-of-repo and out-of-review, so a
        filter there is not auditable from this repository.
    *   Write retros to a local file and upload as a gist — rejected;
        breaks the "GitHub issue is the SSOT" invariant the whole
        framework rests on.
*   **Consequences:**
    *   Retro routing is resolved at the framework level, not just as a
        per-project rule.
    *   `notify.js` is now scoped exclusively to short operator pings;
        its payload surface is correspondingly smaller.
    *   Retro resumption is a first-class flow: the `retro-partial`
        marker is idempotent and the final `retro-complete` upsert
        replaces it on success.

## ADR-20260422: Pre-wave spawn smoke-test + post-wave commit assertion

*   **Status:** Accepted (Epic #413 Stories #419 / #420, v5.15.2).
*   **Context:** The single highest-impact bug of Epic #380 was that
    every Story dispatched via the `defaultSpawn` adapter exited in ~3
    seconds without doing any work. A one-line Windows shell-quoting
    bug wasted a full 28-second "successful" wave. The fix landed
    mid-close as commit `6830fbe`, but nothing in the runtime path
    would have flagged the regression earlier than "wave reports done,
    no commits exist."
*   **Decision:** Two complementary guards are wired into the
    `epic-runner` coordinator:
    1.  `SpawnSmokeTest` (`lib/orchestration/epic-runner/spawn-smoke-test.js`)
        runs `claude --version` through the real `buildClaudeSpawn`
        shape before Wave 1 dispatches. A non-zero exit (or 5s
        timeout) halts the runner with a friction comment naming
        `CLAUDE_BIN`, the exit code, and stderr; the Epic flips to
        `agent::blocked`.
    2.  `CommitAssertion` (`lib/orchestration/epic-runner/commit-assertion.js`)
        runs after each wave reports `done`. It iterates the done
        Stories and confirms every `origin/story-<id>` has at least
        one new commit reachable from `origin/epic/<epicId>`. A
        zero-delta story reclassifies the wave as `halted`.
*   **Alternatives considered:**
    *   Rely on the close-time assertion alone — rejected; that
        already exists implicitly (no commits → close fails) but the
        feedback loop is too long. Catching the spawn bug at Wave 1
        instead of Wave N saves up to N × wave-duration of wasted run.
    *   Invoke `claude --version` once at runner load — rejected;
        the failure mode was specifically about the
        `--dangerously-skip-permissions` arg shape, which `--version`
        + a stub binary doesn't fully exercise. The smoke-test runs
        the real shape.
*   **Consequences:**
    *   The `defaultSpawn` regression class fails fast (in seconds, not
        a wave) and surfaces a structured friction comment on the
        Epic. Operators no longer need to read the runner stdout to
        diagnose.
    *   The `CommitAssertion` adds one provider round-trip per Story
        per wave — negligible against the wave duration but real
        against a 100-Story epic; the gating is not configurable
        (intentionally — silent zero-delta closes are always wrong).
    *   The Epic #413 retro itself is the proof: while writing this
        ADR, the runner correctly identified a no-spawn condition
        for Wave N would not have surfaced under the prior protocol.

## ADR-20260422: `sprint-story-close` recovery via explicit --resume / --restart

*   **Status:** Accepted (Epic #413 Story #421, v5.15.2).
*   **Context:** Epic #380's mid-close on Story #389 required ~30
    minutes of manual git surgery (resolve the merge in progress,
    re-run validation, re-merge to the Epic branch). The stock
    `story-close.js` had no concept of "resuming" — re-running
    it from the worktree always re-ran init/implement/validate
    end-to-end, which was wasteful and racy.
*   **Decision:** `story-close.js` now classifies the close-time
    state via `detectPriorState()` into one of: `clean` (default,
    proceed), `unmerged-story-branch` (story branch has commits ahead
    of `epic/<id>` that haven't merged), `merge-in-progress` (UU
    markers on `epic/<id>`), or `dirty-worktree` (uncommitted edits in
    `.worktrees/story-<id>/`). With no flag, the script prints the
    detected state + remediation guidance and exits.
    `--resume` picks up at the merge resolution step without
    re-running init/implement/validate. `--restart` aborts any partial
    state and re-inits from scratch.
*   **Alternatives considered:**
    *   Always re-init (the prior behaviour) — rejected; throws away
        in-flight work and risks loss of uncommitted changes in the
        worktree.
    *   Detect the state and silently auto-resume — rejected; the
        operator should explicitly choose recovery vs restart so an
        accidental partial state isn't promoted to "shipped" without
        review.
*   **Consequences:**
    *   The recovery path Epic #380 needed to execute manually for
        Story #389 reduces to `sprint-story-close --story 389 --resume`.
    *   The default (no-flag) failure is loud and informative rather
        than silent — operators see what state the close is in before
        they choose their next action.

## ADR-20260422-441a: Force-reap worktrees whose Story branch is already merged

*   **Status:** Accepted (Epic #441 Story #451, v5.15.3).
*   **Context:** Epic #413's `/sprint-close` Phase 4 reaper left 3 of 6
    worktrees orphaned (`story-420`, `story-423`, `story-424`) with
    `reap-skipped: uncommitted-changes`, even though every Story branch
    had already merged into `epic/413`. The "uncommitted" content was
    biome-format drift and already-merged agent edits — safe to
    discard, but the reaper's conservative default preserved them and
    required manual `rmdir` + `git worktree prune` + `git branch -D`.
*   **Decision:** When `git merge-base --is-ancestor` confirms the
    Story branch is already part of `epic/<id>`, Phase 4 force-reaps
    the worktree by default (`git worktree remove --force` + prune +
    `branch -D`). The destructive step is bounded to "already-merged"
    state, so the only content at risk is post-merge drift. A
    `--no-reap-discard-after-merge` flag restores the prior
    conservative behavior. Force-reap emits a `friction` structured
    comment naming the Story and listing the discarded paths so the
    signal isn't lost.
*   **Alternatives considered:**
    *   Move the assertion check before the reaper (so the reap runs
        against the still-unmerged branch) — rejected; it conflates
        merge state with reap state and does not solve the "Windows
        worktree is EBUSY because a process holds a file handle" case.
    *   Require every close to commit format drift onto the Story
        branch before merging — rejected; increases pre-merge noise
        without changing the post-merge "discard is safe" property.
*   **Consequences:**
    *   The manual reap recipe becomes obsolete for the `already-merged`
        case; truly-in-progress worktrees are now the exclusive domain
        of the `--no-` override.
    *   Operators who intentionally leave work-in-progress in a
        worktree after close must pass the override explicitly.

## ADR-20260422-441b: Canonical structured-comment writer is the MCP tool

*   **Status:** Accepted (Epic #441 Story #449, v5.15.3).
*   **Context:** The MCP tool
    `mcp__mandrel__post_structured_comment` originally
    accepted only `progress | friction | notification` as `type`
    values. As a result, `epic-code-review.js`,
    `.claude/skills/epic-retro.md`, the wave-observer, and the
    progress-reporter each hand-rolled their own structured-comment
    marker and posted via `provider.postComment` directly, bypassing
    payload-schema validation. During Epic #413's close, the retro
    flow had to fall back to `notification` type as a workaround.
*   **Decision:** The MCP tool's `type` enum + payload schema are
    extended with `code-review`, `retro`, `retro-partial`,
    `epic-run-state`, `epic-run-progress`, `parked-follow-ons`,
    `dispatch-manifest`, and a regex for parametric `wave-N-start` /
    `wave-N-end`. All consumers that previously hand-rolled markers
    route through the tool. Hand-rolled `provider.postComment` calls
    with structured markers are treated as an anti-pattern.
*   **Alternatives considered:**
    *   Leave the enum as-is and continue hand-rolling — rejected;
        duplicates the marker invariants across multiple call sites
        and loses schema validation.
    *   Accept arbitrary `type` strings — rejected; loses the
        validation surface that catches typo-driven markers.
*   **Consequences:**
    *   A single canonical writer enforces marker shape + payload
        validation. The retro-fallback-to-`notification` regression is
        no longer possible.
    *   New structured-comment types are a schema bump, not a
        convention change — future additions land alongside their
        validators.

## ADR-20260423: Trust the ticket, not the pipe — idle-timeout ground truth

*   **Status:** Accepted (Epic #470, v5.17.0).
*   **Context:** `epic-runner` spawns each Story as
    `claude -p '/sprint-execute <id>' --dangerously-skip-permissions`.
    The `-p` flag runs the CLI in batch mode: the model's final response
    is the only stdout the pipe ever sees, emitted at session exit.
    For architect-tier stories that legitimately take >15 minutes of model
    + tool time, the pipe stays silent the whole run. The idle-watchdog
    was therefore firing on real work, not hangs, and declaring the
    Story `failed` even when the sub-agent went on to merge and close
    the ticket cleanly. Compounding the problem on Windows, the
    `shell: true` spawn meant `proc.kill()` terminated `cmd.exe` only,
    orphaning the grandchild `node` running Claude Code; the orphan
    often finished the work after the runner had reported failure.
*   **Decision:** The idle-timeout path is no longer authoritative.
    When the watchdog fires, the runner (A) calls `killProcessTree(proc)`
    — on Windows `taskkill /T /F /PID` to reap the whole tree, elsewhere
    `proc.kill()` — then (B) polls the Story ticket every 15s for up to
    120s via `provider.getTicket(id, { fresh: true })`. If a grace read
    finds `agent::done`, resolve `done`; `agent::blocked` resolves
    `blocked`; otherwise the runner finally reports `failed` with the
    actual label list in the detail string.
*   **Alternatives considered:**
    *   Raise `idleTimeoutSec` globally — papers over the mismatch; long
        stories just fail a few minutes later. Rejected.
    *   Force `claude -p` to stream token output — not a supported CLI
        flag. Rejected.
    *   Switch to a tier-aware timeout — architect stories get 30m,
        engineer stories 15m. Adds config surface without fixing the
        Windows orphan. Folded into (A)+(B) as future tuning.
*   **Consequences:**
    *   False-positive `failed` halts on long Stories stop happening —
        the runner reports the ticket's actual state.
    *   Windows grandchild orphans no longer survive `proc.kill()`.
    *   Friction-comment detail now reads
        `idle-timeout: no output for 900s; labels=<actual labels>`
        instead of speculating "likely hung on interactive prompt".
    *   Resumed runs short-circuit already-done Stories in `iterate-waves`
        via a pre-launch label fetch, so a blocker halt no longer costs
        a fresh worktree + `npm ci` for every closed Story on re-run.

---

## ADR-20260423-511a: Features remain in the cascade; Epics and Planning do not

*   **Status:** Accepted
*   **Date:** 2026-04-23
*   **Epic:** #511
*   **Context:** `cascadeCompletion()` previously excluded only `type::epic`,
    `context::prd`, and `context::tech-spec` parents. Features fell through
    the exclusion list silently — they auto-closed because nothing stopped
    them, not because the behaviour had been chosen. A Feature still being
    scoped while early Stories landed closed prematurely, stranding later
    scope work without a parent.
*   **Decision:** Keep Feature auto-close, and make it an explicit choice
    rather than an implicit side-effect. A Feature carries no standalone
    branch, no merge step, and no release artefacts — when its last child
    Story closes, the Feature is complete by definition, and a manual close
    step would be pure ceremony. Operators who want Feature-level
    acceptance-criteria verification should encode it in the final child
    Story. The exclusion list in `cascadeCompletion()` is now asserted by a
    regression test pinned under Epic #511 so future refactors cannot drift.
*   **Alternatives considered:**
    *   Add `type::feature` to the exclusion list — forces a manual close
        step with no corresponding merge/release work. Rejected as
        ceremony.
    *   Scope-guard Features via a new `feature::scoping-complete` label —
        adds surface area to solve a problem the Story-level workflow
        already owns.
*   **Consequences:**
    *   Feature cascade behaviour is load-bearing, not accidental.
    *   A future refactor that accidentally adds `type::feature` to the
        exclusion list fails the pinned test rather than silently changing
        closure semantics.
    *   The Feature auto-close rule is now documented in
        [`architecture.md` § Cascade Behavior](architecture.md#cascade-behavior).

---

## ADR-20260423-511b: `transitionTicketState.fromState` lookup keeps its swallow, now with a debug log

*   **Status:** Accepted
*   **Date:** 2026-04-23
*   **Epic:** #511
*   **Context:** `transitionTicketState()` wraps the prior-state label
    lookup in a silent try/catch — any error leaves `fromState` as `null`
    and downstream notifier payloads ship `{ fromState: null, toState: … }`.
    The review under Epic #511 asked: deliberate or accidental?
*   **Decision:** Deliberate — keep swallowing. A transient network flake
    reading the prior label must not block a legitimate state transition;
    the transition itself is the authoritative event. Add a `debug`-level
    log so the operator can correlate a null `fromState` with the
    underlying error, and document `null` as a valid value in the notifier
    payload contract.
*   **Consequences:**
    *   Transitions remain resilient to read flakes.
    *   Consumers that branch on `fromState` must handle `null`
        explicitly (existing contract now documented).
    *   Silent failures are observable at `debug` log level.

---

## ADR-20260423-511c: Dispatch-manifest writes are atomic (tmp + rename)

*   **Status:** Accepted
*   **Date:** 2026-04-23
*   **Epic:** #511
*   **Context:** `.agents/scripts/lib/presentation/manifest-persistence.js`
    wrote the dispatch manifest directly. A crash mid-write (or a full
    disk) left the file truncated; the next orchestrator run consumed a
    corrupt JSON file as if it were the source of truth.
*   **Decision:** Write to `temp/dispatch-manifest-<epicId>.json.tmp`, then
    `fs.renameSync()` to the final path. `rename` is atomic on the same
    filesystem — the final path either carries the previous valid manifest
    or the newly-written one, never a partial write. If `rename` fails,
    delete the `.tmp` residue and re-throw. Surface the persist outcome to
    the MCP caller via `manifestPersisted: boolean` and optional
    `manifestPersistError: string` on the `dispatch_wave` tool result —
    callers (notably `sprint-execute`) already treat the manifest as
    canonical, so a failed persist must not be swallowed.
*   **Consequences:**
    *   A mid-write crash never corrupts the manifest.
    *   MCP callers can branch on `manifestPersisted` instead of reading a
        stale file unknowingly.
    *   Regression test covers the write-failure path (`fs.writeFileSync`
        throws `EACCES`, assert `manifestPersisted: false` + error string).

---

## ADR-20260424-553a: Bounded-concurrency + TTL cache for epic-runner fanout

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #553
*   **Context:** Two independent performance audits converged on the same
    hot paths. `wave-gate.js` ran three serial `for..of` loops of
    `await getTicket`; `ProgressReporter` fanned out `getTicket(id, { fresh: true })`
    across every story in every wave on every cadence tick; `state-poller`
    fetched a full ticket per tracked story just to read `.labels`; every
    `GitHubProvider` construction spawned `gh auth token` afresh. On large
    epics this produced avoidable wall-clock and risked secondary rate
    limits. Unbounded `Promise.all` would trade sequential latency for a
    thundering-herd problem.
*   **Decision:** Introduce a single `concurrentMap(items, fn, { concurrency })`
    primitive at `lib/util/concurrent-map.js` and adopt it at every
    framework fanout: wave-gate (all stories), commit-assertion at wave-end
    (cap 4; git is CPU/disk-bound), progress-reporter (cap 8). Extend the
    provider cache with `getTicket(id, { maxAgeMs })`; swap the
    progress-reporter's `{ fresh: true }` for `{ maxAgeMs: 10_000 }`. Prime
    the ticket cache from every `getTickets(epicId)` sweep so downstream
    per-ticket reads cost zero HTTP. Memoize the first successful
    `gh auth token` into `process.env.GITHUB_TOKEN` so subsequent provider
    constructions short-circuit. Add a bulk `issues?labels=agent::*&state=open`
    path to `state-poller` with malformed-response fallback to per-ticket.
*   **Consequences:**
    *   10-second TTL staleness is the ceiling on label-observation
        lag. Any write through the provider invalidates the cache
        entry, so post-write reads are fresh.
    *   Concurrency caps are currently constants; an `agentSettings`
        override is deferred until the phase-timer data (same Epic)
        demonstrates where the caps actually bind.
    *   Bulk-poll is guarded by an explicit well-formedness check;
        label-schema drift falls back to the per-ticket path rather
        than propagating bad state.
    *   Phase-timer instrumentation (ADR-20260424-553b) is the
        measurement surface that validates these caps on future epics —
        no more guessing.

---

## ADR-20260424-553b: Per-phase timing as a first-class epic-runner surface

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #553
*   **Context:** Consumers could not distinguish framework-intrinsic
    overhead (worktree create, `.agents/` copy, bootstrap) from their own
    costs (install, lint, test, implement) when a story took too long.
    Progress snapshots reported wave-level state but carried no timing
    data, so perf regressions were caught by anecdote rather than
    measurement. Future perf work had no baseline to measure against.
*   **Decision:** Build `lib/util/phase-timer.js` + `phase-timer-state.js`
    as a framework primitive with `snapshot` / `restore` semantics so
    phase spans survive the `sprint-story-init` → `sprint-story-close`
    boundary. Emit per-phase elapsed-time lines during the lifecycle.
    On Story close, post a `phase-timings` structured comment on the
    Story ticket. Extend `ProgressReporter` to aggregate **median /
    p95** across every closed Story in the current wave and render the
    result into the Epic's `epic-run-progress` comment.
*   **Consequences:**
    *   Per-Story timings become the regression canary for future
        framework-overhead changes — the next perf Epic starts with
        data, not inference.
    *   The `phase-timings` comment is machine-readable so consumer
        projects can build their own dashboards without scraping logs.
    *   The `ProgressReporter` aggregation runs behind the same TTL +
        concurrency cap introduced in ADR-20260424-553a — observability
        cannot re-introduce the fanout cost it was designed to measure.

## ADR-20260424-596a: CRAP as a sibling gate, not a replacement for MI

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #596
*   **Context:** The maintainability (MI) gate ratchets a per-file composite
    score, but is coverage-blind: a 30-branch function scores identically
    whether it has 0% or 100% test coverage. MI tells operators *what to
    refactor*; it does not tell them *what to test next*. Per-method
    cyclomatic complexity (from `typhonjs-escomplex`) and per-method coverage
    (from the `c8` artifact) were already present in CI but unused for risk
    signalling. Folding the new model into the MI baseline envelope would
    have churned every existing consumer baseline and conflated two distinct
    questions (file-level refactor priority vs. method-level test priority)
    onto one ratchet.
*   **Decision:** Ship CRAP as a **sibling pipeline** with its own baseline
    artefact (`crap-baseline.json`), CLIs (`check-crap`, `update-crap-
    baseline`), and config block (`agentSettings.maintainability.crap`).
    Wire it at the same three sites as MI (close-validation, ci.yml, pre-
    push) but enforce a **hybrid** model: tracked methods ratchet with line-
    drift fallback; new methods must score ≤ `newMethodCeiling` (default 30,
    the canonical CRAP threshold). Removed methods are surfaced as a counter,
    never a failure. Both gates share an envelope shape
    (`{ kernelVersion, summary, violations }`) so agent workflows can consume
    both with one parser.
*   **Consequences:**
    *   Existing `maintainability-baseline.json` stays valid — no consumer
        repo gets a free baseline reshuffle on adoption.
    *   The two questions separate cleanly: MI = "where is the rot?", CRAP
        = "where is the untested complexity?".
    *   A future Epic can refactor both gates onto a shared envelope/helper
        base if/when symmetry pays off; today's parity is shape-level only.

## ADR-20260424-596b: Base-branch-enforced anti-gaming guardrail

*   **Status:** Reverted (2026-05-12) — see CHANGELOG 5.42 entry. The
    `baseline-refresh-guardrail.yml` workflow and its supporting CLI
    script were removed alongside the bot-approver pipeline. The
    `baseline-refresh:`-tagged commit convention is preserved as an
    operator standard but is no longer machine-enforced. Decision text
    retained for historical context.
*   **Date:** 2026-04-24
*   **Epic:** #596
*   **Context:** A PR that simultaneously raises `newMethodCeiling` in
    `.agentrc.json` AND introduces a method over the new (relaxed) ceiling
    would pass its own gate — the gate reads its own branch's config. With
    agentic authorship, this is not a hypothetical: the shortest path to
    green CI is to relax the threshold. A purely advisory "don't do this"
    norm would be eroded within weeks.
*   **Decision:** Add a `pull_request`-only `baseline-refresh-guardrail.yml`
    workflow that reads thresholds from the **base branch** via
    `git show origin/<base>:.agentrc.json`, then re-runs `check-crap` with
    those values forced via `CRAP_NEW_METHOD_CEILING` / `CRAP_TOLERANCE` /
    `CRAP_REFRESH_TAG` env vars. Any PR that touches `crap-baseline.json` or
    `maintainability-baseline.json` must include at least one commit whose
    subject starts with the configured `refreshTag` (default
    `baseline-refresh:`) AND whose body is non-empty — both required.
    Baseline-only PRs receive the `review::baseline-refresh` label
    idempotently across re-runs.
*   **Consequences:**
    *   Threshold relaxation requires either a separately committed baseline
        refresh (with justification body) or it fails CI under base-branch
        values — a malicious or careless PR cannot do both at once.
    *   The label ensures every refresh is reviewer-visible even on green
        CI; "silently merged a baseline" is no longer a possible failure
        mode.
    *   The env-var seam is the same one operators can use ad-hoc to test
        a stricter ceiling against the current branch — testing surface is
        identical to the enforcement surface.

## ADR-20260424-596c: Kernel-version stamp on the CRAP baseline

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #596
*   **Context:** `typhonjs-escomplex` makes scoring decisions that change
    between minor versions. Without a version stamp, an upstream dependency
    bump silently rescores every method, producing a ghost baseline that
    looks healthy but compares against numbers no one ran. Worse, an
    "everything passes" run after a bump masks real regressions in the
    delta. Consumer repos pulling the framework as a submodule absorb the
    bump without warning.
*   **Decision:** Stamp `crap-baseline.json` with two version fields:
    `kernelVersion` (the inline CRAP formula's contract) and
    `escomplexVersion` (the dep). On any mismatch with the running scorer,
    `check-crap` exits 1 with `[CRAP] scorer changed from X to Y — run 'npm
    run crap:update'`. The bootstrap path (no baseline at all) still exits 0
    with a different message — first-run on a consumer repo must never hard-
    fail.
*   **Consequences:**
    *   Dependency bumps surface explicitly with a clear remediation, not
        as a quiet rescore.
    *   Bootstrap and version-mismatch are distinct exit codes (0 vs 1)
        and distinct messages — operators do not have to diff stdout to
        tell a fresh repo from a dependency drift.
    *   The `kernelVersion` field gives us a future-proof seam for
        in-formula changes (e.g., switching from `(1−cov)³` to `(1−cov)²`)
        without a destructive force-rescore on every consumer.

---

## ADR-20260424-638a: `story-566` reap recovery is a self-inflicted dirty-tree bug

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #638 (Story #648)
*   **Context:** Epic #553 close fired the `worktree.reap recovered via
    fs-rm-retry … attempts=1 lockReason=contains modified or untracked
    files` warning on `story-566`. The log is shaped for Windows-lock
    recovery, but `attempts=1` and the stderr quoted `git worktree
    remove`'s *own* uncommitted-files guard — not a lock class error.
    Classification required tracing the full reap path on a framework
    checkout (where `.agents/` is a tracked directory, not a submodule).
*   **Root cause:** `removeCopiedAgents()` in
    `.agents/scripts/lib/worktree/bootstrapper.js` unconditionally
    `fs.rmSync`'s `<wtPath>/.agents` before `git worktree remove` runs.
    The three follow-up index operations self-guard on
    `isAgentsSubmodule(repoRoot)` and no-op in framework repos, but the
    physical delete does not. In the framework repo the deletion wipes a
    tracked directory, producing a deliberate dirty state that `git
    worktree remove`'s pre-check flags with "contains modified or
    untracked files, use --force to delete it". The belt-and-braces
    `fs.rm` then removes the whole worktree, so the reap ultimately
    succeeds — but the warn log misattributes the cause to a Windows
    lock, and every framework-repo story close pays the retry cycle.
*   **Why the existing coverage missed it:**
    `tests/lib/worktree-manager.test.js` line 1419 — *"skips index
    scrub in non-submodule (framework) repos"* — creates `wtPath` but
    never materialises `wtPath/.agents`, so `fs.lstatSync` throws and
    the `fs.rmSync` branch is never exercised. Real framework worktrees
    always have a checked-out `.agents/` directory.
*   **Decision:** Classify as a **recoverable bug (outcome b)**. Guard
    the `fs.rmSync`/`fs.unlinkSync` in `removeCopiedAgents` with
    `isAgentsSubmodule(repoRoot)`, matching the self-guard already
    present on the three index-scrub follow-ups. Keep the
    `removeWorktreeWithRecovery` fs-rm fallback in place as
    belt-and-braces for genuine Windows locks. Add a regression test
    asserting that a materialised `.agents/` survives
    `removeCopiedAgents` in a non-submodule repo.
*   **Consequences:**
    *   Framework-repo story closes stop paying the retry cycle and
        stop emitting misleading `fs-rm-retry` warnings on every close.
    *   `git worktree remove` now succeeds on its first attempt in the
        common framework path; Stage 1 recovery resumes being a
        real-failure signal instead of a self-inflicted one.
    *   Submodule-consumer repos are unaffected: `isAgentsSubmodule`
        returns true, the physical delete still runs, and the index
        scrub + modules purge continue as before.
    *   The retained fs-rm fallback still covers the true Windows-lock
        case it was designed for.

## ADR-20260426-817a: Validation evidence is keyed by commit SHA, not by build ID

*   **Status:** Accepted (Epic #817, v5.28.0).
*   **Context:** Epic #817's hot-path audit found lint and tests running
    five-plus times per Story against the same tree (sprint-execute Step 2,
    story-close, sprint-code-review, sprint-close Phase 4, pre-push, CI).
    The dominant local cost was repeat work, not new work, and the
    duplicate runs were the largest source of agents chasing the same
    failure across phases. We needed a skip mechanism that did not let a
    stale pass paper over a fresh regression.
*   **Decision:** Each successful gate (lint, test, biome format, MI, CRAP)
    writes `{ gateName, commitSha, commandConfigHash, timestamp, exitCode }`
    under the per-Epic tree at
    `temp/epic-<epicId>/validation-evidence.json` (Epic-scoped) or
    `temp/epic-<epicId>/story-<storyId>/validation-evidence.json`
    (Story-scoped). Callers thread both the scope id and the owning Epic
    id through `evidence-gate.js`. A subsequent caller skips
    the gate **only** when the current `git rev-parse HEAD` matches the
    recorded `commitSha` AND the resolved command-config hash matches.
    Anything else — dirty tree, new commit, config change, missing
    evidence file — runs the gate. `--no-evidence` is the explicit override
    for iterating on a flaky test.
*   **Consequences:**
    *   Repeat phases against an unchanged tree skip in milliseconds.
    *   False-green risk stays bounded: any working-tree change at the
        commit-SHA granularity invalidates the evidence; config drift
        invalidates it via the command-config hash.
    *   Evidence is `temp/`-local and gitignored, so the skip is per-clone
        — CI gets its own evidence record (or none), and pre-push hooks
        retain authoritative independence.

## ADR-20260426-817b: `sprint-story-close` is the canonical local Story validation gate

*   **Status:** Accepted (Epic #817, v5.28.0).
*   **Context:** `sprint-execute.md` Step 2 used to require an explicit
    `npm run lint && npm test` before invoking `story-close.js`,
    which then re-ran the same gates as part of close-validation. Headless
    sub-agent runs paid the cost twice; interactive runs blurred the
    decision of which result was authoritative. With evidence-aware skip
    in place (#817a), the duplication was no longer needed for safety.
*   **Decision:** `story-close.js` is the single source of truth
    for local Story merge readiness. The pre-flight `npm run lint &&
    npm test` is now described as advisory `--fast` mode for interactive
    iteration — failures will be re-surfaced by the close-validation gate
    regardless. Sub-agent runs may proceed straight from implementation
    to close.
*   **Consequences:**
    *   Per-Story wall-clock cost roughly halves on sub-agent runs.
    *   Operator authority is unambiguous: the close gate's verdict is
        the verdict.
    *   Interactive `--fast` mode remains useful in terminals where the
        operator wants a fast read on a fix before composing the close.

## ADR-20260426-817c: Soft-failing gates surface degraded state explicitly, not silently

*   **Status:** Accepted (Epic #817, v5.28.0).
*   **Context:** `select-audits.js` (diff timeout fallback to keyword-only),
    `lint-baseline.js` (zero-error fallback on JSON parse failure), and
    `baseline-refresh-guardrail.js` (empty-changed-files on `git diff`
    failure) all returned permissive zero-error envelopes when their
    inputs failed. The audit found this fail-open behaviour produced
    silent green runs that read identically to genuine clean runs.
*   **Decision:** Each soft-failing gate either fails closed under
    `--gate-mode` (or `MANDREL_GATE_MODE=1`) — non-zero exit, no
    permissive output — or returns a structured `{ ok: false, degraded:
    true, reason, detail }` envelope on stdout with a non-zero exit code.
    The caller decides how to interpret. The mute fail-open path is gone.
*   **Consequences:**
    *   Operators can no longer mistake a degraded run for a clean one.
    *   CI / pre-push integrations that previously absorbed the silent
        green now see explicit degraded output and may need a one-line
        adjustment to their handling.
    *   The structured envelope shape is consistent across all three
        gates so a single helper detects degradation.

## ADR-20260426-817d: CLI entrypoints carry `node:coverage ignore file`; their `main()` is exercised via integration tests, not unit-line coverage

*   **Status:** Accepted (Epic #817 follow-on, v5.28.1).
*   **Context:** Story #816's long-tail CRAP cleanup attempted to score
    `run-audit-suite.js::main`, only to find the file was silently dropped
    from the CRAP scan because its first comment line is
    `/* node:coverage ignore file */`. Twenty-one other CLI entrypoints
    under `.agents/scripts/*.js` carry the same directive, including
    `epic-runner.js`, `story-close.js`, `story-init.js`,
    `epic-planner.js`, `dispatcher.js`, `epic-plan-spec.js`,
    `epic-plan-decompose.js`, `notify.js`, `health-monitor.js`,
    `post-structured-comment.js`, `pool-claim.js`, `remote-bootstrap.js`,
    `select-audits.js`, `ticket-decomposer.js`, `agents-bootstrap-github.js`,
    `assert-branch.js`, `context-hydrator.js`, `diagnose-friction.js`,
    `hydrate-context.js`, `epic-plan.js`, and `epic-plan-healthcheck.js`.
    The convention pre-dates this Epic but had never been written down,
    making it ambiguous whether the directive on a given file was a
    deliberate convention or an accidental escape hatch.
*   **Decision:** The `node:coverage ignore file` directive is the
    canonical convention for **CLI entrypoint scripts** under
    `.agents/scripts/`. An entrypoint's `main()` orchestrates pure helpers
    that are themselves unit-tested; the orchestrator is exercised
    end-to-end via the framework's integration suite (story-init/close
    happy paths, dispatcher fan-out, manifest generation, friction
    posting) and via the `tests/*-cli.test.js` suites that drive each CLI
    via `runAsCli` with stubbed I/O. We do not chase per-line coverage on
    `main()` itself because (a) its branches are flag-parsing and exit
    code routing whose value at the line level is dwarfed by the helper
    behaviour the integration tests already cover, and (b) running the
    CLI under coverage costs wall-clock time the helper-level tests buy
    cheaper.
*   **Scope of the convention:**
    *   The directive applies to **CLI entrypoints only** — files at the
        top of `.agents/scripts/` that ship a `runAsCli(import.meta.url,
        main, ...)` invocation or are the documented `node ...` target
        of a workflow phase.
    *   It does **not** apply to library files under
        `.agents/scripts/lib/`. Library code remains fully covered.
    *   It does **not** waive the obligation to ratchet helpers exercised
        by the entrypoint. The "extract pure helpers + add tests" pattern
        from Story #792 / #816 still applies — pull complex branching
        out of `main()` into testable helpers in either the same file
        (`export function ...`) or a sibling module under `lib/`.
*   **Consequences:**
    *   The CRAP gate's silent drop of these 22 files is intentional and
        documented; future audits can stop flagging it as a gap.
    *   New CLI entrypoints follow the same convention. If a new
        entrypoint does **not** carry the directive, that is a deliberate
        choice — typically because the file is small enough to remain
        fully testable as a single unit — and should be called out in
        the PR description.
    *   The convention is reviewed if a regression slips past the helper
        tests but would have been caught by main-level coverage. None
        observed to date.

## ADR-20260502-960a: Production code is not shaped by test internals — tests import helpers directly with an explicit `ctx` bag

*   **Status:** Accepted (Epic #946, Stories C1+C2 → #960).
*   **Context:** `WorktreeManager` historically grew a "Backwards-compat
    delegates for tests that probe private helpers" block — five
    `_`-prefixed methods (`_copyBootstrapFiles`, `_provisionWorkspace`,
    `_copyAgentsFromRoot`, `_removeCopiedAgents`, `_isAgentsSubmodule`)
    that existed solely so the pre-split `tests/lib/worktree-manager.test.js`
    suite could keep calling instance methods after the implementation
    was decomposed into `lib/worktree/bootstrapper.js` and
    `lib/workspace-provisioner.js`. The delegates added no behaviour;
    they were a compatibility shim for the test file. Production
    callers (the lifecycle layer) had already migrated to the helper
    modules and passed an explicit `ctx` bag, so the delegates were
    dead weight on the production code path while the test file
    continued to pretend the manager owned the logic.
*   **Decision:** Production modules do not carry test-shaped surfaces.
    When a class's internal helpers are extracted into pure functions
    that take a `ctx` bag, the corresponding tests **migrate to the
    helper module directly** rather than the class re-exposing the
    helper as a private method. The migration pattern is "test imports
    the helper directly, constructs a `ctx` bag with the fields the
    helper documents, and asserts on the helper's return value or its
    side-effects." The class loses the underscore-prefixed delegate.
    Stories C1+C2 of Epic #946 codified this for the worktree split:
    `tests/lib/worktree-manager.test.js` now calls
    `provision({ sourceRoot, targetWorktree, files, logger })` from
    `workspace-provisioner.js` and
    `copyAgentsFromRoot(ctx, wtPath)` /
    `removeCopiedAgents(ctx, wtPath)` /
    `isAgentsSubmodule(repoRoot)` from `worktree/bootstrapper.js`
    instead of the deleted `wm._*` delegates.
*   **Consequences:**
    *   `WorktreeManager` shrinks: the ~70-line backwards-compat block
        in `lib/worktree-manager.js` is gone, leaving only the public
        lifecycle facade (`ensure`, `reap`, `gc`, `prune`, `list`,
        `pathFor`, `isSafeToRemove`, `sweepStaleLocks`).
    *   Tests for the bootstrap / submodule logic become independent of
        the class's wiring — they exercise the helper contract
        verbatim, so a future split or rename of `WorktreeManager` does
        not invalidate the suite.
    *   New code follows the same rule: a helper extracted "for
        testability" is tested at the helper boundary, not via a
        manager-level passthrough. Reviewers reject `_`-prefixed
        delegates whose only call site is a test file.
    *   The ctx bag fields each helper expects are documented in the
        helper's JSDoc; tests construct bags inline rather than
        reaching through a partially-constructed class instance to
        mutate them (the old `wm._isAgentsSubmodule = () => true`
        pattern is replaced by `ctx.isAgentsSubmodule: () => true`).

## ADR 20260507-1114a: Freshness gate on decompose — fail fast on stale path references

**Status:** Accepted
**Date:** 2026-05-07
**Epic:** #1114

### Context

Epic #1072 surfaced a class of decomposer hallucination that the existing
cross-validation pass could not catch: the planner LLM referenced a code
asset (`aggregate-phase-timings.js`) that had been deleted in a prior Epic
but was still cited by an upstream PRD/Tech Spec excerpt. The resulting
Task #1109 was created on GitHub, dispatched to a Story sub-agent, and
only failed at implementation time when the agent could not find the
file. By then the Story was already executing, the worktree was checked
out, and the planner's mistake had to be unwound by hand
(`state_reason: not_planned` close + Story body edit).

The closing Epic for that cleanup (#1072) deferred the gate itself — the
deleted file was patched over but the structural cause was left open.
Story #1125 of Epic #1114 codifies the gate as a freshness check on the
Task body and AC, run inside `validateAndNormalizeTickets` before any
GitHub creation happens.

### Decision

Add `validateAcFreshness({ tickets, baseBranchRef, gitRunner })` to
`.agents/scripts/lib/orchestration/ticket-validator.js`. The check runs
**only** on tickets whose `type === 'task'` (Features/Stories carry
narrative copy that routinely names docs and templates) and scans every
`body.{goal,changes,acceptance,verify}` string plus a defensive
top-level `acceptance` array. Path references are matched by a single
regex anchored to three repository roots:
`(\.agents/scripts|lib|tests)/.*\.js`. For each unique referenced path,
the validator probes `git cat-file -e <baseBranchRef>:<path>` (existence,
not content); a non-zero exit means the path does not exist at the Epic
base branch tree and the planner is referencing a stale or hallucinated
asset.

When one or more probes fail the validator throws
`ValidationError` with the offending Task slug and missing path for
**every** miss in a single batched message — operators see the full
remediation list in one pass rather than fixing one slug at a time. The
gate is wired into the canonical decompose chain via
`epic-plan-decompose.js → decomposeEpic → validateAndNormalizeTickets`,
threading `config.baseBranch` (default `main`) through the call so each
project's configured base branch is honoured.

### Consequences

*   **Decompose now fails fast** when a planner hallucinates a code
    asset that does not exist on the Epic base branch. The failure
    surfaces before any GitHub issue is created, so operators do not
    have to unwind partial decompositions or close hallucinated Tasks
    as `not_planned`.
*   **The validator's signature is a no-op opt-in.** Callers that omit
    `opts.baseBranchRef` (legacy unit tests, ad-hoc replays without a
    git context) keep their pre-1114 semantics — the freshness clause
    is skipped entirely. Production decompose always passes the ref so
    the gate is on by default in the live path.
*   **Regex bounds are intentional.** The three roots
    (`.agents/scripts`, `lib`, `tests`) cover the executable surface
    that decomposer Tasks legitimately edit. Docs (`docs/`), baselines
    (`baselines/`), and fixture data are deliberately out of scope —
    they change frequently and a planner naming a docs path is not a
    structural failure mode worth blocking the decompose pass on.
*   **Probe results are cached per path** within a single decompose
    run. Sibling Tasks that cite the same helper module hit the cache
    instead of re-spawning git, keeping the gate's overhead linear in
    the number of unique referenced paths rather than in the number of
    Tasks.
*   **Story #1089's body was edited as a side cleanup** (Task #1139)
    so a future re-decompose pass against that Story does not re-cut a
    structurally impossible Task. The bullet citing the deleted
    aggregator script is gone; a follow-on note in the Story body
    records the `not_planned` closure of Task #1109 under Epic #1072.

---

## ADR 20260512-loop-adoption: Adopt built-in `/loop`; no homegrown surface to reconcile

**Status:** Accepted
**Date:** 2026-05-12
**Epic:** #1471 (v6.0.0 Epic G — Claude Code-first adoption)
**Story:** #1557 (Rebase homegrown loop on built-in `/loop` or document divergence)
**Supporting evidence:** [`temp/epic-1471/loop-contract-comparison.md`](../temp/epic-1471/loop-contract-comparison.md) — full discovery audit and contract surface table.

### Context

The Epic G phasing (Tech Spec #1545, Phase 2, Story 5) flagged the homegrown `loop` skill as a candidate for one of four reconciliation outcomes against the Claude Code built-in `/loop`: **rebase**, **thin-to-reference**, **delete**, or **document-divergence**. The Tech Spec explicitly noted the homegrown skill's location was "TBD by Story 5 investigation" — the audit was the first deliverable.

### Decision

**Adopt the built-in `/loop` as the sole loop surface.** No homegrown skill is rebased, thinned, or deleted because none exists.

The discovery audit (full table in the supporting comparison file) confirmed:

- `.claude/commands/`, `.claude/skills/`, `.agents/skills/core/`, and `.agents/skills/stack/` contain no `loop` skill or slash command.
- The host skill manifest exposes a single `loop:` entry — the Claude Code built-in (*"Run a prompt or slash command on a recurring interval; e.g. `/loop 5m /foo`. Omit the interval to let the model self-pace."*).
- The historic deletions of `scripts/run-agent-loop.js`, `tests/run-agent-loop.test.js`, and `tests/e2e/run-agent-loop-e2e.test.js` (commits `0d6ef1b8`, `e6a11089`) were the legacy pre-v5 wave runner — a different concept, not a Claude Code skill, and already removed.
- Internal library helpers (`lib/util/poll-loop.js`, `lib/orchestration/epic-runner/phases/iterate-waves.js`) are programmatic loops inside the dispatcher, not operator-facing skills, and are out of scope for the loop-skill comparison.

The Story-level verdict therefore collapses the four candidate outcomes into one: **`document-divergence`** — where the "divergence" being recorded is the absence of any homegrown competitor, which is the desirable end state.

### Consequences

- **No code or workflow files change for this Story.** The verdict is documentation-only.
- **The `loop` row in `docs/claude-code-catalog.md`** (landing in Story 8 of this Epic) carries the classification **`adopt`** with this ADR as the citation.
- **Future contributors reaching for "the homegrown loop"** are pointed at this ADR plus the comparison file, which together demonstrate the audit was performed and re-implementation would be a regression against the two-surface coupling stance (ADR 20260512-coupling-stance above).
- **Cron-style durability** (jobs surviving session restart) is **not** in `/loop`'s contract. The host's separate `schedule:` skill covers that need; if the framework needs it, a follow-on Epic should evaluate `schedule:` adoption explicitly rather than reintroducing a homegrown loop runner.
- **Failure semantics inheritance.** Looping a flaky command (e.g. `/loop 5m /audit-flaky-thing`) does not abort on a single bad tick — the looped command remains responsible for its own retry/backoff. This is the same model the framework's existing internal cadence helpers use, so no behavioural surprise is introduced by adopting `/loop` for operator-facing recurrence.

### Alternatives considered

- **Build a homegrown `/loop` skill anyway** to own a "structured loop" artifact contract. Rejected — the framework's recurring tasks (cadence polls, dashboard regen, PR babysitting) already own their own artifacts via the underlying scripts; a wrapper would add no contract value and would directly violate the Epic's "shrink the framework's homegrown surface area" goal.
- **Defer to a future hybrid wrapper pattern** (built-in delegated to from a homegrown entry point, as `/security-review` is delegated from `audit-security`). Rejected for `/loop` specifically — the hybrid pattern's value is when the wrapper owns a structured artifact (`audit-*-results.md`). `/loop` produces no artifact; it just re-prompts. There is nothing for a wrapper to validate or fold in, so the hybrid pattern collapses to a pass-through.

---

## ADR 20260513-command-naming-discipline: Domain-vocabulary command names; single Mandrel-prefixed discoverability entry

**Status:** Accepted
**Date:** 2026-05-13
**Epic:** #1184 (v6.0.0 Epic F — Cut-over + Mandrel rebrand)
**Story:** #1601 (Scripts + commands surface audit; `/mandrel` discoverability)
**Supporting evidence:** A full reference-count audit of the script + command surface as of 2026-05-12 (audit report archived post-release with `docs/audits/` in commit `8855ab6c`).

### Context

The Mandrel rebrand from `agent-protocols` surfaces a one-way decision about command naming: do every Mandrel-owned slash command name a brand prefix (`/mandrel-epic-deliver`, `/mandrel-audit-clean-code`, etc.), or does the brand stay out of the per-command surface and live in a single discoverability entry?

Brand-prefixing every command is reverse-coupling: it makes the consumer's `/` menu cluttered with `mandrel-` repetition, hides the descriptive verb (`epic-deliver` says what it does; `mandrel-epic-deliver` says what it does *and* who owns it, which the operator already knows because they installed the framework), and reverses the same logic that keeps `.agents/` and `.agentrc.json` filenames unchanged through the rebrand (those names describe the artifact, not the brand).

### Decision

Adopt a two-part naming-discipline rule for the slash-command surface:

1. **Per-command names describe what the command does** in the harness's domain vocabulary. The framework's domain has a small, stable noun-verb taxonomy: `epic-*`, `story-*`, `audit-*`, `worktree-*`, `git-*`, `agents-*` (the last reserved for operations scoped to the `.agents/` directory itself). A new command picks the noun that describes its surface and a verb that describes its action. No brand prefix.
2. **One Mandrel-prefixed discoverability entry, `/mandrel`,** prints the auto-generated catalog of Mandrel-owned commands. The brand prefix exists exactly once in the runnable surface — at the entry point a consumer types to learn the surface. Day-to-day commands stay descriptive.

The seven-row recategorization matrix from the Epic body (#1184) codifies the specific decisions that flow from the rule. Each row is reproduced below with its rationale so future contributors can resolve the same ambiguities without reopening them:

| Item | Decision | Rationale |
| --- | --- | --- |
| `agents-bootstrap-*` → `mandrel-bootstrap-*` | **Keep `agents-bootstrap-*`** | The name describes what it bootstraps — the `.agents/` directory, which the rebrand explicitly preserves as a stable filename. Brand-prefixing where the artifact name is already more self-describing is reverse-coupling. |
| `agents-update` → `mandrel-update` | **Keep `agents-update`** | Updates the `.agents/` submodule pointer; that is what the name says. Same rationale as the bootstrap row. |
| `delete-epic-*` workflows → scripts-only | **Keep as workflows** | Destructive operations benefit from slash-command discoverability and the workflow-level confirmation step. The scripts are thin, but the operator's entry point and confirmation home is the workflow file. |
| `epic-plan` / `epic-deliver` → `mandrel-plan` / `mandrel-deliver` | **Keep as `epic-*`** | "Epic" is the domain concept the framework operates on. `mandrel-plan` is strictly less informative ("plan what?"). The noun the workflow acts on is the right primary axis for the name. |
| `story-execute` → helper | **Keep as command** | Operator-facing for individual story re-runs and debugging. The documented argument is a Story ID; the workflow is intended to be human-invocable, not just a fan-out target. |
| `worktree-lifecycle` → helper | **Move to `.agents/workflows/helpers/`** | The file self-describes as "operator and reviewer reference" — it is documentation, not an executable workflow. It is already path-included from `story-execute.md`. It should not appear in the `/` menu as runnable. After the move, `sync-claude-commands.js` automatically drops `.claude/commands/worktree-lifecycle.md` because the sync filter excludes the `helpers/` subdirectory. |
| `drain-pending-cleanup` → helper | **Keep as command** | Operator-facing escalation tool for Windows EBUSY. Automatic callers exist, but the manual path is load-bearing — an operator hitting a wedged worktree types `/drain-pending-cleanup` directly. |

### Consequences

- **`/mandrel` becomes the canonical discoverability entry.** A new workflow at `.agents/workflows/mandrel.md` (landed by the companion Task #1619) prints the catalog auto-generated from the on-disk workflow set. The catalog is never stored on disk — generation happens at invocation time, so adding or renaming a workflow is reflected without a sync step.
- **`worktree-lifecycle` is removed from the runnable `/` menu.** The file moves to `.agents/workflows/helpers/worktree-lifecycle.md`; `story-execute.md`'s path-include is updated to the new location; the next `npm run sync:commands` drops the orphan slash-command file.
- **Future commands inherit the rule.** When introducing a new workflow, the contributor picks the descriptive noun-verb pair and skips the brand prefix unless ambiguity is real. The one place ambiguity is real is the entry point itself, and that slot is now claimed by `/mandrel`.
- **Adopters reading `docs/decisions.md`** can resolve "why isn't this `mandrel-*`?" without reopening the matrix. The seven rows are the load-bearing precedents.

### Alternatives considered

- **Brand-prefix every command** (the maximalist position). Rejected — clutters the `/` menu, makes every consumer-facing example longer, reverses the same naming logic that keeps `.agents/` and `.agentrc.json` stable through the rebrand, and offers no information value because the consumer already knows which framework they installed.
- **No brand prefix anywhere, including a discoverability entry.** Rejected — adopters need *some* affordance to tell Mandrel-owned commands apart from Claude Code built-ins. Without a single entry point, the only path is reading the docs site, which is a worse first-run experience than typing `/mandrel`.
- **Per-command opt-in: prefix only the "Mandrel-distinctive" commands.** Rejected — every framework command is "Mandrel-distinctive" by virtue of being owned by the framework. Drawing the line by judgment regenerates the same ambiguity the rule is designed to eliminate.
