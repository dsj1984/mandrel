---
description:
  The unplanned prompt path /mandrel-deliver takes for a free-text prompt. Judges a
  prompt's predicted footprint for risk, authors a receipt Story, then lands it
  through the same single-story-init / single-story-close engine — every close
  gate unchanged.
---

# Unplanned delivery (the prompt path)

> **A path, not a command.** There is no `/deliver-light` to type. This file is
> reached one way — `/mandrel-deliver "<prompt>"` (an operator describing small
> work); Story #5312 retired the `/mandrel-plan` Gate #1 suggestion that used
> to be the second door. Read
> [`deliver-digest.md`](deliver-digest.md) once first — the engine invariants,
> gates, and terminal-envelope contract below are its.

## Role

For a genuinely trivial change — a one-file fix, a small addition, a small
amendment — the multi-session plan→deliver ceremony buys nothing the bare model
lacks except **gates and landing**. This path keeps exactly those: one session
straight to execution from a prompt, landing through the unchanged close path.
It never relaxes a close gate, never bypasses the PR to `main`, and never lands
over-scope work silently.

## One gate, and it reads evidence {#one-gate}

There is exactly **one gate** at prediction time, and it asks one question:
does the predicted footprint trip an absolute **risk** rule? Two do — a path in
a registered sensitive class, and a migration paired with its consumers — and
both are derived from the paths you name, not from anything you assert about
the size of your own request.

**A size you declare about your own request is not a measurement.** The path
used to ask for four more axes (distinct change kinds, a magnitude bucket, an
uncertainty bucket, a deployable span) and judge them against framework
ceilings. Story #5313 demoted them to warnings, which meant they decided
nothing; Story #5344 deleted them. Every one was supplied by the same agent
asking to proceed, so the axis and the answer had a single author.

**Size is enforced where ground truth is available:** the diff backstop in
step 4, against the actual committed change set. `LIGHT_DIFF_CEILINGS` —
implementation lines plus a file-sprawl tripwire — is the only size block on
this path, and it reads a diff rather than a declaration.

**The backstop counts by the right principle too.** It reads magnitude —
changed lines over implementation files — not artifacts, and exempts the test
and doc companions the framework itself mandates. A ceiling that punishes a
repo for obeying its own test-first rule is a ceiling that over-fires.

Sensitivity is the exception and stays absolute: a footprint touching an auth,
crypto, billing, or migration class routes `full` however small or mechanical,
at prediction time and again at the backstop. That one was never a ceiling and
is not being loosened.

## Four invariants (do not skip one)

1. **Risk gate.** The predicted footprint is judged by the shared risk
   machinery (`deriveStoryShape` / `deriveChangeLevel`) **and** a ledgered
   verdict carrying a recorded reason.
2. **Only risk and the ledger refuse.** An un-waivable risk rule (a
   sensitive-path class, a migration span) or an unrecorded reason emits an
   **`escalated` terminal envelope** (§ Escalation ends this path), attended or
   not. Nothing else refuses at prediction time.
3. **Diff-derived backstop.** After implementation the ACTUAL change set is
   re-checked — the diff is the real scope signal — and an over-ceiling diff is
   blocked rather than landed.
4. **Minimal receipt Story.** A `type::story` is authored inline so `refs #`,
   history, telemetry, and the `agent::executing → agent::done` state machine
   all survive.

## Procedure

1. **Predict + gate.** Form the predicted footprint (new files, edited files)
   and record the reason you are taking this path, then run the gate — it
   documents every flag itself, so run it with `--help` rather than guessing:

   ```bash
   node .agents/scripts/deliver-light.js --prompt "<prompt>" \
     --creates <csv> --refactors <csv> \
     --reason "<why this is small>" [--amends '#<id>']
   ```

   Branch on `action` in the JSON envelope:
   - **`proceed-light`** — the receipt Story is authored; read `storyId` and
     `nextCommands`, then continue to step 2. The diff backstop in step 4 is
     what bounds the actual change.
   - **escalation** — no `action` to branch on: the gate emits an
     **`escalated` terminal envelope** instead (exit 2), attended or not.
     § Escalation ends this path governs.

   `--amends '#<id>'` is the canonical light case — judged identically; an
   amendment touching a sensitive class escalates like any other prompt.

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
   [`deliver-digest.md`](deliver-digest.md) § 5, unchanged here — then run
   the bounded acceptance self-eval loop
   ([`deliver-story.md`](deliver-story.md) Step 1a). Commit
   on `story-<id>` with `(refs #<storyId>)`.

4. **Diff backstop.** Before close, re-check the ACTUAL diff:

   ```bash
   node .agents/scripts/deliver-light.js --backstop --story <storyId>
   ```

   This is the pass that actually bounds size, which is why the prediction gate
   above can afford to judge risk only. It measures **magnitude on the change's
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
   [`deliver-digest.md`](deliver-digest.md) § 6 — every close
   gate runs byte-identical to the full path.

## Escalation ends this path {#escalation-is-terminal}

A refused gate — an un-ledgered verdict or an un-waivable risk rule, attended
or unattended alike — emits a schema-validated `story-deliver-terminal`
envelope with **`status: "escalated"`**, `storyId: null`, and a `nextCommand`
naming the `/mandrel-plan` invocation that owns the work.

**That envelope IS this session's terminal output for the light path.** There
is no remaining light step, no degraded fallback, and no smaller version of the
work to attempt. Relay the envelope.

Nothing is left half-started: an escalated run creates **no receipt Story, no
`story-<id>` branch, and no worktree** — the escalation path returns before
every creation call site, and `escalation.created` records all three as `false`
in a shape the schema pins, so a later run finds nothing to trip over.

## Continuing into `/mandrel-plan` {#continuing-into-plan}

You may run the `nextCommand` **in this same session**, and when you do, seed
it deliberately:

- hand `/mandrel-plan` the **original prompt** and the envelope's
  `escalation.reasons` verbatim — the reasons name the risk class or the
  missing ledger, which is planning input, not noise;
- state plainly that the light path refused it, so the planning pass starts
  from "this is not small" rather than from the framing that produced the
  prompt.

**A fresh session is still the safer default** when the work is clearly larger
than the prompt admitted, or when the reasons name a sensitive class you had
not considered: the cost is one boot, and it removes the frame entirely.

### Why in-session planning was barred, and why it is not any more

Story #4746 required the *session* to end here, on one mandrel-bench 2.13.0
light-arm observation: a run read the escalation, invoked `/mandrel-plan`
in-session, and the in-session plan authored **one** Story against the
scenario's 3–5 contract, where a fresh `/mandrel-plan` session on the identical
seed authored **four**. The reading was that a session already framed as small
work under-decomposes.

That is one observation on one scenario, and the rule it bought cost every
escalated prompt a full cold boot — the exact session multiplication this path
exists to remove. Story #5344 keeps the finding and drops the ban: the
under-decomposition risk is real, so the seeding instructions above exist to
counter the frame directly, and the **light-arm cell of mandrel-bench** is the
measurement that decides whether the loosening stays. If that cell's
decomposition counts regress against the fresh-session arm, the ban comes back
and this section is the record of why. See
[`docs/decisions.md`](../../../docs/decisions.md) ADR `20260917-5344`.

## See also

- [`/mandrel-deliver`](../mandrel-deliver.md) — the delivery entry point; routes here on a
  free-text prompt.
- [`/mandrel-plan`](../mandrel-plan.md) — owns the work an escalated prompt
  goes to next.
- [`deliver-story.md`](deliver-story.md) — the one Story delivery engine every
  path shares.
- [`deliver-digest.md`](deliver-digest.md) — engine invariants, gates, and the
  terminal-envelope contract.
