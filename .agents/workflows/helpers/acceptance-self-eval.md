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
critic re-derives — against **each** `acceptance[]` item
individually. This is the acceptance gate
the close-validation chain does not provide: that chain (lint / test / format /
maintainability / coverage / crap) proves the code is *healthy*, not that it
satisfies *this Story's* acceptance criteria.

The loop is **always on** (a hard cutover — there is no flag to disable it) and
**bounded** by `delivery.acceptanceEval.maxRounds` (default 2; `0` means the
verdict is scored once with no redraft round). It is **distinct from** the
per-run `sibling-coherence` epilogue
step (`planRunEpilogue` for N>1): this loop is per-Story, per-criterion,
mid-delivery, and evaluates the actual work product.

## Per round

1. **Eval pass — one verdict-owner per cluster.** Exactly
   **one** pass authors each cluster's verdict: the **fresh-context critic**
   when the ceremony routing below resolves `fresh` (a sub-agent via the
   `Agent` tool, *not* a continuation of your implementing turn — the
   evaluator does not grade its own homework), or the **inline self-eval**
   when it resolves `inline`. The resolved decision names the owner
   explicitly (`verdictOwner: 'fresh-critic' | 'inline-self-eval'` from
   `resolveCeremonyForRisk`). **Never run both**, and never run a
   preliminary self-assessment pass before dispatching the fresh critic —
   the redundant pre-pass buys no measurable quality and roughly triples
   the acceptance-block cost. Step 3's gate is the deterministic **scorer**
   of the one merged verdict, not a second (or third) pass over the
   criteria.

   > **Sub-agent type + derived-level ceremony.** When
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
   > decisions cannot disagree. Derive it with one script over the Story
   > branch (Story #5313) — never a hand-carried import block:
   >
   > ```bash
   > node <main-repo>/.agents/scripts/ceremony-derive.js --story <storyId> --cwd <workCwd>
   > ```
   >
   > It computes the change set once (`files`), derives the level and
   > classes, and resolves the ceremony per cluster (`mode`, `reason`,
   > `verdictOwner`): **`high` (the diff touches a sensitive path registered
   > in `audit-rules.json`) → `fresh`** (spawn the critic); **`low` (it
   > touches none) → `inline`** (the contract-identical inline fallback
   > below); **`null` / unknown (the diff could not be enumerated) → `fresh`
   > + full ceremony** (fail-safe). This chooses fresh-vs-inline **per
   > cluster only — it never changes the cluster count**.
   >
   > The routing signal is deliberately **not** a planner-authored risk
   > verdict: a level the plan asserted about itself was exactly the signal
   > that could *reduce* independent checking, and nothing verified it
   > against the diff.
   >
   > **Inline-critic path (low-level-routed OR nesting-absent harness).** The
   > verdict is authored **inline** whenever the risk router above resolves to
   > `inline` (a low-risk cluster), and also as
   > a **fallback** on any harness that cannot spawn the fresh critic.
   > Dispatching the critic as a nested `Agent` is the fresh-context shape and
   > works on any harness that carries `Agent` into sub-agents (Claude Code ≥
   > 2.1.202). This eval loop itself runs inside a Story delivery
   > sub-agent, so the nested
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
   + Inspects the **change set handed to it in its spawn context** — the one
     list computed above — and the Story's inline `acceptance[]` / `verify[]`
     arrays. Pass the file list explicitly when you dispatch the critic; it
     does not re-enumerate the diff for itself, so a commit
     landing mid-ceremony cannot leave the critic scoring a different change
     than the one that routed it.
   + **Runs the `verify[]` commands** and consumes their output as **required
     evidence** when scoring the relevant acceptance items. `verify[]` is not
     optional advisory pre-flight — a criterion cannot be scored `met` without
     the supporting `verify[]` evidence where a `verify[]` command is relevant
     to it.
   + **Reuses the credited full-suite run instead of re-paying for it.**
     Before spawning a `verify[]` entry, classify it with `resolveVerifyCredit`
     from
     [`verify-credit.js`](../../scripts/lib/orchestration/verify-credit.js): an
     entry that is itself a full-suite command (`npm test`, `pnpm run test`,
     a bare `node --test`) is consulted against the **same stamp close reads**
     and, when that stamp is fresh, recorded as `pass` with a `detail` naming
     the credit — **never respawned**. A stale or absent stamp reports
     `spawn: true` and the command runs for real, so the credit can never
     manufacture a pass. The gate warns on any such entry: the intended shape
     is scoped `verify[]` entries **plus** the one credited run
     ([`deliver-digest.md`](deliver-digest.md) § 5).
   + **Shares `lint` / `typecheck` evidence with close.** When a
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
   + Emits a **cluster** verdict file under `temp/` conforming to
     [`acceptance-eval-verdict.schema.json`](../../schemas/acceptance-eval-verdict.schema.json):
     one `{ index, criterion, verdict: met|partial|unmet, evidence,
     verifyEvidence[] }` record per acceptance item **in that cluster**, each
     `index` being the item's position in the Story's full `acceptance[]`
     array. A fresh critic **returns that path to you** rather than calling the
     gate itself.
2. **Dispatch the round's clusters in parallel, then merge into one verdict
   (fresh critics only).** When the verdict owner is the **inline self-eval**,
   author **one** verdict file covering every `acceptance[]` item and score it
   in one gate call — the cluster merge below does not apply (Story #5313).
   For fresh critics, the clusters of a round are independent, so dispatch
   **all** of the round's critics as N `Agent` calls **in a single assistant
   turn** — [`parallel-tooling.md`](parallel-tooling.md) **Rule 3** — never
   serially, and never one round per cluster.

   Then **merge** the cluster verdicts into **one** verdict file under `temp/`:
   concatenate every cluster's `criteria[]` records and order the merged array
   by `index`, so it holds exactly one record per `acceptance[]` item in
   **acceptance-array order**, under a single top-level `storyId`,
   `schemaVersion`, `round` and `commitSha`. The verdict schema deliberately
   carries **no `clusterId`** — the round's artifact is the merged verdict, and
   which critic scored which record is not part of the contract.

   > **Why one gate call and not N.** The round counter is **Story-scoped** —
   > derived by counting `acceptance-eval` signals in the Story's
   > `signals.ndjson` — and each cluster verdict has a distinct fingerprint, so
   > the replay guard never collapses them. A gate call per cluster would spend
   > one of the (default 2) rounds *per cluster*, so a Story with more than 8
   > acceptance criteria would exhaust its redraft budget on cluster arithmetic
   > alone; N concurrent calls would also race that same ledger. Cluster-scoped
   > round counting exists in
   > [`acceptance-eval-decision.js`](../../scripts/lib/orchestration/acceptance-eval-decision.js)
   > but requires an integer `epicId`, which v2 pins `null` — it is not a way
   > around the merge.
3. **Decide — exactly one gate call per round.** Run the gate against the
   **merged** verdict (the caller's Step 1a names the exact invocation — omit
   `--epic`). The gate **scores the single verdict the round produced** —
   schema validation, round cap, decision — and never re-scores the criteria
   itself:

   ```bash
   node <main-repo>/.agents/scripts/acceptance-eval.js \
     --story <storyId> --verdict <verdict-path>
   ```

   The gate reads the Story's `acceptance[]` count itself (Story #5313): a
   verdict whose `criteria[]` length differs — a single cluster's verdict
   handed over unmerged — is rejected **before scoring**, with an error naming
   the merge contract and consuming **no round**. `--expected-criteria` is
   still accepted but redundant; when passed it must agree with that count.

   The gate validates the verdict against the schema, applies the round cap,
   emits the per-criterion `acceptance-eval` signal into the retro / feedback
   substrate, prints a JSON envelope, and exits with one of three decisions:
   + **`decision: "proceed"`** (every criterion `met`) → exit 0. Proceed to
     close.
   + **`decision: "redraft"`** (some `partial`/`unmet`, rounds remaining) →
     exit 0. Redraft the flagged criteria (named in `unmetCriteria[]`), commit
     the fix, and start another round.
   + **`decision: "block"`** (round cap reached, criteria still unmet) → exit
     non-zero. **Do not proceed to close.** Take the caller's blocked path
     (transition to `agent::blocked`) and post a `friction` comment naming the
     unmet criteria and their evidence. Never silently proceed to close.

Write both the per-cluster verdicts and the merged verdict under `temp/` only —
they are scratch artifacts.
