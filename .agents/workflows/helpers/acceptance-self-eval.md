---
description: >-
  Shared include for the bounded acceptance self-eval loop run during Story
  delivery (`helpers/deliver-story`). Defines the per-round critic mechanic;
  the caller supplies its gate-decision wrapper (label transitions).
---

# Bounded acceptance self-eval loop (shared include)

> **Include module.** Not a slash command. Referenced from
> [`deliver-story.md`](deliver-story.md) at Step 1a. This file is the
> **single prose home** for the per-round critic mechanic; the caller layers
> only its wrapper (Story label transitions).

After the implementation commits land and **before** the Story proceeds to
close, run an explicit, **independent** eval pass that scores the change set
computed once for this Story and injected into the critic — never one the
critic re-derives (Story #4593) — against **each** `acceptance[]` item
individually. This is the acceptance gate
the close-validation chain does not provide: that chain (lint / test / format /
maintainability / coverage / crap) proves the code is *healthy*, not that it
satisfies *this Story's* acceptance criteria.

The loop is **always on** (a hard cutover — there is no flag to disable it) and
**bounded** by `delivery.acceptanceEval.maxRounds` (default 2), which the
resolver clamps into `[1, hard ceiling]` so the cap can never be switched off or
run unbounded. It is **distinct from** the per-run `sibling-coherence` epilogue
step (`planRunEpilogue` for N>1): this loop is per-Story, per-criterion,
mid-delivery, and evaluates the actual work product.

## Per round

1. **Eval pass (fresh context, independent of the author).** Run a **separate
   critic pass** — a fresh-context sub-agent (`Agent` tool), *not* a
   continuation of your implementing turn — so the evaluator does not grade its
   own homework.

   > **Sub-agent type + derived-level ceremony (Epic #4478, M7-B).** When
   > `delivery.routing.roleScopedAgents` is enabled (the **default**), dispatch
   > the critic with `subagent_type: acceptance-critic` — it boots on the
   > role-scoped [`acceptance-critic`](../../agents/acceptance-critic.md) context
   > (its own system prompt, no `CLAUDE.md` @-closure) that carries the
   > maker-blind invariant and the verdict schema standalone. When the
   > kill-switch is **off** (`roleScopedAgents: false`), fall back to
   > `subagent_type: general-purpose`.
   >
   > **Whether to spawn fresh at all is routed off the derived change level**
   > — the same signal `review-depth.js` resolves depth from, so the two
   > decisions cannot disagree. Derive it with `deriveChangeLevel` from
   > [`review-depth.js`](../../scripts/lib/orchestration/review-depth.js) over
   > the **change set your caller computed once** for this Story (Story #4593 —
   > `computeChangeSet` from
   > [`change-set.js`](../../scripts/lib/orchestration/change-set.js); see
   > [`deliver-story.md`](deliver-story.md) Step 2), then
   > resolve the ceremony per cluster with `resolveCeremonyForRisk` from
   > [`ceremony-routing.js`](../../scripts/lib/orchestration/ceremony-routing.js)
   > using that `derivedLevel` and `delivery.routing.freshCriticSampleRate`:
   > **`high` (the diff touches a sensitive path registered in
   > `audit-rules.json`) → `fresh`** (spawn the critic); **`low` (it touches
   > none) → `inline`** (the contract-identical inline fallback below),
   > **except** the `freshCriticSampleRate` fraction of low-level clusters the
   > sampling floor forces `fresh` so a low level never means zero independent
   > checking; **`null` / unknown (the diff could not be enumerated) → `fresh` +
   > full ceremony** (fail-safe). This chooses fresh-vs-inline **per cluster
   > only — it never changes the cluster count**.
   >
   > Story #4542 re-based this off the planner-authored risk verdict: a level
   > the plan asserted about itself was exactly the signal that could *reduce*
   > independent checking, and nothing verified it against the diff.
   >
   > **Inline-critic path (low-level-routed OR nesting-absent harness).** The
   > verdict is authored **inline** whenever the risk router above resolves to
   > `inline` (a low-risk cluster not caught by the sampling floor), and also as
   > a **fallback** on any harness that cannot spawn the fresh critic.
   > Dispatching the critic as a nested `Agent` is the fresh-context shape and
   > works on any harness that carries `Agent` into sub-agents (Claude Code ≥
   > 2.1.202; see [#2870](https://github.com/dsj1984/mandrel/issues/2870)). This
   > eval loop itself runs inside a Story delivery sub-agent, so the nested
   > critic sits at nesting depth 2. If the host does **not** support nested
   > `Agent` dispatch at that depth — the tool is absent, or a spawn attempt
   > returns an unsupported-capability error — do **not** stall the Story
   > regardless of the risk verdict. Author the verdict **inline**: in a
   > deliberately scoped,
   > self-critical pass (re-read only the diff, the `acceptance[]` /
   > `verify[]` arrays, and the `verify[]` command output — treat the
   > implementation reasoning as untrusted and score against the criteria
   > afresh), write the same verdict file described below and hand it to the
   > same `acceptance-eval.js` gate. The fresh-context isolation is weaker in
   > the inline path, but the gate, the schema, the round cap, and the
   > proceed / redraft / block decision are identical — a Story is **never**
   > stranded on a nesting-absent harness. Note in the blocked/friction
   > comment (if you block) that the inline fallback was used.

   The critic:
   - Inspects the **change set handed to it in its spawn context** — the one
     list computed above — and the Story's inline `acceptance[]` / `verify[]`
     arrays. Pass the file list explicitly when you dispatch the critic; it
     does not re-enumerate the diff for itself (Story #4593), so a commit
     landing mid-ceremony cannot leave the critic scoring a different change
     than the one that routed it.
   - **Runs the `verify[]` commands** and consumes their output as **required
     evidence** when scoring the relevant acceptance items. `verify[]` is not
     optional advisory pre-flight — a criterion cannot be scored `met` without
     the supporting `verify[]` evidence where a `verify[]` command is relevant
     to it.
   - **Shares `lint` / `typecheck` evidence with close (Story #4250).** When a
     `verify[]` command is **byte-identical** to a close-validation gate — in
     practice only the cheap, command-identical `lint` and `typecheck` gates
     (`npm run lint` and the resolved `project.commands.typecheck`) — the
     critic MUST run it through `evidence-gate.js` so a passing run records an
     evidence entry in the **same keyspace** `close-validation/runner.js`
     consults. Run it in the **same Story worktree** the close validates (the
     HEAD-sha key enforces "unchanged HEAD") and pass the exact gate name:

     ```bash
     node <main-repo>/.agents/scripts/evidence-gate.js \
       --standalone --scope-id <storyId> --gate lint \
       --worktree <worktree> -- npm run lint
     ```

     Close's `shouldSkip` then short-circuits that gate when HEAD is
     unchanged; a redraft round (HEAD moves) correctly busts it. **Never**
     run the coverage / CRAP suite through `evidence-gate.js` to stamp it
     fresh — a false-fresh coverage record without `coverage-final.json`
     silently weakens the floor. Limit the evidence-share to `lint` and
     `typecheck`.
   - Emits a verdict file under `temp/` conforming to
     [`acceptance-eval-verdict.schema.json`](../../schemas/acceptance-eval-verdict.schema.json):
     one `{ index, criterion, verdict: met|partial|unmet, evidence,
     verifyEvidence[] }` record per acceptance item.
2. **Decide.** Run the gate against the verdict (the caller's Step 1a names the
   exact invocation — omit `--epic`):

   ```bash
   node <main-repo>/.agents/scripts/acceptance-eval.js \
     --story <storyId> --verdict <verdict-path>
   ```

   The gate validates the verdict against the schema, applies the round cap,
   emits the per-criterion `acceptance-eval` signal into the retro / feedback
   substrate, prints a JSON envelope, and exits with one of three decisions:
   - **`decision: "proceed"`** (every criterion `met`) → exit 0. Proceed to
     close.
   - **`decision: "redraft"`** (some `partial`/`unmet`, rounds remaining) →
     exit 0. Redraft the flagged criteria (named in `unmetCriteria[]`), commit
     the fix, and start another round.
   - **`decision: "block"`** (round cap reached, criteria still unmet) → exit
     non-zero. **Do not proceed to close.** Take the caller's blocked path
     (transition to `agent::blocked`) and post a `friction` comment naming the
     unmet criteria and their evidence. Never silently proceed to close.

Write the verdict files under `temp/` only — they are scratch artifacts.
