---
description:
  Unified planning entry point. Interrogate → author → persist. Emits one
  Story by default; splits into N>1 only under the default-single split
  policy.
---

# /plan --seed "<text>" | --seed-file <path> | --tickets <ids>

> **Lean spine.** Happy path + gate list; edge-case and reference detail
> lives in the on-demand
> [`helpers/plan-reference.md`](helpers/plan-reference.md).

## Inputs

Single planning path — there is no
Epic/Story router, no scope-triage `epic|story` verdict:

| Invocation | Behavior |
| --- | --- |
| `/plan --seed "<text>"` / `--seed-file <path>` | Ideation from chat text or on-disk notes: interrogate → author **one Story by default** → persist. |
| `/plan --tickets 123[,456…]` | Fetch issue(s), analyze into proper Stories (prefer N=1 rewrite). |

`--body` is **not** a `/plan` entry; persist always goes through
`plan-persist.js`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--seed "<text>"` / `--seed-file <path>` | Seed text / pre-authored notes path. |
| `--tickets <ids>` | Issue ids to analyze; closed as superseded at persist. |
| `--no-close-superseded` | Keep the source issues open — no supersede comment, no close. |
| `--force-review` | STOP at gate #2 for operator review — the only review gate (Story #4542). |
| `--route-downgrade-reason "<text>"` | Audited `full`→`lite` downgrade (Story #4707), ledgered per Story. |
| `--allow-over-budget` | Permit a plan exceeding `maxTickets`. |
| `--yes` | Non-interactive: auto-proceed gate #1 and gate #2 HITL waits. |
| `--dry-run` | Author + validate without GitHub writes; run as a pre-pass. |

## Default-single split policy

Author **one Story** unless (1) the pieces have **near-zero overlap**
(genuinely independent capabilities), or (2) there is an **architectural
seam** (different deployables, migration vs consumer). Coupled work stays
one Story — decompose it inside `## Slicing` as intra-session checkpoints,
not sibling tickets. When N>1, every acceptance criterion belongs to exactly
one Story (`assertAcceptancePartition` refuses coupled splits). **N=1 is the
lean path:** one authoring prompt, folded `## Spec`, light risk/critic
profile — no Epic-scale ceremony.

## Procedure

### 1. Interrogate

```bash
node .agents/scripts/plan-context.js --seed "<seed>" \
  --out temp/plan-<slug>/plan-context.json
# or: --seed-file <path>
# or: --tickets 123,456
```

**Always pass `--out`.** Persist auto-discovers that envelope from
`--plan-dir` and derives source-ticket ids from its `sourceTickets[]`
(Story #4554); the CLI also writes **`stories.template.json`** — the
authoring skeleton step 2 starts from.

The envelope carries docs context, codebase snapshot, the story-author
prompt, `sourceTickets[]`, `duplicates[]` (open **Stories** overlapping the
seed — never Epics), and the `complexityRoute` signal:
`"lite"` (trivial single-artifact scope — author one minimal Story, skip
fresh-critic / Tech-Spec ceremony; every close gate still runs) or `"full"`
(everything else; fails toward `full` on any doubt). Detail:
[`helpers/plan-reference.md` § Ceremony-lite gate](helpers/plan-reference.md).
Under `--yes`, do not ask free-form operator questions — unresolved
unknowns land in Key Assumptions.

**Gate #1** — STOP to confirm the sharpened plan intent and any
duplicate-candidate review. Under `--yes`, auto-proceed.

### 2. Author

**One-shot authoring (Story #4707).** Start from `stories.template.json`
(or the skeleton below); author `stories.json` in one pass. `body` is a
markdown string **or** a structured object; persist parses either,
serializes the canonical markdown, and syncs the top-level `acceptance[]` /
`verify[]` into the body — never dual-author those lists.

```jsonc
// temp/plan-<slug>/stories.json
[
  {
    "slug": "hyphen-case-slug", // ^[a-z0-9][a-z0-9-]*$
    "type": "story",
    "title": "Short descriptive title",
    "body": {
      "goal": "One sentence: why this Story exists.",
      "spec": "Optional — contract and invariants.",
      "changes": [{ "path": "path/to/file.ext", "assumption": "refactors-existing" }], // creates | refactors-existing | deletes
      "non_goals": [],
      "reason_to_exist": "One coherent reason this Story exists."
    },
    "acceptance": ["A testable, observable criterion"],
    "verify": ["exact command (unit|contract|e2e|validate)"],
    "depends_on": [] // sibling Story slugs, N>1 only
  }
]
```

Artifacts under `temp/plan-<slug>/`: `stories.json`
(**length 1 by default**; over-budget Specs fail closed — split or tighten,
never write Specs under `docs/`); optional `techspec.md` (**N===1 only** —
folded into `## Spec`); optional `acceptance-manifest.json` (N>1 partition
list — pass as `--plan-acceptance` or it is not read). For N=1,
use the envelope `systemPrompts.story` and emit one cohesive Story.
Split only under the policy above.

**Tickets mode:** every Story authors a top-level `supersedes[]` claiming
the source issues it replaces; persist refuses a partial map (shape:
[`helpers/plan-reference.md` § Tickets mode](helpers/plan-reference.md)).

### 2.5 Critics

```bash
node .agents/scripts/plan-critics.js \
  --stories temp/plan-<slug>/stories.json \
  [--tech-spec temp/plan-<slug>/techspec.md]
```

Run **before** persist — the last point a finding folds into a re-author
round. It exits 0 on **any** verdict (verdicts route work, they do not
gate) and exits **1** only on a usage/IO error — no critic ran, no skip
ledgered: **do not proceed to Persist**; fix and re-run.

- **Both `dispatch: false`** — proceed to Persist (each skip is ledgered).
- **Either `dispatch: true`** — dispatch **one fresh-context, maker-blind
  sub-agent per firing critic** (hand it only the draft artifacts,
  never the authoring transcript), fold findings into Gate #2 or a
  re-author round, re-run this step. Pre-mortem triggers (incl. the
  external-dependency probe, #4700), folding the advisory-only
  `textHygiene.findings[]` lints, and the role-scoped dispatch shape:
  [`helpers/plan-reference.md` § Critic dispatch detail](helpers/plan-reference.md).

### 3. Persist

**Gate #2** — with `--force-review`, STOP for approval before persist (the
**only** trigger). Under `--yes`, auto-proceed.

Run persist with `--dry-run` **first** — same command, GitHub writes
suppressed; every gate (ticket validator, body parse, DAG, capacity,
budget, reachability, split-policy and supersede partitions, Spec fold)
runs before the first `createIssue`. Then:

```bash
node .agents/scripts/plan-persist.js \
  --stories temp/plan-<slug>/stories.json \
  --plan-dir temp/plan-<slug> \
  [--plan-acceptance temp/plan-<slug>/acceptance-manifest.json] \
  [--tech-spec temp/plan-<slug>/techspec.md] \
  [--source-tickets 123,456] [...flags from the table above]
```

Persist creates Story issue(s) with `type::story` plus a `plan-run::<id>`
grouping label (**metadata only** — never a delivery-resolution input, Story #4692); N>1 `depends_on` edges become `blocked by #<id>` body footers.
`agent::ready` is the **terminal** flip, after all receipts are upserted — a
ready Story is always fully persisted (Story #4541). stdout is pure JSON
(logs on stderr).

In `--tickets` mode persist resolves source ids **envelope-first** and
closes each superseded source as `not_planned` with a comment (default on).
Detail (channels, close contract, resume, temp hygiene):
[`helpers/plan-reference.md`](helpers/plan-reference.md) — on a stranded
persist, re-run the same command; never hand-delete issues.

## Constraints

- `/plan` never starts delivery. No Epic ticket, no reconciler, no
  `delivery::single` marker.
- Duplicate search targets open Stories (`type::story`), not Epics.
- Deterministic gates still fail closed under `--yes`.

## See also

- [`/deliver`](deliver.md) — delivery entry point.
- [`/audit-to-stories`](audit-to-stories.md) — audit findings → plan seed.
- [`helpers/plan-reference.md`](helpers/plan-reference.md) — ceremony-lite,
  supersede, critic, and persist-resume detail.
- [`core/scope-triage`](../skills/core/scope-triage/SKILL.md) — optional
  split-advisory notes only (no routing verdict).
