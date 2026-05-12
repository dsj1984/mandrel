# Prompt-Shaped Script Ledger — 2026-05-11

Audit snapshot for **Epic #1181** (v6 Epic C — Skills migration + telemetry
consolidation). Re-verified against `main` on 2026-05-11 in branch
`story-1436` under Story #1436 / Task #1442.

This ledger is the source of truth that downstream migration Stories (A2 /
A3 / A4) consume when deciding whether a script under `.agents/scripts/`
moves to a Skill, stays imperative, or is deleted. The Skill-vs-Script
decision rule that codifies the ledger lives in
[`.agents/README.md`](../../.agents/README.md#when-to-use-a-skill-vs-a-script).

## Verdict matrix — Epic-named scripts

The seven scripts listed in the Epic PRD's "confirmed prompt-shaped" set,
re-verified for current LOC and authorship pattern on `main` at the time
of this audit.

| # | Script | LOC (current) | LOC (Epic PRD) | Verdict | Pattern | Migration target |
| - | ------ | ------------: | -------------: | ------- | ------- | ---------------- |
| 1 | `.agents/scripts/analyze-execution.js`    | 696 | 416 | prompt-shaped | Reads NDJSON, composes a perf-summary prompt, upserts a `story-perf-summary` / `epic-perf-report` structured comment. The summarisation step is judgment, not parseable transform. | Skill (A3). Read side of NDJSON moves to `lib/signals/` per Track B. |
| 2 | `.agents/scripts/diagnose-friction.js`    | 279 | 279 | prompt-shaped | Wraps a shell command, classifies failure into a `friction` signal record. The classification step (suggestion text + tier) is prompt + judgment. | Skill (A3). Signal-append helper stays as a library call. |
| 3 | `.agents/scripts/epic-plan-decompose.js`  | 281 | 281 | prompt-shaped (split) | `--emit-context` half is deterministic (PRD/Tech-Spec fetch + JSON envelope). The host-LLM authoring step in the middle is the prompt. Persist half is deterministic GitHub I/O + schema validation. | Skill (A2) for the authoring middle only. `--emit-context` and persist halves stay scripts (Epic PRD "Bootstrap exemption"). |
| 4 | `.agents/scripts/ticket-decomposer.js`    | 621 | 621 | prompt-shaped (engine) | Underlying engine for `epic-plan-decompose.js`. Carries the system prompt + schema for the host LLM. | Skill (A2) — engine collapses once `epic-plan-decompose.js` dispatches the Skill directly. If no remaining callers post-migration, delete. |
| 5 | `.agents/scripts/hydrate-context.js`      | 139 | 139 | prompt-shaped (thin) | Emits a `{ prompt }` JSON envelope for the host LLM to consume before a Story / Task workflow. Pure prompt assembly, no deterministic output. | Skill (A3). Wrapper file shrinks to a Skill `SKILL.md` + tiny CLI shim if still invoked by `node` from a slash command. |
| 6 | `.agents/scripts/epic-plan-spec.js`       | 401 | 399 | prompt-shaped (split) | Same shape as `epic-plan-decompose.js`: deterministic `--emit-context` + persist halves wrap a host-LLM authoring middle. | Skill (A2) for the authoring middle only. Other halves stay scripts. |
| 7 | `.agents/scripts/epic-planner.js`         | 327 | 327 | prompt-shaped (legacy) | Superseded by `epic-plan-spec.js`. Still carries the v5.6 system-prompt surface. | Delete (A2) once `epic-plan-spec.js` no longer imports its prompt assets. The Epic PRD's "removed scripts" list names it explicitly. |

LOC drift since the original 2026-05-11 snapshot is captured for
`analyze-execution.js` (+280 LOC) and `epic-plan-spec.js` (+2 LOC); every
other entry matches byte-for-byte. The drift does not change verdicts.
`analyze-execution.js` grew under post-snapshot work on the Epic mode
roll-up and the `phase-timings.json` correlation — that growth is exactly
the kind of bespoke plumbing the Skills migration is meant to retire.

## Status row — `epic-code-review.js`

Required by Story #1436 acceptance criteria.

| File                                       | LOC | Status | Verdict |
| ------------------------------------------ | --: | ------ | ------- |
| `.agents/scripts/epic-code-review.js`      | 619 | exists | **Out of scope** for Epic #1181 Skills migration. |

Rationale: the script's header doc and call sites
([`.agents/workflows/helpers/epic-code-review.md`](../../.agents/workflows/helpers/epic-code-review.md),
[`.agents/workflows/epic-deliver.md`](../../.agents/workflows/epic-deliver.md))
describe a deterministic pipeline: diff vs `main` → run biome /
markdownlint over changed files → compute per-method maintainability for
changed JS → upsert the `code-review` structured comment on the Epic.
There is no prompt-template plumbing, no system-prompt surface, no
host-LLM authoring step. It composes its summary from parseable lint
output and the maintainability calculator, not from judgment.

The Epic PRD already declined to list it among the seven confirmed
prompt-shaped scripts; this row records the verdict explicitly so future
migrations do not re-open the question. If `/epic-deliver` Phase 4
eventually wants an LLM-authored review summary, that is a separate
follow-on, not part of Epic #1181.

## Mixed candidate — `epic-plan-healthcheck.js`

The Epic README mentions this script as the canonical "mixed
(deterministic + summarisation prompt)" case worth re-verifying. Current
state on `main`:

| File                                       | LOC | Verdict |
| ------------------------------------------ | --: | ------- |
| `.agents/scripts/epic-plan-healthcheck.js` | 346 | **Deterministic — stays a script.** |

Re-verification: the script's modes (`--fast`, `--paranoid`,
`--prime-install`) are all parseable checks (config validation, git remote
ping, ticket-hierarchy + dependency-cycle revalidation, pnpm store
priming). It emits a single line of JSON
(`{ ok, degraded, reason, checks: [...] }`) — no prose, no judgment, no
prompt-template plumbing. Whatever the original "mixed" intuition was, it
no longer applies. The script is a deterministic counter-example in the
same tier as `retrofit-task-bodies.js` below.

## Deterministic counter-example — `retrofit-task-bodies.js`

| File                                       | LOC | Verdict |
| ------------------------------------------ | --: | ------- |
| `.agents/scripts/retrofit-task-bodies.js`  | 285 | **Stays a script.** |

This is the named deterministic counter-example called out in both the
Epic PRD and the README rule. It is a one-shot template renderer: walks
Tasks under an Epic, skips ones already on the v5.33 schema, and emits a
JSON envelope per non-conforming Task for the host LLM to author bodies
into. The script half is pure template rendering + persistence —
parseable in, parseable out, no judgment. The host LLM's authoring step
in the middle could in principle become a Skill in a future Epic, but is
explicitly **out of scope** for Epic #1181 per the PRD's "Out of Scope"
section.

This row is the foil that gives the Skill-vs-Script rule its second
worked example in `.agents/README.md`. Without it, the rule reads as a
one-sided ratchet ("everything LLM-ish becomes a Skill"). With it, the
rule states the actual cohesion test: deterministic + parseable output
stays imperative, even if there is an LLM authoring step adjacent.

## Migration-target summary

Story scope reminder — this ledger is the **input** to A2–A4; nothing in
this document migrates anything on its own. Confirmed migration targets
for downstream Stories under Epic #1181:

- **A2 (planning splits):** `epic-plan-spec.js`, `epic-plan-decompose.js`
  (authoring middle only), `ticket-decomposer.js` (engine), `epic-planner.js`
  (delete).
- **A3 (read-side + standalone Skills):** `analyze-execution.js`,
  `diagnose-friction.js`, `hydrate-context.js`. `analyze-execution.js`
  also depends on Track B1 (`lib/signals/read.js`).
- **A4 (smoke tests + slash-command wiring):** ships the harness, updates
  `/epic-plan`, `/diagnose`, `/story-execute` to dispatch Skills.

Out-of-scope-but-named-for-clarity: `epic-code-review.js`,
`epic-plan-healthcheck.js`, `retrofit-task-bodies.js`. None migrate under
Epic #1181.

## Acceptance trace (Task #1442)

- [x] Ledger lists exactly the seven scripts named in the Epic PRD with
      current LOC and prompt-shaped/deterministic verdict — see
      [Verdict matrix](#verdict-matrix--epic-named-scripts).
- [x] `epic-code-review` status row exists with a verdict (in-scope,
      renamed-to, or out-of-scope) — see
      [Status row — `epic-code-review.js`](#status-row--epic-code-reviewjs).
      Verdict: **exists, out of scope**.
- [x] Ledger references `retrofit-task-bodies` as the deterministic
      counter-example — see
      [Deterministic counter-example — `retrofit-task-bodies.js`](#deterministic-counter-example--retrofit-task-bodiesjs).
