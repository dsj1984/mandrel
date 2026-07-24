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
   fails closed to recommending `/plan`.
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
     on your own.
   - **`escalate-plan`** — over-scope under `--yes`: recommend `/plan` and stop.
     `/deliver-light` never lands over-scope work.

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

## Constraints

- **Land or block — never a silent local build.** The close push is the only
  sanctioned landing.
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
