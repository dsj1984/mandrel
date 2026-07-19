---
description: Audit performance by measuring first — profile hot paths, I/O, memory, and payload against the repo's own numbers — and audit interleaving/partial-failure correctness (TOCTOU, unawaited promises, non-atomic writes) as a first-class dimension.
---

# Performance & Bottleneck Audit

## Role

Performance Engineer & Systems Architect

## Context & Objective

Find where a system is slow, wasteful, or unsafe under concurrency — and prove
it with numbers, not opinions. This lens has three standing commitments that
separate it from a prose read-through:

1. **Measure before you judge.** A performance claim that is not backed by a
   profile, a timing, or a byte count is a hypothesis, not a finding. Step 0
   times the repo's own suite and entry points and produces the evidence every
   finding must cite.
2. **Adapt to the repo profile.** A CLI/tooling repo has no bundle and no Core
   Web Vitals; a frontend app does. Step 1 detects the target profile and
   activates only the dimensions that apply, declaring the rest inapplicable
   rather than fabricating findings for a surface that does not exist.
3. **Interleaving correctness is a performance concern.** The most expensive
   defects this repo has shipped were not slow loops — they were races
   (check-then-act on a lease, non-atomic checkout mutation under concurrent
   close, shared-cache poisoning). Step 2 treats interleaving & partial-failure
   correctness as a first-class dimension, statically and repo-observably.

## Scope (Story / plan-run mode)

When this lens is invoked from `/deliver` close lenses (or a plan-run audit), the
following block is populated with the Story (or plan-run) change-set file list.
Otherwise — for any manual `/audit-<dimension>` invocation — the block
renders the literal substitution token and you MUST treat it as **no
scope filter — run the lens codebase-wide** exactly as you would have
before this section existed.

```text
{{changedFiles}}
```

- If the block above contains a newline-delimited list of file paths,
  restrict your analysis to those files (and their direct dependencies
  when the lens explicitly calls for cross-file reasoning).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full codebase-wide scan defined in the remaining
  steps.

## Execution strategy (dual-path)

This lens runs along one of two execution paths (orchestrated dynamic-workflow
or sequential single-pass). Both emit the **identical** Step 4 report contract;
downstream consumers (`audit-to-stories`) are agnostic to which path produced
it. See [`helpers/audit-dual-path.md`](helpers/audit-dual-path.md) for strategy
selection, the forcing flags, and the read-only guarantee — read `audit-<lens>`
there as this lens's name.

> **Measurement is non-mutating, not forbidden.** This lens is read-only with
> respect to source, but it MUST be allowed to *run* measurements. The
> orchestrated path grants its measurement agents a `Bash` tool restricted to a
> **non-mutating command allowlist** (profilers, timers, bundle-stat and
> file-size probes — never a command that writes source, installs, or mutates
> git/labels). See the allowlist in
> [`.claude/workflows/audit-performance.workflow.js`](../../.claude/workflows/audit-performance.workflow.js).

## Step 0: Measure before you judge (mandatory)

Produce evidence first; every finding in Step 4 carries an **Evidence** field
that cites a repro command and tags itself `measured` or `estimated`. Run the
measurements that apply to the repo (Step 1 tells you which), preferring the
repo's own scripts over invented ones.

**Timing (all repos).** Time the project's own test suite and any CLI entry
points. Prefer `hyperfine` for stable multi-run statistics; fall back to
`/usr/bin/time -v` (or `time`) when it is absent:

```bash
hyperfine --warmup 1 'npm test'            # suite wall-clock + variance
hyperfine --warmup 1 'node bin/<entry>.js --help'   # CLI cold-start cost
/usr/bin/time -v node bin/<entry>.js <args> 2>&1 | tail -n 20   # fallback + RSS
```

**CPU profile (all repos).** Profile a detected entry script with the V8
sampling profiler and read the hottest self-time frames:

```bash
node --cpu-prof --cpu-prof-dir=temp/audits/cpuprof bin/<entry>.js <args>
```

Then inspect the emitted `.cpuprofile` (the top self-time nodes) for the real
hot path.

**Payload / bundle (web repos only).** Emit build stats and size the shipped
payload; do not estimate what the bundler will tell you exactly:

```bash
npx vite build --profile        # or the repo's own build script
du -sh dist/ && find dist -name '*.js' -exec wc -c {} + | sort -n | tail
```

**Evidence discipline.** A finding tagged `measured` names the command above
whose output produced its number. A finding tagged `estimated` (e.g. a
Big-O argument read off the code without a runnable repro) says so plainly and
is graded no higher than **Medium** unless a measurement upgrades it. Attach
the repro command to the finding so the operator can reproduce it in one paste.

### Step 0b: Perf baseline artifact + diff-aware trend

Write a per-run baseline capturing the Step 0 numbers to
`{{auditOutputDir}}/perf-baseline.json` (suite time, per-entry cold-start, RSS,
bundle bytes where applicable, and the hot-frame list). On every run:

- **Diff against the previous baseline** when one exists. A metric that
  regressed past the previous run's value is an **automatic High** finding with
  the delta (old → new, absolute and %) as its Evidence.
- **Suppress unchanged known findings.** A finding whose measured value is
  within noise of the prior baseline is reported as *unchanged* in a trend
  summary line, not re-litigated as a fresh finding. New or regressed metrics
  are what the run surfaces.
- Record the baseline path and the trend verdict (`first-run` /
  `improved` / `unchanged` / `regressed`) in the Executive Summary.

## Step 1: Repo profile & active dimensions

Detect the target profile from repo-observable markers, then activate only the
dimensions that apply. Declare the inapplicable ones explicitly in the report
(so a reader knows they were considered and ruled out, not forgotten).

Detection signals:

- A **CLI / tooling / library** repo — a `bin` field or executable entry
  scripts, no framework marker, no frontend directory: bundle and Core Web
  Vitals are **inapplicable**.
- A **web / frontend** repo — a framework marker (`react`, `vue`, `svelte`,
  `next`, `vite`, `webpack`) and/or a frontend surface (`src/components/**`,
  `*.html`, `*.css`, a `dist/` build): payload/bundle and CWV **apply**.
- A **service / backend** repo — server entry, route/controller/API surface:
  I/O and interleaving dominate; bundle is **inapplicable**.

The interleaving & partial-failure dimension and the CPU / I/O / memory
dimensions apply to **every** profile. Only payload/bundle (and its re-homed
CWV material) is web-gated.

## Step 2: Analysis dimensions (orthogonal set)

The historically overlapping ten dimensions collapse to four orthogonal
resource dimensions plus one correctness dimension. Audit each *active*
dimension (per Step 1) against measured evidence from Step 0.

- **CPU & algorithmic hot paths:** super-linear complexity on a path that runs
  under load, redundant recomputation, synchronous work blocking the event
  loop. Ground every claim in a `--cpu-prof` hot frame or a timed repro.
- **I/O & syscall efficiency:** N+1 queries/reads, unbatched network or
  filesystem round-trips, missing caching, oversized payloads crossing a
  boundary, chatty `fs` calls in a loop. Cite the call site and a timing.
- **Memory & leaks:** unbounded caches/arrays, retained closures, listeners
  never removed, growth across a repeated operation. Cite RSS from Step 0 or a
  heap delta.
- **Payload & bundle (web only):** heavy or duplicated dependencies, missing
  code-splitting, unoptimized assets, render-blocking resources. Re-homed from
  the retired lighthouse lens: capture a **per-route Core-Web-Vitals score
  baseline** and measure with a **median-of-3** protocol (three runs, report
  the median LCP/CLS/INP/TBT per route) so single-run variance never drives a
  finding. Inapplicable — and omitted — on non-web repos.
- **Interleaving & partial-failure correctness:** the concurrency dimension.
  Statically, repo-observably, look for: unawaited / floating promises;
  `Promise.all` over independently-failing branches where `allSettled` is
  required; **check-then-act (TOCTOU)** on files, locks, labels, or uniqueness
  constraints; non-atomic read-modify-write; in-place writes where
  temp-file-plus-rename is required for crash-atomicity; missing
  transaction/compensation around a multi-step write; non-idempotent retried
  side effects; and shared-cache poisoning (one run writing state a concurrent
  run reads). **Speculative races are the known failure mode of this
  dimension** — a claimed race with no concrete interleaving and no
  repo-observable shared-state path is a false positive; lean hard on the
  self-cross-check to drop it.

## Step 3: Severity rubric (performance-anchored)

Grade every finding on the shared
[`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md),
anchored to performance/correctness cost rather than gut feel:

- Grade **Critical** for a guaranteed data-loss or corruption path under normal
  concurrency (e.g. a lost-update TOCTOU on persisted state), or a hang/outage
  under expected load.
- Grade **High** for a measured regression past the previous baseline (delta is
  the Evidence), or a hot-path cost (frequency × per-call cost) on a path proven
  to run under load, or a race with a concrete losing interleaving.
- Grade **Medium** for a real but bounded cost: an `estimated`-only algorithmic
  concern, a cold-path inefficiency, or a concurrency smell with a plausible but
  unproven interleaving.
- Grade **Low** for minor or opportunistic issues; fix when nearby.

Latency thresholds, when a user-facing route is in scope, follow the CWV bands
in the payload/bundle dimension (LCP ≤2.5s good / ≤4.0s needs-improvement).

## Step 4: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-performance-results.md`, using the exact template
below.

```markdown
# Performance Audit Report

## Executive Summary

[Overview of performance posture vs the Step 0 measurements. State the repo
profile detected (Step 1) and which dimensions were inapplicable. State the
baseline trend verdict (first-run / improved / unchanged / regressed) and the
`perf-baseline.json` path. Close with the self-cross-check `kept k / dropped d`
line.]

## Detailed Findings

[For every bottleneck or correctness defect identified, use the following
strict structure. Lead each title with the primary file it lives in:]

### `path/to/primary-file.ext` — [Short title of the finding]

- **Dimension:** [CPU & algorithmic | I/O | Memory & leaks | Payload & bundle | Interleaving & partial-failure]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Evidence:** [A repro command from Step 0 (or a quoted code path) and a
  `measured` or `estimated` tag — e.g. "`measured`: `hyperfine 'npm test'` →
  regressed 8.1s → 11.4s (+40%) vs perf-baseline.json"]
- **Current State:** [Technical explanation of where and why the bottleneck or
  race occurs]
- **Recommendation & Rationale:** [Specific optimization/fix tactic and the
  expected gain or the interleaving it closes]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. a benchmark below the target threshold, a re-run of this lens showing the baseline no longer regressed, or a test exercising the losing interleaving]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`

## Low-Hanging Fruit

- [List 3 quick changes that provide immediate performance gains.]
```

## Constraint

This is a **read-only** audit **with respect to source**: it does not edit,
create, or delete application code, dependencies, or configuration. It **does**
run non-mutating measurements (Step 0) and writes exactly two artifacts — the
report and `perf-baseline.json`. Note: this lens supersedes the retired
`audit-lighthouse` lens by folding its measured Core-Web-Vitals material (the
per-route score baseline and median-of-3 protocol) into the web branch of the
payload/bundle dimension.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does. The **interleaving**
dimension leans on this pass hardest: drop every claimed race that lacks a
concrete losing interleaving over a repo-observable shared-state path.
