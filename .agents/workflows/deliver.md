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
| `/deliver <storyId> <storyId> ...` | Sequence Stories in `depends_on` order via `stories-wave-tick.js`; each ready Story runs `deliver-story`. Default concurrency is **3**. |
| `/deliver --run <planRunId>` | Resolve Stories labeled `plan-run::<planRunId>` (envelope includes `dag` + `done`); sequence as above; after the last Story lands, run the per-run epilogue. |

Any ticket that is not `type::story`, or that still carries an `Epic: #N`
reference, is a hard error naming the ID and the fix (close or re-plan as a
v2 Story).

## Flags

| Flag | Meaning |
| --- | --- |
| `--run <planRunId>` | Deliver every Story in the plan-run (label `plan-run::<id>`). |
| `--dep <from>:<to>` | Extra operator dependency edge (Story id → Story id). |
| `--concurrency <n>` | Ready-set fan-out cap (default **3** from `delivery.deliverRunner.concurrencyCap`; set `1` for sequential). |
| `--yes` | Suppress the multi-Story confirmation gate. |
| `--steal` | Forwarded to `single-story-init.js` / lease steal. |
| `--wait-merge` | Force close-and-land (the default; `delivery.routing.closeAndLand`, default `true`). |
| `--no-wait-merge` | Opt out of close-and-land; stop at `agent::closing` for a human land. |

**Operator-merge implies no-wait.** `--no-auto-merge` and
`delivery.ci.autoMerge: "strict"` deliberately leave the PR un-armed, so
there is nothing for close to land: the Story rests at `agent::closing` for
the human merge, and is **not** flipped to `agent::blocked`. An explicit
`--wait-merge` does not override this — close cannot land a PR that was
never armed. A genuine *arm failure* is different: it still waits and still
blocks, because that is a fault to report rather than an operator decision
to respect.

## Procedure

1. **Resolve the Story set.**
   - Positional IDs → use them.
   - `--run <planRunId>` →

     ```bash
     node .agents/scripts/resolve-plan-run.js --run <planRunId>
     ```

     Capture `stories[]`, `dag[]`, and `done[]` from the envelope. Prefer
     the emitted `dag` — do **not** rebuild it by hand when `--run` was used.

2. **Build the DAG (positional only).** When delivering positional IDs
   (no `--run`), read `depends_on` / `blocked by` from each body and merge
   `--dep` edges into a JSON DAG for `stories-wave-tick.js`:

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
   execute it (init → implement → ceremony → close-and-land). Under
   `--yes` / injected helper content, execute directly without a re-read
   turn.

5. **Per-run epilogue (N>1).** After the last Story lands:

   ```bash
   # Plan-run label path:
   node .agents/scripts/plan-run-epilogue.js --run <planRunId>

   # Positional multi-Story path (synthesizes an adhoc planRunId):
   node .agents/scripts/plan-run-epilogue.js --stories 101,102
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

## Ceremony (profiles + two scopes)

Ceremony depth is selected by `delivery.routing.ceremonyProfile`
(`minimal` | `standard` | `strict`, default `standard`) and the Story's
planning risk:

| Profile | Acceptance critic | When to use |
| --- | --- | --- |
| `minimal` | Always inline | Tiny trusted N=1 Stories |
| `standard` | Risk-routed (+ sampling floor) | Default |
| `strict` | Always fresh-context | High-assurance / regulated surfaces |

| Scope | What runs | Mechanism |
| --- | --- | --- |
| **Per-Story (always)** | Gates, branch discipline, close-and-land | `deliver-story` / `single-story-close` |
| **Per-Story (profile + risk)** | Acceptance critic mode; review depth; audit lenses | `ceremony-routing.js` + `review-depth.js` + `code-review.js` |
| **Per-run (N>1)** | Audit roster · follow-up roll-up · sibling coherence | `plan-run-epilogue.js` once at run end |
| **Per-Story land** | Actionable follow-ups from friction | `captureStoryFollowUps` in confirm-merge |

## Constraints

- **Land or block — never a silent local build.** Worktrees, `story-<id>`
  branches, close-validation, and PR-to-`main` are the only sanctioned
  delivery mechanism. Attended delivers default to close-and-land
  (`delivery.routing.closeAndLand: true`); use `--no-wait-merge` only when
  a human will land the PR.
- `/deliver` never plans — tickets come from [`/plan`](plan.md).
- The router performs no git/label mutations; `deliver-story` owns every
  script invocation per Story.

## See also

- [`/plan`](plan.md) — unified planning entry point.
- [`helpers/deliver-story.md`](helpers/deliver-story.md) — the one Story
  delivery engine.
- Placeholder design Story for a fully deterministic deliver-run
  orchestrator: [#4521](https://github.com/dsj1984/mandrel/issues/4521).
