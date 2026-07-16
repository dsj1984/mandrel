---
description:
  Unified planning entry point. Interrogate → author → persist. Emits one
  Story by default (folded Tech Spec in the Story body); splits into N>1
  only under the default-single split policy.
---

# /plan --seed "<text>" | --seed-file <path> | --tickets <ids>

## Role

Single planning path. `/plan` owns the full ceremony — there is no
Epic/Story router, no scope-triage `epic|story` verdict, and no
`deliveryShape`. Two operator modes only:

1. **Text** — seed from chat or a file.
2. **Tickets** — analyze existing issue(s) into proper Stories.

Audit findings become Stories via [`/audit-to-stories`](audit-to-stories.md)
(separate workflow), which hands off with `--emit-plan-seed` →
`/plan --seed-file <path>`.

## Inputs

| Invocation | Behavior |
| --- | --- |
| `/plan --seed "<text>"` | Ideation from chat text: interrogate → author **one Story by default** → persist. |
| `/plan --seed-file <path>` | Author from on-disk notes / plan seed (e.g. audit-to-stories handoff). |
| `/plan --tickets 123[,456…]` | Fetch issue(s), analyze into proper Stories (prefer N=1 rewrite). |

`--body` is **not** a `/plan` entry. Persist always goes through
`plan-persist.js --stories …`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--seed "<text>"` | Seed text for ideation. |
| `--seed-file <path>` | Pre-authored notes / plan-seed path. |
| `--tickets <ids>` | Comma-separated issue ids to analyze. |
| `--force-review` | Force gate #2 operator review even when risk routing would skip it. |
| `--allow-over-budget` | Permit a plan that exceeds `maxTickets` (rare N>1). |
| `--yes` | Non-interactive: auto-proceed gate #1 and gate #2 HITL waits. |
| `--dry-run` | Author + validate without GitHub writes. |

## Default-single split policy

Author **one Story** unless:

1. the pieces have **near-zero overlap** (genuinely independent capabilities), or
2. there is an **architectural seam** (different deployables, migration vs consumer).

Coupled work stays one Story — decompose it inside `## Slicing` as
intra-session checkpoints, not sibling tickets. When N>1, every acceptance
criterion must belong to exactly one Story; `plan-persist` runs
`assertAcceptancePartition` and refuses coupled splits.

**N=1 is the lean path:** one authoring prompt, folded `## Spec` in the
Story body, light risk/critic profile. Do not run Epic-scale decompose,
clarity, or reconciler ceremony for a single Story.

## Procedure

### 1. Interrogate

```bash
node .agents/scripts/plan-context.js --seed "<seed>"
# or: --seed-file <path>
# or: --tickets 123,456
```

The envelope carries docs context, codebase snapshot, BDD probe, risk
heuristics, the story-author system prompt, and `duplicates[]` (open
**Stories** whose title/body overlap the seed — never Epics). Under
`--yes`, do not ask free-form operator questions — unresolved unknowns
land in Key Assumptions.

**Gate #1** — STOP to confirm the sharpened plan intent and any
duplicate-candidate review. Under `--yes`, auto-proceed.

### 2. Author

Write artifacts under `temp/plan-<slug>/`:

- `stories.json` — array of Story tickets (**length 1 by default**). Each
  body uses the canonical `story-body` shape (`## Goal`, optional
  `## Slicing`, optional `## Spec`, `## Changes`, `## Acceptance`,
  `## Verify`, …). The Story is the single executable document: put lean
  approach prose in `## Spec`, binding criteria in top-level
  `acceptance[]` / `verify[]` (persist syncs them into the body). Do not
  restate Goal/Acceptance inside Spec. Over-budget Specs fail closed —
  split the Story or tighten Spec; never write Specs under `docs/`.
- `risk-verdict.json` — axes + summary only (**no `deliveryShape`**).
- optional `techspec.md` — **N===1 only** convenience when Spec was authored
  outside the Story JSON; persist folds it into that Story's `## Spec`.
  Forbidden for N>1 (each Story must carry its own Spec).
- optional `acceptance-manifest.json` — plan-level AC list for partition
  coverage when N>1.

For N=1, use the envelope `systemPrompts.story` and emit one cohesive
Story. Split only under the policy above.

### 3. Persist

**Gate #2** — when risk routing requires review (or `--force-review`), STOP
for operator approval of the assembled plan before persist. Under `--yes`, auto-proceed.
N=1 low-risk plans typically skip this gate.

```bash
node .agents/scripts/plan-persist.js \
  --stories temp/plan-<slug>/stories.json \
  --risk-verdict temp/plan-<slug>/risk-verdict.json \
  [--tech-spec temp/plan-<slug>/techspec.md] \
  [--plan-dir temp/plan-<slug>] \
  [--dry-run] \
  [--force-review] \
  [--allow-over-budget]
```

Persist creates Story issue(s) with `type::story` + `agent::ready` and, when
N>1, writes each authored `depends_on` edge into the sibling's body as a
`blocked by #<id>` footer — the ordering `/deliver` resolves from. No batch
label is applied (Story #4540 retired `plan-run::<id>`). Ends by naming the
exact command: `/deliver <storyId> [<storyId> ...]`.

## Constraints

- `/plan` never starts delivery.
- No Epic ticket is opened. No reconciler. No `delivery::single` marker.
- Duplicate search targets open Stories (`type::story`), not Epics.
- Deterministic gates (ticket validator, split policy, reachability, budget)
  still fail closed under `--yes`.

## See also

- [`/deliver`](deliver.md) — delivery entry point (`/deliver <storyId>`).
- [`/audit-to-stories`](audit-to-stories.md) — audit findings → plan seed →
  `/plan --seed-file`.
- [`core/scope-triage`](../skills/core/scope-triage/SKILL.md) — optional
  split-advisory notes only (no routing verdict).
