---
description:
  Unified delivery entry point. Delivers one or more Stories via the single
  deliver-story engine — story-<id> → PR → main. Sequences N>1 by depends_on
  and runs the per-run epilogue once at the end.
---

# /deliver <storyId...> | --run <planRunId>

## Role

Single delivery path. `/deliver` owns input resolution and sequencing only —
every Story runs through
[`helpers/deliver-story.md`](helpers/deliver-story.md) (the evolved
single-Story engine). There is no Epic wave loop, no `epic/<id>` integration
branch, and no `--no-ff` wave merges.

## Inputs

| Invocation | Behavior |
| --- | --- |
| `/deliver <storyId>` | Deliver one Story via `helpers/deliver-story.md`. |
| `/deliver <storyId> <storyId> ...` | Sequence Stories in `depends_on` order via `stories-wave-tick.js`; each ready Story runs `deliver-story`. Default concurrency is **1** (sequential). |
| `/deliver --run <planRunId>` | Resolve Stories labeled `plan-run::<planRunId>`, then sequence as above; after the last Story lands, run the per-run epilogue (`planRunEpilogue`). |

Any ticket that is not `type::story`, or that still carries an `Epic: #N`
reference, is a hard error naming the ID and the fix (close or re-plan as a
v2 Story).

## Flags

| Flag | Meaning |
| --- | --- |
| `--run <planRunId>` | Deliver every Story in the plan-run (label `plan-run::<id>`). |
| `--dep <from>:<to>` | Extra operator dependency edge (Story id → Story id). |
| `--concurrency <n>` | Ready-set fan-out cap (default **1** — sequential). |
| `--yes` | Suppress the multi-Story confirmation gate. |
| `--steal` | Forwarded to `single-story-init.js` / lease steal. |
| `--wait-merge` | Headless must-land (forwarded into each Story close). |

## Procedure

1. **Resolve the Story set.**
   - Positional IDs → use them.
   - `--run <planRunId>` →

     ```bash
     node .agents/scripts/resolve-plan-run.js --run <planRunId>
     ```

     Capture `stories[]` (numeric ids) from the envelope.

2. **Build the DAG.** For each Story, read `depends_on` / `blocked by` from
   the body (`buildStoryAdjacency` / body footer). Merge `--dep` edges.
   Emit a JSON DAG for `stories-wave-tick.js`:

   ```json
   [{ "id": 101, "dependsOn": [] }, { "id": 102, "dependsOn": [101] }]
   ```

3. **Confirm (N>1).** Present the order and wait unless `--yes`.

4. **Sequence.** Loop until every Story is done:

   ```bash
   node .agents/scripts/stories-wave-tick.js \
     --dag '<json>' --done <csv> --in-flight <n> --concurrency <n>
   ```

   For each `ready` Story id, read
   [`helpers/deliver-story.md`](helpers/deliver-story.md) **in full** and
   execute it (init → implement → ceremony → close → PR → land). Under
   `--yes` / injected helper content, execute directly without a re-read
   turn. Default `--concurrency 1` means at most one Story in flight.

5. **Per-run epilogue (N>1 or `--run`).** After the last Story lands,
   run the real closeout CLI (not a planner stub):

   ```bash
   node .agents/scripts/plan-run-epilogue.js --run <planRunId>
   ```

   This executes, in order:
   - `audit-roster` — selects cross-Story audit lenses over the combined
     landed tip and posts `plan-run-audit-roster` on the primary Story;
     the host MUST walk each listed lens against the combined diff
   - `follow-up-rollup` — friction follow-ups across every Story in the
     run (files issues when auto-file is on; posts `follow-ups`)
   - `sibling-coherence` — Spec/Acceptance coherence check across sibling
     bodies (`plan-run-sibling-coherence`)

   A single-Story run skips the epilogue — follow-ups are captured on
   merge confirm instead (`captureStoryFollowUps`).

## Branch model (authoritative)

Every Story:

```text
story-<id>  →  PR  →  main (squash + required checks)
```

There is no `epic/<id>` integration branch and no `--no-ff` wave merge.
Dependent Stories land sequentially so each builds on the previous merge
to `main`.

## Ceremony (two scopes)

| Scope | What runs | Mechanism |
| --- | --- | --- |
| **Per-Story (always)** | Gates, branch discipline, land-or-block | `deliver-story` / `single-story-close` |
| **Per-Story (risk-routed)** | Acceptance critic mode; review depth; audit lenses | `ceremony-routing.js` + `review-depth.js` + `code-review.js` — read the Story's `planningRisk` / `risk-verdict` |
| **Per-run (N>1)** | Audit roster · follow-up roll-up · sibling coherence | `plan-run-epilogue.js` once at run end |
| **Per-Story land** | Actionable follow-ups from friction | `captureStoryFollowUps` in confirm-merge |

## Constraints

- **Land or block — never a silent local build.** Worktrees, `story-<id>`
  branches, close-validation, and PR-to-`main` are the only sanctioned
  delivery mechanism.
- `/deliver` never plans — tickets come from [`/plan`](plan.md).
- The router performs no git/label mutations; `deliver-story` owns every
  script invocation per Story.

## See also

- [`/plan`](plan.md) — unified planning entry point.
- [`helpers/deliver-story.md`](helpers/deliver-story.md) — the one Story
  delivery engine.
