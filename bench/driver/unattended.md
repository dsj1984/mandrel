# Unattended headless drive — how the pipeline's HITL gates auto-proceed

> **Scope.** This document satisfies the Story #4216 acceptance item: *document
> the mechanism by which the pipeline HITL stop gates auto-proceed under
> headless drive, or record the blocker when they cannot.* It is the
> make-or-break risk for the whole harness (Epic #4211): a headless
> `claude -p` orchestrator has no human at the keyboard, so if Mandrel's
> `/plan` → `/deliver` pipeline blocks at its first STOP gate, every
> downstream slice stalls.
>
> The answer is **mixed**: `/deliver` has a real, first-class non-interactive
> path; `/plan` does **not** ship an equivalent flag, and that residual gap is
> recorded here as a known blocker with the behavioral mitigation the driver
> applies. This is intentionally honest — the harness measures *Autonomy* as a
> scored dimension, so a gate the driver had to paper over is itself a finding.

The driver in [`run-session.js`](./run-session.js) launches the pipeline via
`claude -p --output-format json` (see `buildArmPrompt` / `buildClaudeArgs`).
Two complementary mechanisms keep the run unattended: **per-command
non-interactive flags** (deterministic, where they exist) and a **prompt-level
auto-proceed directive** (behavioral, covering the rest).

---

## Inventory of HITL STOP gates in the pipeline

Sourced from the live workflow definitions in the materialized bundle
(`.agents/workflows/plan.md`, `.agents/workflows/deliver.md`,
`.agents/workflows/helpers/deliver-epic.md`) as of `mandrel` 1.70.x.

| # | Gate | Where | Native unattended control | Verdict |
| - | ---- | ----- | ------------------------- | ------- |
| 1 | One-pager / scope-triage confirm | `/plan` ideation path (`--idea`) | none | **blocker — mitigated by prompt** |
| 2 | Epic operator review gate | `/plan` Epic path, Phase 7 | risk-routed skip; `--force-review` only *forces* it | **auto-skips when risk routing allows; else blocker** |
| 3 | First-run docs preflight | `/plan` router | "never a hard stop" (declining continues) | **not blocking** |
| 4 | Segment-plan confirmation | `/deliver` router | **`--yes`** suppresses it | **solved (flag)** |
| 5 | Decomposition diff / `maxTickets` budget | `/plan` Epic decomposition | `--allow-over-budget` | **solved (flag)** |
| 6 | Auto-merge-else-operator-merge | `/deliver` Epic Phase 8.5 | `AutomergePredicate` auto-merges a clean run; else operator merges | **auto-proceeds on a clean run** |

---

## Mechanism 1 — native non-interactive flags (deterministic)

These gates have first-class flags the driver passes; no behavioral coaxing
needed.

### `/deliver --yes` (gate #4)

`/deliver` presents a segment plan and *waits for confirmation*; `--yes`
suppresses that gate (`.agents/workflows/deliver.md`: *"present it and wait for
operator confirmation (`--yes` suppresses)"*). The driver passes `--yes` for
the Mandrel arm via `extraArgs` when it wants the deterministic path:

```js
runSession(
  { arm: 'mandrel', scenario, cwd: sandbox.workspacePath,
    extraArgs: ['--yes'] },
  { invokeFn },
);
```

> The driver does **not** hard-code `--yes` inside `buildClaudeArgs` — it is a
> caller-supplied `extraArgs` entry, so a harness run that wants to *measure*
> the confirmation gate (rather than skip it) can omit it.

### `/deliver` Epic auto-merge (gate #6)

The Epic delivery path ends in a **conditional auto-merge gate** (Phase 8.5).
An `AutomergePredicate` evaluates every run signal; when all certify a clean
run it auto-merges via `gh pr merge --squash --delete-branch` and Phase 9
cleanup fires automatically inside the lifecycle bus — **no operator step on
the auto-merge path** (`deliver-epic.md` Phase 8.5/9). When any signal
disqualifies (critical blocker, degraded selector, failed gate), it emits
`epic.merge.blocked` and leaves the PR for the operator. For the benchmark this
is the desired shape: a clean run completes fully unattended, and a run that
*would* need a human is exactly the Autonomy signal we want to record (it shows
up as an un-merged PR + `epic.merge.blocked` in `lifecycle.ndjson`).

### `/plan --allow-over-budget` (gate #5)

A decomposition that exceeds the framework `maxTickets` reviewability budget
otherwise stops; `--allow-over-budget` permits it
(`.agents/workflows/plan.md` flag table). Pass it on the Mandrel arm when the
scenario is expected to decompose wide (the CRUD+DB scenario can).

---

## Mechanism 2 — prompt-level auto-proceed directive (behavioral)

Gates #1 and #2 (and #2 when risk routing forces the review) have **no native
non-interactive flag**. For these the driver relies on a behavioral directive
baked into the Mandrel-arm prompt (`buildArmPrompt` in `run-session.js`):

> *You are operating Mandrel's pipeline non-interactively under a headless
> benchmark driver. There is no human at the keyboard. At every
> human-in-the-loop STOP / confirmation gate (one-pager confirm, spec review,
> decomposition diff gate, and the auto-merge-else-operator-merge step), treat
> the absence of an operator as implicit approval and proceed with the best
> available interpretation — never block waiting for input.*

This works because each gate is executed by the host LLM following the
workflow prose, not by a hard `read()` from a TTY. The framework's own
non-interactive sub-agent contract already establishes this pattern: Story
delivery sub-agents run with *"no input channel mid-run"* and are instructed to
*"pick the narrowest reasonable interpretation"* rather than ask
(`epic-deliver-story.md` → *Non-interactive execution contract*;
`deliver-epic.md` line ~340 → *the non-interactive contract (no clarifying
questions)*). The driver's directive extends that same contract up to the
top-level `/plan` and `/deliver` gates.

### Why this is a directive and not a flag

`/plan` ships **no** `--yes`, `--non-interactive`, `--ci`, or `--headless`
flag (verified against `plan.md`'s flag table — only `--idea`, `--from-notes`,
`--force`, `--force-review`, `--allow-over-budget`, `--steal`, `--dry-run`,
`--body`, `--persona`, `--refine`/`--no-refine` exist). The one-pager confirm
on the ideation path and the Phase 7 review gate when risk-forced therefore
have no deterministic suppression. The prompt directive is the only lever
available without a framework change.

---

## Recorded blocker (residual risk)

The behavioral directive is **best-effort, not guaranteed**. The honest
residual risks, recorded here per the acceptance contract:

1. **No deterministic `/plan` headless flag.** Gate #1 (ideation one-pager) and
   gate #2 (forced Epic review) depend on the host LLM honoring the prompt
   directive. A future workflow revision that turns one of these into a true
   blocking primitive (e.g. an `AskUserQuestion` the harness cannot answer)
   would stall the run with no flag to fall back on. **Mitigation today:**
   prefer driving the Mandrel arm from an **existing Epic id** (`/plan
   <epicId>` / `/deliver <epicId>`) rather than `--idea`, which routes around
   the ideation one-pager entirely; and rely on risk routing to skip the Phase
   7 review for the two low-risk v1 scenarios (`hello-world`, `CRUD+DB`).
2. **Tool-permission prompts are not auto-approved by the prompt.** A blocking
   permission prompt is a harness condition, not a gate the directive covers.
   Because every run executes inside a throwaway sandbox clone
   ([`sandbox.js`](./sandbox.js)), callers that need a broader autorun posture
   should pass `extraArgs: ['--permission-mode', 'bypassPermissions']` (or the
   equivalent the host CLI exposes) explicitly. The driver deliberately leaves
   the default permission surface minimal rather than baking in a dangerous
   default.
3. **A stalled run must be detected, not assumed.** `claude -p` runs under a
   hard `timeoutMs` ceiling (default 1h, `DEFAULT_SESSION_TIMEOUT_MS`). A run
   that blocks on an un-mitigated gate exhausts the timeout and surfaces as a
   non-zero exit / empty envelope — `runSession` throws rather than returning a
   silent zero-cost record. The downstream telemetry slice additionally reads
   `lifecycle.ndjson` heartbeats to distinguish a live-but-slow run from a dead
   one.

### Follow-up framework ask (out of scope for #4216)

The clean fix is a first-class `--yes` / `--non-interactive` flag on `/plan`
that suppresses the ideation one-pager and the Phase 7 review gate the same way
`/deliver --yes` suppresses the segment-plan gate. That is a framework change
(it lives in `.agents/`, the distributed bundle) and is **explicitly out of
scope** for this internal-tooling Story. It should be filed against the
framework with the `meta::framework-gap` label so `/plan` Phase 0 surfaces it
to the planner. Until then, the prompt directive + the existing-Epic routing in
risk #1 keep the harness unattended for v1's two low-risk scenarios.
