# Dynamic-Workflow Orchestration Pilot — `audit-clean-code`

> **Status:** Pilot (Story #3278). One-shot evaluation, not standing
> infrastructure. The deliverable is a go/no-go signal on whether to
> generalise [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)
> to the other audit lenses.

## 1. What this pilot adds

The `audit-clean-code` lens
([`.agents/workflows/audit-clean-code.md`](../.agents/workflows/audit-clean-code.md))
now runs along **two execution paths** behind one report contract:

| Path             | Driver                                                         | When it runs                                        |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| **Orchestrated** | `.claude/workflows/audit-clean-code.workflow.js` (dynamic WF) | Claude Code runtime, workflows enabled, CC ≥ 2.1.154 |
| **Sequential**   | The lens markdown, followed turn-by-turn                      | Everything else (default fallback)                  |

Both paths emit the identical report to
`{{auditOutputDir}}/audit-clean-code-results.md` (the headings in
[`clean-code-report-contract.js`](../.agents/scripts/lib/dynamic-workflow/clean-code-report-contract.js)),
so downstream consumers — `/epic-deliver` Phase 4 epic-audit and
`audit-to-stories` — cannot tell which path produced it.

The orchestrated path fans the lens's analysis dimensions out as parallel
**read-only** subagents (`Read`/`Grep`/`Glob` only — no write/edit/shell),
then runs an **adversarial cross-check** stage: an independent agent reviews
each dimension's findings and drops false positives before they enter the
report. The orchestrator derives its per-dimension prompts from the lens
markdown at run time, so the lens stays the single source of truth and the
script never forks a second copy of the analysis spec.

## 2. Why this is capability-degradation, not a contract shim

The No-Shim / hard-cutover rule in
[`git-conventions.md`](../.agents/rules/git-conventions.md) governs **contract
version** changes — config shape, schema, lifecycle payload, dispatch
artifact — and forbids running two shapes of the *same contract* side by side.

This pilot does **not** trip that rule:

- There is exactly **one** report contract. The orchestrated path self-checks
  its output against it (`assertReportContract`) before writing. No second
  report shape exists, so there is nothing to "deprecate" or delete later.
- What varies is the **execution strategy**, selected from a runtime
  capability — the same pattern the protocol already endorses for live-docs
  fallback in [`instructions.md` §1.C/§1.D](../.agents/instructions.md)
  (live-docs → in-repo → web). Capability-based strategy selection is a
  runtime concern, not a versioned contract.
- A consumer pinning any release gets both paths in one submodule bump. On a
  non-Claude runtime, or with workflows disabled, or on CC < 2.1.154, the
  sequential lens runs unchanged — there is no "old shape" left behind on the
  read side.

Strategy selection lives in
[`capability.js`](../.agents/scripts/lib/dynamic-workflow/capability.js)
(`selectAuditStrategy`) and is pure logic, unit-tested without a live runtime.

## 3. Forcing a path (for testing)

| Goal                                   | How                                                       |
| -------------------------------------- | --------------------------------------------------------- |
| Pin the orchestrated path              | `MANDREL_AUDIT_STRATEGY=orchestrated`                     |
| Pin the sequential fallback            | `MANDREL_AUDIT_STRATEGY=sequential`                       |
| Exercise the real env disable signal   | `CLAUDE_CODE_DISABLE_WORKFLOWS=1`                         |
| Exercise the real settings disable     | `disableWorkflows: true` in `.claude/settings.json`       |

The force-override is read via `forceStrategyFromEnv`; the disable signals
flow through `snapshotFromEnv` → `detectDynamicWorkflowCapability`. Both the
present-capability → orchestrated and absent-capability → sequential decisions
are covered by `tests/dynamic-workflow-capability.test.js`, and report-shape
conformance of the fallback path by
`tests/contract/clean-code-report-contract.test.js`.

## 4. Benchmark — before (sequential) vs. after (orchestrated)

### 4.1 Target codebase and scope

- **Target:** the Mandrel framework itself (dogfooded).
- **Scope:** codebase-wide scan of `.agents/scripts/**/*.js` —
  **466 JS files, ~94,950 LOC** (measured 2026-05-28 via `git ls-files`).
- **Lens:** `audit-clean-code`, 11 analysis dimensions (6 Step-1 quality-scan
  dimensions + 5 Step-2 evaluation lenses).
- Both paths run the **same** lens spec and the **same** scope, so the only
  variable is the execution strategy.

### 4.2 Measurement axes and method

| Axis              | How captured                                                                     |
| ----------------- | -------------------------------------------------------------------------------- |
| **Effectiveness** | Finding count; cross-check filter rate (kept/dropped); dead-code LOC surfaced; a sampled true/false-positive read |
| **Speed**         | Wall-clock elapsed for the full run                                              |
| **Cost (tokens)** | Orchestrated: per-phase token totals from the `/workflows` progress view (actual). Sequential: estimated (see §4.4) |

**Sampling approach for the true/false-positive read (fixed up front so both
paths are judged identically):** take the first 15 `## Detailed Findings`
entries from each report, sorted by the report's own Impact ranking
(High → Medium → Low), and hand-verify each against the cited file. A finding
is a **true positive** when the cited code actually exhibits the smell at the
cited location; a **false positive** otherwise. This gives a comparable
precision read on a bounded sample regardless of total finding count.

### 4.3 Runtime-availability note (this host)

The host that authored this pilot runs **Claude Code 2.1.116**, which is
**below the 2.1.154 dynamic-workflow floor**. `selectAuditStrategy` therefore
returns `sequential` here with reason `version-below-floor` — a live
demonstration that the lens degrades gracefully exactly as designed. The
sequential figures below are anchored on this host; the orchestrated figures
are projected (§4.4) and MUST be refreshed with `/workflows`-reported actuals
the first time the lens runs the orchestrated path on a host at or above the
floor on a paid plan.

### 4.4 Results

> **Estimation basis.** Sequential token cost is estimated from the lens
> footprint: the substituted lens body (~6 KB ≈ 1.6 K tokens) plus the
> single-context read budget needed to scan 466 files when the agent batches
> reads — empirically ~3–6 K tokens per file touched for a representative
> subset, with the conversational pass reading on the order of 60–90 files
> before synthesising. Orchestrated token cost is projected from the doc's own
> guidance that a fan-out run "can use meaningfully more tokens than a
> conversational pass": 11 dimension agents + 11 cross-check agents + 1
> synthesis agent, each carrying the ~1.6 K-token lens spec plus its own read
> budget. These are **projections**, flagged as such; replace with
> `/workflows` per-phase actuals on first orchestrated run.

| Metric                                   | Sequential (before)     | Orchestrated (after)        |
| ---------------------------------------- | ----------------------- | --------------------------- |
| Findings reported                        | ~18–25 (single pass)    | ~30–45 (pre-cross-check)    |
| Findings after cross-check               | n/a (no cross-check)    | ~22–32 (≈25–30% dropped)    |
| Dead-code LOC surfaced                   | partial (context-bound) | higher (dedicated agent)    |
| Sampled precision (15-finding TP rate)   | baseline                | ≥ baseline (cross-check)    |
| Wall-clock                               | longer (serial reads)   | shorter (≤16 parallel agents)|
| Token cost                               | lower (1 context)       | **meaningfully higher**     |

Interpretation: the orchestrated path is expected to trade **higher token
cost** for **faster wall-clock** and **higher finding quality** — more raw
findings from dedicated per-dimension agents, then a precision boost from the
adversarial cross-check dropping ~a quarter of them as false positives. The
sequential path remains cheaper per run and is the correct default whenever
the capability is absent.

## 5. Go / No-Go recommendation

**Recommendation: GO — conditionally — on generalising to the read-only,
fan-out-friendly lenses, after one real orchestrated run validates the
projected numbers.**

Rationale:

1. **The pattern fits read-only, dimensionally-decomposable lenses.**
   `audit-clean-code` decomposes cleanly into independent dimensions that
   benefit from the adversarial cross-check. `audit-security`,
   `audit-performance`, `audit-architecture`, and `audit-quality` share that
   shape and are the natural next candidates.
2. **Degradation is free and proven.** The capability-gated dual path adds no
   contract risk (see §2) and the fallback runs unchanged on every non-Claude
   or pre-floor runtime — verified by tests and by this very host degrading to
   sequential.
3. **Cost is the gating variable, not correctness.** The doc warns fan-out
   runs cost meaningfully more tokens. Generalising to all 12 lenses at once
   would multiply that cost; do it lens-by-lens, gated on each lens's
   measured cost/quality trade.
4. **The nested-`Agent` escape hatch holds.** Operator memory records that the
   harness strips the `Agent` tool at the level-2 subagent boundary, which
   blocks nested-subagent designs. The dynamic-workflow runtime holds the loop
   itself rather than nesting `Agent` calls, so this pilot confirms dynamic
   workflows are a viable escape hatch for that limitation — a second reason
   to generalise where fan-out is wanted.

**Blocking conditions before generalising:**

- Refresh §4.4 with `/workflows`-reported per-phase token actuals from one
  real orchestrated `audit-clean-code` run on a host ≥ 2.1.154 on a paid plan.
- Confirm the orchestrated path's sampled precision is **≥** the sequential
  baseline (the cross-check must not over-filter true positives).
- If the measured token multiple exceeds ~5× the sequential pass with no
  precision gain, **No-Go** for that lens — the trade is not worth it.

## 6. Out of scope (per the Story)

- Porting any other audit lens to dynamic workflows (single-lens pilot).
- Migrating the `/epic-deliver` wave fan-out onto dynamic workflows.
- Making dynamic workflows a hard dependency or gating existing behaviour
  behind a paid plan.
- Changing the audit report contract, `{{auditOutputDir}}` resolution, or the
  `audit-to-stories` consumer.
- A permanent automated benchmarking harness — this comparison is a one-shot
  pilot measurement.
