---
description:
  Unified planning entry point. Interrogate → author → persist. Emits one
  Story by default (folded Tech Spec in the Story body); splits into N>1
  only under the default-single split policy.
---

# /plan --idea "<seed>" | --from-notes <path> | --body <path>

## Role

Single planning path. `/plan` owns the full 3-step ceremony — there is no
Epic/Story router, no scope-triage `epic|story` verdict, and no
`deliveryShape`. What v1 called an Epic is one large Story with a folded
spec.

## Inputs

| Invocation | Behavior |
| --- | --- |
| `/plan --idea "<seed>"` | Ideation: interrogate the seed, author **one Story by default**, persist. |
| `/plan --from-notes <path>` | Author from pre-written notes (e.g. `/audit-to-stories` handoff); no re-interrogation of scope. |
| `/plan --body <path>` | Persist a pre-authored Story body (validate + create); skips authoring. |

## Flags

| Flag | Meaning |
| --- | --- |
| `--idea "<seed>"` | Seed text for ideation. |
| `--from-notes <path>` | Pre-authored notes / one-pager path. |
| `--body <path>` | Pre-authored Story body file. |
| `--force-review` | Force the gate #2 operator review even when risk routing would skip it. |
| `--allow-over-budget` | Permit a plan that exceeds `maxTickets` (rare N>1). |
| `--yes` | Non-interactive: auto-proceed gate #1 and gate #2 HITL waits. |
| `--dry-run` | Author + validate without GitHub writes. |
| `--persona <name>` | Persona label on the drafted Story (default: engineer). |

## Default-single split policy

Author **one Story** unless:

1. the pieces have **near-zero overlap** (genuinely independent capabilities), or
2. there is an **architectural seam** (different deployables, migration vs consumer).

Coupled work stays one Story — decompose it inside `## Slicing` as
intra-session checkpoints, not sibling tickets. When N>1, every acceptance
criterion must belong to exactly one Story; `plan-persist` runs
`assertAcceptancePartition` and refuses coupled splits.

## Procedure

### 1. Interrogate

Run `node .agents/scripts/plan-context.js --seed "<seed>"` (or
`--one-pager <path>` / notes). The envelope carries docs context, codebase
snapshot, BDD probe, risk heuristics, and the story-author system prompt.
Under `--yes`, do not ask free-form operator questions — unresolved unknowns
land in Key Assumptions.

**Gate #1** — STOP to confirm the sharpened plan intent (one-pager / draft
outline) and any duplicate-candidate review. Under `--yes`, auto-proceed.

### 2. Author

Write artifacts under `temp/plan-<slug>/`:

- `stories.json` — array of Story tickets (**length 1 by default**). Each
  body uses the canonical `story-body` shape (`## Goal`, optional
  `## Slicing`, optional `## Spec`, `## Changes`, `## Acceptance`,
  `## Verify`, …). Fold the Tech Spec into `## Spec` (or let persist fold a
  shared `techspec.md`). Over-budget specs spill to `docs/specs/<slug>.md`.
- `risk-verdict.json` — axes + summary only (**no `deliveryShape`**).
- optional `techspec.md` — shared Tech Spec prose when not inlined per Story.
- optional `acceptance-manifest.json` — plan-level AC list for partition coverage when N>1.

Do **not** Read the retired `epic-plan-decompose-author` skill for a
multi-Story fan-out by default. Use the envelope `systemPrompts.story` (or
`spec` + story author) and emit one cohesive Story. Split only under the
policy above.

### 3. Persist

**Gate #2** — when risk routing requires review (or `--force-review`), STOP
for operator approval of the assembled plan (spec, stories, risk) before
persist. Under `--yes`, auto-proceed.

```bash
node .agents/scripts/plan-persist.js \
  --stories temp/plan-<slug>/stories.json \
  --risk-verdict temp/plan-<slug>/risk-verdict.json \
  [--tech-spec temp/plan-<slug>/techspec.md] \
  [--plan-dir temp/plan-<slug>] \
  [--persona <name>] \
  [--dry-run] \
  [--force-review] \
  [--allow-over-budget]
```

Persist creates Story issue(s) with `type::story` + `agent::ready`. When
N>1 it also applies a shared `plan-run::<id>` label. Ends by naming
`/deliver <storyId>` (or Stage 4 `/deliver --run <planRunId>` for N>1).

## Constraints

- `/plan` never starts delivery.
- No Epic ticket is opened. No reconciler. No `delivery::single` marker.
- Deterministic gates (ticket validator, split policy, reachability, budget)
  still fail closed under `--yes`.

## See also

- [`/deliver`](deliver.md) — delivery entry point (`/deliver <storyId>`).
- [`core/scope-triage`](../skills/core/scope-triage/SKILL.md) — optional
  split-advisory notes only (no routing verdict).
