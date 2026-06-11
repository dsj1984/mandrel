---
description: >-
  Shared include for the bounded acceptance self-eval loop run during Story
  delivery (both Epic-attached `epic-deliver-story` and standalone
  `single-story-deliver`). Defines the per-round critic mechanic; each caller
  supplies its own gate-decision wrapper (snapshot vs. label transitions).
---

# Bounded acceptance self-eval loop (shared include)

> **Include module.** Not a slash command. Referenced from
> [`epic-deliver-story.md`](epic-deliver-story.md) and
> [`single-story-deliver.md`](single-story-deliver.md) at their respective
> Step 1a. This file is the **single prose home** for the per-round critic
> mechanic; each caller layers only its own wrapper (snapshot transitions vs.
> standalone label transitions, and whether to pass `--epic`).

After the implementation commits land and **before** the Story proceeds to
close, run an explicit, **independent** eval pass that scores the working diff
against **each** `acceptance[]` item individually. This is the acceptance gate
the close-validation chain does not provide: that chain (lint / test / format /
maintainability / coverage / crap) proves the code is *healthy*, not that it
satisfies *this Story's* acceptance criteria.

The loop is **always on** (a hard cutover — there is no flag to disable it) and
**bounded** by `delivery.acceptanceEval.maxRounds` (default 2), which the
resolver clamps into `[1, hard ceiling]` so the cap can never be switched off or
run unbounded. It is **distinct from** the Epic-level acceptance-spec
reconciliation in `/deliver` Phase 7.1 (which fires once at finalize and
only checks `@ac-*` Gherkin tag presence): this loop is per-Story,
per-criterion, mid-delivery, and evaluates the actual work product.

## Per round

1. **Eval pass (fresh context, independent of the author).** Run a **separate
   critic pass** — a fresh-context sub-agent (`Agent` tool,
   `subagent_type: general-purpose`), *not* a continuation of your implementing
   turn — so the evaluator does not grade its own homework. The critic:
   - Inspects the working diff (`git diff origin/<baseBranch>...HEAD`) and the
     Story's inline `acceptance[]` / `verify[]` arrays.
   - **Runs the `verify[]` commands** and consumes their output as **required
     evidence** when scoring the relevant acceptance items. `verify[]` is not
     optional advisory pre-flight — a criterion cannot be scored `met` without
     the supporting `verify[]` evidence where a `verify[]` command is relevant
     to it.
   - Emits a verdict file under `temp/` conforming to
     [`acceptance-eval-verdict.schema.json`](../../schemas/acceptance-eval-verdict.schema.json):
     one `{ index, criterion, verdict: met|partial|unmet, evidence,
     verifyEvidence[] }` record per acceptance item.
2. **Decide.** Run the gate against the verdict (the caller's Step 1a names the
   exact invocation — standalone omits `--epic`; the Epic-attached path passes
   `--epic <epicId>` so the per-criterion signal lands on the Epic-scoped
   stream):

   ```bash
   node <main-repo>/.agents/scripts/acceptance-eval.js \
     --story <storyId> [--epic <epicId>] --verdict <verdict-path>
   ```

   The gate validates the verdict against the schema, applies the round cap,
   emits the per-criterion `acceptance-eval` signal into the retro / feedback
   substrate, prints a JSON envelope, and exits with one of three decisions:
   - **`decision: "proceed"`** (every criterion `met`) → exit 0. Proceed to
     close.
   - **`decision: "redraft"`** (some `partial`/`unmet`, rounds remaining) →
     exit 0. Redraft the flagged criteria (named in `unmetCriteria[]`), commit
     the fix, and re-run the eval pass for the next round.
   - **`decision: "block"`** (round cap reached, criteria still unmet) → exit
     non-zero. **Do not proceed to close.** Take the caller's blocked path
     (transition to `agent::blocked` / flip the snapshot to `blocked`) and post
     a `friction` comment naming the unmet criteria and their evidence. Never
     silently proceed to close.

Write the verdict files under `temp/` only — they are scratch artifacts.
