---
description: >-
  Shared include for the bounded acceptance self-eval loop run during Story
  delivery (`helpers/deliver-story`). Defines the per-round verdict mechanic;
  the caller supplies its gate-decision wrapper (label transitions).
---

# Bounded acceptance self-eval loop (shared include)

> **Include module.** Not a slash command. Referenced from
> [`deliver-story.md`](deliver-story.md) at Step 1a. This file is the
> **single prose home** for the per-round verdict mechanic; the caller layers
> only its wrapper (Story label transitions).

After the implementation commits land and **before** the Story proceeds to
close, run an explicit eval pass that scores the change set computed once for
this Story — never one the evaluator re-derives — against **each**
`acceptance[]` item individually. This is the acceptance gate the
close-validation chain does not provide: that chain (lint / test / format /
maintainability / coverage / crap) proves the code is *healthy*, not that it
satisfies *this Story's* acceptance criteria.

The loop is **always on** (a hard cutover — there is no flag to disable it) and
**bounded** by `delivery.acceptanceEval.maxRounds` (default 2; `0` means the
verdict is scored once with no redraft round). It is **distinct from** the
per-run epilogue (`planRunEpilogue` for N>1): this loop is per-Story,
per-criterion, mid-delivery, and evaluates the actual work product.

## Per round

1. **Eval pass — one verdict owner, one verdict file.** Exactly **one** pass
   authors the Story's verdict, and it covers **every** `acceptance[]` item in
   one file. Which pass is named by the ceremony decision
   (`verdictOwner: 'fresh-critic' | 'inline-self-eval'` from
   `resolveCeremonyForRisk`), which follows the **ceremony profile
   alone**:

   > ```bash
   > node <main-repo>/.agents/scripts/ceremony-derive.js --story <storyId> --cwd <workCwd>
   > ```
   >
   > One call computes the change set once (`files`), derives the level and
   > classes **for review depth**, and resolves the owner (`mode`, `reason`,
   > `verdictOwner`): **`minimal` / `standard` → `inline`** (the default — you
   > author the verdict yourself), **`strict` → `fresh`** (dispatch the
   > maker-blind critic). The derived level feeds `review-depth.js`, not
   > this decision; review depth resolves `deep` for any sensitive path.

   **Never run both**, and never run a preliminary self-assessment before
   dispatching a fresh critic — the redundant pre-pass buys no measurable
   quality and roughly triples the acceptance-block cost. Step 3's gate is the
   deterministic **scorer** of that one verdict, not a second pass over the
   criteria.

   > **Inline owner (the default).** Author the verdict in a deliberately
   > scoped, self-critical pass: re-read only the diff, the `acceptance[]` /
   > `verify[]` arrays, and the `verify[]` command output — treat your own
   > implementation reasoning as untrusted and score each criterion afresh
   > from the evidence. Write one verdict file covering every item and hand it
   > to the gate. This is also the **fallback** on any harness that cannot
   > spawn the fresh critic, so a Story is never stranded: the gate, the
   > schema, the round cap and the proceed / redraft / block decision are
   > identical either way. Note in the friction comment (if you block) when
   > the fallback was used in place of a `strict` critic.
   >
   > **Fresh critic (`strict` only).** Dispatch a sub-agent via the `Agent`
   > tool — *not* a continuation of your implementing turn. When
   > `delivery.routing.roleScopedAgents` is enabled (the **default**), use
   > `subagent_type: acceptance-critic`: it boots on the role-scoped
   > [`acceptance-critic`](../../agents/acceptance-critic.md) context (its own
   > system prompt, no entry-doc @-closure) carrying the maker-blind
   > invariant and the verdict schema standalone. With the kill-switch off
   > (`roleScopedAgents: false`), fall back to
   > `subagent_type: general-purpose`. Under sub-agent dispatch this loop
   > runs inside a `story-worker`, so the critic sits at nesting depth 2
   > (depth 1 inline) — supported by any harness that carries `Agent` into
   > sub-agents (Claude Code ≥ 2.1.202).

   Whichever pass owns it, the verdict:
   + Inspects the **change set it was handed** — the one `files` list above —
     and the Story's inline `acceptance[]` / `verify[]` arrays. Pass the file
     list explicitly when dispatching a fresh critic; it does not re-enumerate
     the diff for itself, so a commit landing mid-ceremony cannot leave it
     scoring a different change than the one that routed it.
   + **Runs the `verify[]` commands** and consumes their output as **required
     evidence**. `verify[]` is not optional advisory pre-flight — a criterion
     cannot be scored `met` without the supporting `verify[]` evidence where a
     `verify[]` command is relevant to it.
   + **Reuses the credited full-suite run instead of re-paying for it.**
     Before spawning a `verify[]` entry, classify it with `resolveVerifyCredit`
     from
     [`verify-credit.js`](../../scripts/lib/orchestration/verify-credit.js): an
     entry that is itself a full-suite command is consulted against the same
     stamp close reads and, when that stamp is fresh, recorded as `pass`
     without being respawned; a stale or absent stamp reports `spawn: true` and
     the command runs for real. The credited run itself is stated once, in
     [`deliver-digest.md`](deliver-digest.md) § 5.
   + Emits **one** verdict file under `temp/` conforming to
     [`acceptance-eval-verdict.schema.json`](../../schemas/acceptance-eval-verdict.schema.json):
     one `{ index, criterion, verdict: met|partial|unmet, evidence,
     verifyEvidence[] }` record per `acceptance[]` item, in acceptance-array
     order, under a single top-level `storyId`, `schemaVersion`, `round` and
     `commitSha`. A fresh critic **returns that path to you** rather than
     calling the gate itself.
2. **Decide — exactly one gate call per round.** Run the gate against that one
   verdict file (the caller's Step 1a names the exact invocation — omit
   `--epic`). The gate **scores the verdict the round produced** — schema
   validation, round cap, decision — and never re-scores the criteria itself:

   ```bash
   node <main-repo>/.agents/scripts/acceptance-eval.js \
     --story <storyId> --verdict <verdict-path>
   ```

   The gate reads the Story's `acceptance[]` count itself (Story #5313): a
   verdict whose `criteria[]` length differs — one covering only part of the
   Story — is rejected **before scoring**, with an error naming the count and
   consuming **no round**. `--expected-criteria` is still accepted but
   redundant; when passed it must agree with that count.

   > **Why one call per round and not several.** The round counter is
   > **Story-scoped** — derived by counting `acceptance-eval` signals in the
   > Story's `signals.ndjson` — so a second call in the same round spends one
   > of the (default 2) rounds for nothing, and concurrent calls race that
   > ledger.

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

Write the verdict under `temp/` only — it is a scratch artifact.
