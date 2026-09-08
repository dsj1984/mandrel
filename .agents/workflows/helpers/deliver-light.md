---
description:
  The unplanned prompt path shared by /mandrel-deliver and /mandrel-plan Gate #1. Judges a
  prompt's predicted footprint, authors a receipt Story, then lands it through
  the same single-story-init / single-story-close engine — every close gate
  unchanged.
---

# Unplanned delivery (the prompt path)

> **A path, not a command.** There is no `/deliver-light` to type. This file is
> reached two ways — `/mandrel-deliver "<prompt>"` (an operator describing small work)
> and `/mandrel-plan` Gate #1 (a seed the suggestion says fits the light ceilings, once
> the operator confirms). Read
> [`deliver-digest.md`](deliver-digest.md) once first — the engine invariants,
> gates, and terminal-envelope contract below are its.

## Role

For a genuinely trivial change — a one-file fix, a small addition, a small
amendment — the multi-session plan→deliver ceremony buys nothing the bare model
lacks except **gates and landing**. This path keeps exactly those: one session
straight to execution from a prompt, landing through the unchanged close path.
It never relaxes a close gate, never bypasses the PR to `main`, and never lands
over-scope work silently.

Two callers, one gate: whichever door you arrived through, the suitability gate
below is the decision. A `/mandrel-plan` Gate #1 suggestion is a *suggestion* — it is
read against seed-time signals (`DELIVER_LIGHT_SUGGESTION_CEILINGS`: artifacts,
risk hits, sensitive-path classes), while the gate here is read against the
predicted work's *effort and risk* (`STORY_SHAPE_CEILINGS`: change kinds,
magnitude, uncertainty, deployable span). They are deliberately two different
checks, so the gate still runs after a confirm.

## Scope by effort, not by artifact count {#scope-by-effort}

**Counting the footprint is the wrong axis.** Three identical one-line edits
across three files is trivial work with a high count; a 200-line rewrite of one
module is a single change. The axes are therefore effort and risk: distinct
change **kinds** (N instances of one mechanical edit is one kind at N sites), a
coarse **magnitude** bucket, and **uncertainty** — is the shape determined by
the request, or does it still need the design decisions `/mandrel-plan` exists to
resolve?

Because the predicted footprint is a *declaration* — a guess, and a gameable one
— this gate is deliberately **coarse**: it rejects clearly-epic work only
(multiple deployables, a migration plus its consumers, an explicit
multi-capability enumeration). Size is enforced where ground truth is available:
the diff backstop in step 4. Do not talk yourself past that one.

**The backstop counts by the same principle.** It reads magnitude — changed
lines over implementation files — not artifacts, and exempts the test and doc
companions the framework itself mandates. A ceiling that punishes a repo for
obeying its own test-first rule is a ceiling that over-fires.

Sensitivity is the exception and stays absolute: a footprint touching an auth,
crypto, billing, or migration class routes `full` however small or mechanical —
and unlike a ceiling, it is **not overridable** (§ Recording a proceed-light
answer).

## Four invariants (do not skip one)

1. **Suitability gate.** The prompt's predicted footprint is judged by the
   shared effort/risk machinery (`deriveStoryShape` / `deriveChangeLevel`)
   **and** a ledgered model verdict with a recorded reason. Both must agree on
   `lite`.
2. **Over-scope stops — it never hard-fails.** An over-ceiling prompt STOPS and
   asks the operator to escalate to `/mandrel-plan` or proceed light. **Both answers
   are executable** — `--operator-proceed-light` records the second one
   (§ Recording a proceed-light answer). Under `--yes` it fails closed to an
   **`escalated` terminal envelope** that ends the session (§ Escalation is
   terminal).
3. **Diff-derived backstop.** After implementation the ACTUAL change set is
   re-checked — the diff is the real scope signal — and an over-ceiling diff is
   blocked rather than landed.
4. **Minimal receipt Story.** A `type::story` is authored inline so `refs #`,
   history, telemetry, and the `agent::executing → agent::done` state machine
   all survive.

## Procedure

1. **Predict + gate.** Form the predicted footprint (new files, edited files,
   acceptance count), judge its effort honestly (`--kinds` / `--magnitude` /
   `--uncertainty`, per § Scope by effort), and record your ledgered verdict (a
   recorded reason for `lite`), then run the gate — it documents every flag
   itself, so run it with `--help` rather than guessing:

   ```bash
   node .agents/scripts/deliver-light.js --prompt "<prompt>" \
     --creates <csv> --refactors <csv> --acceptance <n> \
     --kinds <csv> --magnitude trivial|moderate|substantial \
     --uncertainty determined|needs-design \
     --route lite --reason "<why this is trivial>" [--amends '#<id>'] [--yes]
   ```

   Branch on `action` in the JSON envelope:
   - **`proceed-light`** — the receipt Story is authored; read `storyId` and
     `nextCommands`. Continue to step 2.
   - **`ask-operator`** — predicted scope exceeds the light ceilings. STOP and
     ask the operator to escalate to `/mandrel-plan` or proceed light. Do not proceed
     on your own. This is a **question, not a terminal** — wait for the answer,
     then act on it: *escalate* leaves for `/mandrel-plan`, *proceed light* re-runs the
     same command with `--operator-proceed-light "<their reason>"`
     (§ Recording a proceed-light answer).
   - **over-scope under `--yes`** — no `action` to branch on: the gate emits an
     **`escalated` terminal envelope** instead (exit 2). § Escalation is
     terminal governs; you are finished.

   `--amends '#<id>'` is the canonical light case — shape-checked identically; a
   heavy amendment escalates to `/mandrel-plan` like any other over-scope prompt.

   **Entered from `/mandrel-plan` Gate #1?** Fill `--creates` / `--refactors` /
   `--acceptance` / `--reason` from the plan-context envelope's codebase
   snapshot and `complexitySignals` rather than re-deriving them from the seed
   text — Gate #1 has already done that work, and re-deriving throws away the
   better signal. An `ask-operator` verdict here means the two ceiling sets
   disagreed: **return to [`../mandrel-plan.md`](../mandrel-plan.md) step 2 (Author) in the same
   session**, carrying the interrogation you already paid for. That bounce-back
   is not an escalation and does not need a fresh session (§ Why the two
   directions differ).

2. **Init (same engine).** From the main checkout, synchronously, with the
   maximum Bash timeout:

   ```bash
   node .agents/scripts/single-story-init.js --story <storyId>
   ```

   Capture `workCwd`; `remoteVerified: false` → flip `agent::blocked` and stop.
   This is [`/mandrel-deliver`](../mandrel-deliver.md)'s worktree/branch/lease/label engine,
   invoked, not reimplemented.

3. **Implement + self-eval.** `cd` into `workCwd`, implement the change, run
   the full suite once in the worktree **so close can credit it** — the
   crediting invocation and the freshness contract are
   [`deliver-story.md`](deliver-story.md) Step 1.3, unchanged here — then run
   the bounded acceptance self-eval loop
   ([`deliver-story.md`](deliver-story.md) Step 1a). Commit
   on `story-<id>` with `(refs #<storyId>)`.

4. **Diff backstop.** Before close, re-check the ACTUAL diff:

   ```bash
   node .agents/scripts/deliver-light.js --backstop --story <storyId>
   ```

   This is the pass that actually bounds size, which is why the prediction gate
   above can afford to be coarse. It measures **magnitude on the change's
   implementation half** — changed lines (additions + deletions) plus a file
   sprawl tripwire — never raw artifact count. Tests, `docs/**`, `**/*.md`,
   `baselines/**`, and lockfiles are exempt from the counts, because the
   framework mandates those companions and obeying it must not inflate the
   number that then rejects the change. They are **not** exempt from
   sensitive-path matching, which runs over the full change set.

   **Commit before you run it.** The backstop measures **committed** state, so
   a run that implemented but has not committed measures an empty diff and is
   refused for a scope it never had. That refusal names the real fix — commit
   on `story-<id>`, then re-run the backstop — and its `nextCommand` is that
   re-run, not an escalation.

   Exit `3` (`blocked: true`) otherwise means the diff exceeds a light ceiling or
   touches a sensitive-path class. STOP, flip `agent::blocked`, and **recycle the
   receipt** through the envelope's `nextCommand` (`/mandrel-plan <storyId>`) —
   tickets mode rewrites it into properly-planned Stories and closes it as
   superseded. Do not land, and do not leave the receipt open with no successor:
   it already carries the branch, the worktree, and the implementation, all of
   which are evidence the plan should read.

5. **Close and land (same engine).** Exactly [`/mandrel-deliver`](../mandrel-deliver.md)'s close:

   ```bash
   node .agents/scripts/single-story-close.js --story <storyId> --cwd <main-repo>
   ```

   Branch on the terminal envelope's `status` per
   [`deliver-digest.md`](deliver-digest.md) § 5 — every close
   gate runs byte-identical to the full path.

## Recording a proceed-light answer {#recording-a-proceed-light-answer}

The gate offers the operator two options, so **both** have to be executable.
Re-run the identical gate command with their answer appended:

```bash
node .agents/scripts/deliver-light.js --prompt "<prompt>" … \
  --operator-proceed-light "<the operator's reason, in their words>"
```

The gate then proceeds light, records the decision in the receipt Story, and
returns it on the envelope's `override`. Do **not** instead re-shape the
prediction — shrinking `--refactors` until the gate stops objecting is
under-declaring the footprint, which is the one thing the coarse design must
not reward.

It is deliberately narrow, and a refusal is printed rather than silent:

- **Only a size prediction is waivable** — change kinds, magnitude,
  uncertainty, deployable span. A sensitive-path class, a
  migration-with-consumers span, and an unknown footprint (undeclared, glob,
  no acceptance, unclassifiable) are refused: those are risk, not size, and
  § Scope by effort keeps them absolute.
- **The ledgered verdict still stands on its own.** The override substitutes
  for the predicted *shape* only; `--route lite --reason "<why>"` is still
  required.
- **Attended-only.** With `--yes` it is a usage error, not a quiet no-op —
  an unattended run has no operator whose answer this could be, and over-scope
  there still fails closed (§ Escalation is terminal).

What licenses this at all is step 4: the operator waives a *guess*, never the
diff backstop, which re-checks the actual change set against ground truth.

## Escalation is terminal {#escalation-is-terminal}

Over-scope under `--yes` emits a schema-validated `story-deliver-terminal`
envelope with **`status: "escalated"`**, `storyId: null`, and a `nextCommand`
naming the `/mandrel-plan` invocation that owns the work.

**That envelope IS this session's terminal output.** Relay it and stop. There is
no remaining step, no degraded fallback, and no smaller version of the work to
attempt.

**Invoking `/mandrel-plan` in this same session is forbidden.** Hand the operator the
`nextCommand`; `/mandrel-plan` runs in a **fresh** session.

This is not style — it is the empirical finding that motivated the envelope.
A mandrel-bench 2.13.0 light-arm run read the escalation and continued anyway:
it invoked `/mandrel-plan` in-session and delivered. The in-session plan authored **one**
Story against the scenario's 3–5 contract, where a fresh `/mandrel-plan` session on the
identical seed authored **four**. Planning inside a session already framed as
small work under-decomposes, so walking past the escalation silently produced
the very outcome the guard exists to prevent. The gate's decision was right both
times; only the outcome's finality was missing.

Nothing is left half-started: an escalated run creates **no receipt Story, no
`story-<id>` branch, and no worktree** — the escalation path returns before
every creation call site, and `escalation.created` records all three as `false`
in a shape the schema pins, so a later run finds nothing to trip over.

## Why the two directions differ {#why-the-two-directions-differ}

Traffic runs both ways between this path and `/mandrel-plan`, and the two directions
have **deliberately different session rules**. It reads like an inconsistency;
it is not. The rule:

> **The direction whose guard is model judgment must break the session. The
> direction whose guard is mechanical need not.**

**Light → `/mandrel-plan` must be a fresh session.** What is being protected is
*authoring judgment*, and the empirical finding above is that a session already
framed as small work under-decomposes — one Story against a 3–5 contract where
a fresh session on the identical seed authored four. The frame is the hazard,
so only a new session removes it.

**`/mandrel-plan` → light may stay in-session.** Gate #1 fires **before** authoring, so
there is no authoring to corrupt, and the frame at that point is "plan this
seed" — the neutral one, not the small one. Everything on the receiving side is
mechanical: `STORY_SHAPE_CEILINGS`, the ledgered verdict, the diff backstop.
None of them degrade because the context is large, so nothing is gained by
paying for a fresh session.

Do not "fix" this into symmetry in either direction. Making `/mandrel-plan` → light
require a fresh session throws away a paid-for interrogation for no guard.
Letting light → `/mandrel-plan` run in-session reintroduces the exact failure the
`escalated` envelope exists to prevent.

## Constraints

- **Land, block, or escalate — never a silent local build.** The close push is
  the only sanctioned landing; an `escalated` terminal is the only sanctioned
  ending that delivers nothing, and it ends the session
  (§ Escalation is terminal).
- **No parallel engine.** This path invokes `single-story-init.js` and
  `single-story-close.js`; it never reimplements worktree, branch, PR, or merge
  mechanics.
- **State only via `update-ticket-state.js`.** Drive every `agent::*`
  transition through the script; report state, not process.

## See also

- [`/mandrel-deliver`](../mandrel-deliver.md) — the delivery entry point; routes here on a
  free-text prompt.
- [`/mandrel-plan`](../mandrel-plan.md) — routes here from Gate #1 on a confirmed suggestion,
  and owns the work an over-scope prompt escalates to.
- [`deliver-story.md`](deliver-story.md) — the one Story delivery engine every
  path shares.
- [`deliver-digest.md`](deliver-digest.md) — engine invariants, gates, and the
  terminal-envelope contract.
