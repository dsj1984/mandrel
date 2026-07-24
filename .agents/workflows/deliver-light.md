---
description:
  Single-session delivery for genuinely small work. Judges a prompt's
  predicted footprint, authors a receipt Story, then lands it through the same
  single-story-init / single-story-close engine — every close gate unchanged.
---

# /deliver-light "<prompt>" | --amends '#<id>' "<prompt>"

> **Thin entry point, not a second engine.** `/deliver-light` removes the
> `/plan` session for small work — nothing else. It runs a suitability gate,
> authors a minimal receipt Story, then hands off to the SAME scripts
> [`/deliver`](deliver.md) uses. Read
> [`helpers/deliver-digest.md`](helpers/deliver-digest.md) once first — the
> engine invariants, gates, and terminal-envelope contract below are its.

## Role

For a genuinely trivial change — a one-file fix, a small addition, a small
amendment — the multi-session plan→deliver ceremony buys nothing the bare model
lacks except **gates and landing**. `/deliver-light` keeps exactly those: one
session straight to execution from an operator prompt, landing through the
unchanged close path. It never relaxes a close gate, never bypasses the PR to
`main`, and never lands over-scope work silently.

## Four invariants (do not skip one)

1. **Suitability gate.** The prompt's predicted footprint is judged by the
   shared shape machinery (`deriveStoryShape` / `deriveChangeLevel`) **and** a
   ledgered model verdict with a recorded reason. Both must agree on `lite`.
2. **Over-scope stops — it never hard-fails.** An over-ceiling prompt STOPS and
   asks the operator to escalate to `/plan` or proceed light. Under `--yes` it
   fails closed to an **`escalated` terminal envelope** that ends the session
   (§ Escalation is terminal).
3. **Diff-derived backstop.** After implementation the ACTUAL change set is
   re-checked — the diff is the real scope signal — and an over-ceiling diff is
   blocked rather than landed.
4. **Minimal receipt Story.** A `type::story` is authored inline so `refs #`,
   history, telemetry, and the `agent::executing → agent::done` state machine
   all survive.

## Procedure

1. **Predict + gate.** Form the predicted footprint (new files, edited files,
   acceptance count) and your ledgered verdict (a recorded reason for `lite`),
   then run the gate:

   ```bash
   node .agents/scripts/deliver-light.js --prompt "<prompt>" \
     --creates <csv> --refactors <csv> --acceptance <n> \
     --route lite --reason "<why this is trivial>" [--amends '#<id>'] [--yes]
   ```

   Branch on `action` in the JSON envelope:
   - **`proceed-light`** — the receipt Story is authored; read `storyId` and
     `nextCommands`. Continue to step 2.
   - **`ask-operator`** — predicted scope exceeds the light ceilings. STOP and
     ask the operator to escalate to `/plan` or proceed light. Do not proceed
     on your own. This is a **question, not a terminal** — wait for the answer.
   - **over-scope under `--yes`** — no `action` to branch on: the gate emits an
     **`escalated` terminal envelope** instead (exit 2). § Escalation is
     terminal governs; you are finished.

   `--amends '#<id>'` is the canonical light case — shape-checked identically; a
   heavy amendment escalates to `/plan` like any other over-scope prompt.

2. **Init (same engine).** From the main checkout, synchronously, with the
   maximum Bash timeout:

   ```bash
   node .agents/scripts/single-story-init.js --story <storyId>
   ```

   Capture `workCwd`; `remoteVerified: false` → flip `agent::blocked` and stop.
   This is [`/deliver`](deliver.md)'s worktree/branch/lease/label engine,
   invoked, not reimplemented.

3. **Implement + self-eval.** `cd` into `workCwd`, implement the change, run
   `npm test` once in the worktree, then run the bounded acceptance self-eval
   loop ([`helpers/deliver-story.md`](helpers/deliver-story.md) Step 1a). Commit
   on `story-<id>` with `(refs #<storyId>)`.

4. **Diff backstop.** Before close, re-check the ACTUAL diff:

   ```bash
   node .agents/scripts/deliver-light.js --backstop --story <storyId>
   ```

   Exit `3` (`blocked: true`) means the landed diff exceeds the light ceilings
   (file count or a sensitive-path class). STOP, flip `agent::blocked`, and
   escalate to `/plan` — do not land.

5. **Close and land (same engine).** Exactly [`/deliver`](deliver.md)'s close:

   ```bash
   node .agents/scripts/single-story-close.js --story <storyId> --cwd <main-repo>
   ```

   Branch on the terminal envelope's `status` per
   [`helpers/deliver-digest.md`](helpers/deliver-digest.md) § 5 — every close
   gate runs byte-identical to the full path.

## Escalation is terminal {#escalation-is-terminal}

Over-scope under `--yes` emits a schema-validated `story-deliver-terminal`
envelope with **`status: "escalated"`**, `storyId: null`, and a `nextCommand`
naming the `/plan` invocation that owns the work.

**That envelope IS this session's terminal output.** Relay it and stop. There is
no remaining step, no degraded fallback, and no smaller version of the work to
attempt.

**Invoking `/plan` in this same session is forbidden.** Hand the operator the
`nextCommand`; `/plan` runs in a **fresh** session.

This is not style — it is the empirical finding that motivated the envelope.
A mandrel-bench 2.13.0 light-arm run read the escalation and continued anyway:
it invoked `/plan` in-session and delivered. The in-session plan authored **one**
Story against the scenario's 3–5 contract, where a fresh `/plan` session on the
identical seed authored **four**. Planning inside a session already framed as
small work under-decomposes, so walking past the escalation silently produced
the very outcome the guard exists to prevent. The gate's decision was right both
times; only the outcome's finality was missing.

Nothing is left half-started: an escalated run creates **no receipt Story, no
`story-<id>` branch, and no worktree** — the escalation path returns before
every creation call site, and `escalation.created` records all three as `false`
in a shape the schema pins, so a later run finds nothing to trip over.

## Constraints

- **Land, block, or escalate — never a silent local build.** The close push is
  the only sanctioned landing; an `escalated` terminal is the only sanctioned
  ending that delivers nothing, and it ends the session
  (§ Escalation is terminal).
- **No parallel engine.** `/deliver-light` invokes `single-story-init.js` and
  `single-story-close.js`; it never reimplements worktree, branch, PR, or merge
  mechanics.
- **State only via `update-ticket-state.js`.** Drive every `agent::*`
  transition through the script; report state, not process.

## See also

- [`/deliver`](deliver.md) — the multi-Story / planned delivery entry point.
- [`helpers/deliver-story.md`](helpers/deliver-story.md) — the one Story
  delivery engine both entry points share.
- [`helpers/deliver-digest.md`](helpers/deliver-digest.md) — engine invariants,
  gates, and the terminal-envelope contract.
