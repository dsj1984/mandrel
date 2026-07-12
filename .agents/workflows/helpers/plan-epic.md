---
description:
  Epic planning path invoked by /plan — three steps (interrogate → author →
  persist) that produce the Epic body's Tech Spec + Acceptance Table managed
  sections and the Story backlog (or a single-delivery routing marker).
---

# helpers/plan-epic — Epic planning path (invoked by /plan)

## Shape

Three steps replace the retired 12-phase pipeline (Epic #4474). All GitHub
reads concentrate in `plan-context.js` (step 1), all GitHub writes in
`plan-persist.js` (step 3); the authoring middle reads one JSON envelope and
writes 2–4 files. Exactly two HITL STOP gates: **gate #1** at the exit of
interrogate, **gate #2** risk-routed before persist. Every deterministic
validator of the old pipeline survives inside the persist CLI.

## Constraints

- Do not modify existing issues without explicit permission. Every GitHub
  mutation runs inside `plan-persist.js` — or `epic-plan-clarity.js` for a
  gate-#1-approved body refinement — never via ad-hoc `gh issue edit`.
- Never bypass a persist rejection by editing GitHub directly: fix the named
  artifact and re-run the CLI (one targeted amend pass, below).

## Step 1 — Interrogate

Goal: shared understanding and a confirmed planning basis. Grilling
discipline: ask questions **one at a time** — asking multiple questions at
once is bewildering. If a **fact** can be found by exploring the codebase,
look it up rather than asking; the **decisions** are the operator's — put
each one to them. Do not proceed to authoring until shared understanding is
confirmed (gate #1).

### Ideation entry (`--idea "<seed>"` or no argument)

1. Activate the [`core/idea-refinement`](../../skills/core/idea-refinement/SKILL.md)
   skill with the seed. It returns a one-pager with the canonical sections
   (Problem Statement, Recommended Direction, Key Assumptions, MVP Scope,
   Not Doing). Write it to `temp/plan-ideation/<slug>/one-pager.md` (slug
   from the title; the tree is gitignored).
2. Emit the authoring envelope:

   ```bash
   node .agents/scripts/plan-context.js \
     --one-pager temp/plan-ideation/<slug>/one-pager.md \
     > temp/plan-ideation/<slug>/plan-context.json
   ```

   The ideation envelope carries `duplicates[]` (cross-Epic dup search),
   `deliveryShapeSignal`, `docsContext`, `codebaseSnapshot`, `ticketSchema`,
   and the rendered `systemPrompts`. The Epic does **not** exist yet —
   creation happens in step 3.
3. Run the shared scope-triage gate over the one-pager — mechanics in
   [`scope-triage-gate.md`](scope-triage-gate.md). The verdict folds into
   gate #1. The Recommended branch on a `story` / `borderline` verdict:
   persist the one-pager as a notes file and hand off to
   [`plan-story.md`](plan-story.md) via `/plan --from-notes <path>` as a
   scope-triage handoff (no re-triage on the receiving side), then exit this
   path. Skipped entirely when `/plan` was itself entered via a scope-triage
   handoff.
4. Review `duplicates[]`. A non-empty ranked list folds into gate #1: the
   operator either confirms the new Epic is distinct or folds the idea into
   an existing Epic (in which case `/plan` exits).

### Existing-Epic entry (`/plan <epicId>`)

1. Emit the authoring envelope:

   ```bash
   node .agents/scripts/plan-context.js --epic [Epic_ID] \
     > temp/epic-[Epic_ID]/plan-context.json
   ```

   The epic envelope additionally carries `clarity` (section-presence
   rubric), `replan` (already-planned signals), and `planState`.
2. **Re-plan detection** (`replan.alreadyPlanned === true`): the Epic body
   already carries Tech Spec sections. Fold the decision into gate #1: a
   confirmed re-plan runs step 3 with `--force` (managed sections are
   overwritten in place; child Stories are closed and recreated); a decline
   aborts gracefully.
3. **Story-sized advisory**: only when the Epic is not already planned
   **and** `replan.openStoryCount` is 0, run the shared scope-triage gate
   over the Epic body ([`scope-triage-gate.md`](scope-triage-gate.md)). On a
   `story` / `borderline` verdict the Recommended branch converts via
   close-and-recreate: seed `temp/epic-[Epic_ID]/scope-triage-seed.md` from
   the Epic body, hand off to `/plan --from-notes <path>` as a scope-triage
   handoff, and — only after the replacement Story `#N` exists — close the
   Epic with a cross-linking comment
   (`gh issue close [Epic_ID] --comment "Closed in favor of #N — scope triaged as a standalone Story."`).
   Both mutations happen only after the operator confirms at gate #1.
4. **Clarity refinement** (`clarity.verdict === 'needs-refinement'`): the
   deterministic scoring already ran inside the envelope build (a `clear`
   verdict requires ≥ 4 of 5 canonical sections **and** Acceptance
   Criteria). Interrogate the operator on the named gaps
   (`clarity.missingOrPlaceholder`) — one question at a time — and draft the
   refined body to `temp/epic-[Epic_ID]/clarity-update.md`. The refined-body
   diff folds into gate #1; on approval persist it:

   ```bash
   node .agents/scripts/epic-plan-clarity.js --epic [Epic_ID] \
     --updated-body temp/epic-[Epic_ID]/clarity-update.md
   ```

   One refinement pass per invocation — do not loop.

### Gate #1 — exit of interrogate (HITL STOP)

One operator confirmation folds every interrogate outcome: the one-pager (or
the refined-body diff), the scope-triage verdict, the duplicate candidates,
and the re-plan decision. Display them together and **STOP**. Do not enter
step 2 until the operator explicitly confirms.

> **`--yes` (headless) auto-proceed.** Under `--yes` this gate does **not**
> STOP: the confirm resolves as **approved**, and a `story` / `borderline`
> triage verdict resolves to its **Recommended** branch. The interrogation
> itself runs exactly **one bounded pass** — no operator questions are asked;
> facts come from the codebase and every unresolved unknown lands in the
> one-pager's **Key Assumptions** section instead of a question, so a
> headless driver can never hang. See
> [`plan.md` § Headless / non-interactive mode](../plan.md#headless--non-interactive-mode---yes).

## Step 2 — Author

Read the envelope with the `Read` tool and write the planning artifacts to
`temp/epic-[Epic_ID]/` (ideation: the `temp/plan-ideation/<slug>/` tree).
The single `plan-context.json` envelope supersedes the per-phase
`planner-context.json` / `decomposer-context.json` files the authoring
skills name — read the envelope wherever a skill asks for either.

1. **`techspec.md`** — activate the
   [`epic-plan-spec-author`](../../skills/core/epic-plan-spec-author/SKILL.md)
   skill. The Tech Spec opens with `## Delivery Slicing` and never restates
   the Epic's Context/Goal/Scope.
2. **`risk-verdict.json`** — same skill; the schema-conformant verdict
   **plus `deliveryShape: "fan-out"|"single"`** and a one-line rationale.
   Seed the shape from the envelope's `deliveryShapeSignal` (advisory —
   the operator vetoes it at gate #2). `"single"` means one-pass-sized or a
   pure dependent chain: the plan ships as spec-only, with **no tickets**.
3. **`acceptance-spec.md`** — same skill; omit only when the Epic carries
   the `acceptance::n-a` waiver label.
4. **`tickets.json`** — fan-out shape only: activate the
   [`epic-plan-decompose-author`](../../skills/core/epic-plan-decompose-author/SKILL.md)
   skill against the same envelope (its `systemPrompts.decompose`,
   `ticketSchema`, and `maxTickets` fields). In single-delivery shape author
   **no** tickets file — the Delivery Slicing table is the plan.

> **One-pass refinement contract (amend, don't regenerate).** When a critic
> flags Stories or the step 3 persist rejects an artifact, apply **targeted
> edits** to the existing files — fix only what was named — and re-run the
> rejected step **once**. Never loop wholesale re-authoring.

### Conditional critics (between authoring and gate #2)

Evaluate the dispatch conditions deterministically first — one git-local
CLI call, zero GitHub reads:

```bash
node .agents/scripts/plan-critics.js --epic [Epic_ID]
```

(ideation: pass `--tech-spec`/`--risk-verdict`/`--tickets` explicitly). The
verdict names each critic with `dispatch: true|false` and reasons. Dispatch
a sub-agent ONLY for a critic with `dispatch: true`; surface each skip as a
one-line note. Every skip decision is appended to the plan-metrics ledger
(`kind: "critic-skip"`, with reasons) so under-firing is auditable — the
persist validators remain unchanged hard gates either way.

Both critics are **fresh-context sub-agents** (`Agent` tool,
`subagent_type: general-purpose`) — never inline skill activations, so they
cannot grade their own homework. Both are report-only: they never write to
GitHub and never persist `tickets.json`; their findings fold into the gate #2
view, and accepted findings get one targeted amend pass (above).

- **Consolidation critic** (fan-out only): fires when the draft does NOT
  already match the Tech Spec's Delivery Slicing table 1:1 in Story count
  and dependency shape, AND the divergence is worth a dispatch — the draft
  has more than 5 stories, or the mismatch is confirmed (a small draft
  whose table is merely missing/unparseable skips: gate #2's single view
  covers it). On dispatch the sub-agent reads the
  [`epic-plan-consolidate`](../../skills/core/epic-plan-consolidate/SKILL.md)
  skill and reconciles the draft against the slicing target. Its operations
  are scope-preserving only — merge sibling Stories and rewire `depends_on`;
  it MUST NOT add scope or invent tickets.
- **Pre-mortem critic**: fires when the risk verdict's overall level is
  high, OR the ticket count is at least half `maxTickets`, OR any
  `planning.riskHeuristics` phrase matches the plan text. On dispatch the
  sub-agent reads the
  [`epic-plan-premortem`](../../skills/core/epic-plan-premortem/SKILL.md)
  skill, reads the actual cited code surfaces, and emits predicted-rework
  findings to `temp/epic-[Epic_ID]/premortem-report.md`.

## Step 3 — Persist

### Gate #2 — risk-routed review (HITL STOP, before any GitHub write)

Present the whole plan in **one view**: the Tech Spec, the Acceptance Table,
the tickets (or the Delivery Slicing table in single shape), the risk
verdict, the `deliveryShape`, and any critic reports. This is the single
seam where the operator vetoes single-vs-fan-out routing.

- **High risk** (any risk axis high / `requiresReview`-shaped verdict) or
  **operator override** (`--force-review`): **STOP** for explicit operator
  approval before running the persist CLI.
- **Low risk**: emit a one-line auto-proceed note and continue directly to
  the persist call — no operator wait. (`--yes` is a no-op on this branch —
  there is no STOP to suppress.)

> **`--yes` (headless) auto-proceed.** Under `--yes` this review gate does
> **not** STOP, even when the verdict is high-risk or `--force-review` was
> passed: the review resolves as **approved** and the run continues to the
> persist call. `--yes` does **not** alter risk routing or the review
> criteria themselves — it only forces a proceed where this gate would
> otherwise STOP. See
> [`plan.md` § Headless / non-interactive mode](../plan.md#headless--non-interactive-mode---yes).

### Run the persist CLI

```bash
# Normal persist (artifact paths default to temp/epic-[Epic_ID]/)
node .agents/scripts/plan-persist.js --epic [Epic_ID]

# Re-plan (overwrite managed sections in place; close + recreate the tree)
node .agents/scripts/plan-persist.js --epic [Epic_ID] --force

# Ideation (opens the Epic itself; artifact paths must be explicit)
node .agents/scripts/plan-persist.js \
  --one-pager temp/plan-ideation/<slug>/one-pager.md \
  --tech-spec temp/plan-ideation/<slug>/techspec.md \
  --risk-verdict temp/plan-ideation/<slug>/risk-verdict.json \
  --acceptance-table temp/plan-ideation/<slug>/acceptance-spec.md \
  --tickets temp/plan-ideation/<slug>/tickets.json

# Change-request delta (tickets carry op: add|modify|keep|close;
# close ops additionally require --explicit-delete after the dry-run diff)
node .agents/scripts/plan-persist.js --epic [Epic_ID] --amend
```

The CLI runs every deterministic step in one ordered, fail-closed pass:
section gate (`## Delivery Slicing` required) → risk-verdict validation +
mode-coherence hard error (`deliveryShape: "single"` with tickets, or
fan-out without them, refuses) → `validateAndNormalizeTickets` +
file-assumption gate + DAG + sizing/budget (fan-out and amend) → ideation
Epic creation → Epic lease (`--steal` transfers a confirmed-dead claim) →
managed sections + `risk-verdict` comment + spec-freshness advisory → story
tree via the structural reconciler (single shape: the `delivery::single`
routing marker and a zero-ticket checkpoint instead) → inline healthcheck
(the **blocking** `agent::ready` exit condition; waive only via the
`planning::healthcheck-waived` label) → one terminal `agent::ready` flip (no
intermediate `agent::review-spec`) → checkpoint v2 + a single `plan-summary`
comment carrying the dry-run wave table → temp cleanup **only at terminal
success**, so a failed run leaves the artifacts in place for `--force` /
`--resume` reuse.

### Persist rejections and soft failures

Each rejection names the artifact and the gap; apply the one-pass amend
contract (step 2) and re-run the persist once:

- **Section gate / validator / file-assumption / DAG errors** — targeted
  edit to `techspec.md` or `tickets.json`.
- **Reachability orphans** (deterministic route-glob vs `navRegistry` check;
  a silent no-op when `planning.navigation` is unconfigured) — a named
  **soft failure** (exit 3, before any GitHub write) listing the orphaned
  surfaces: apply one targeted amend adding a navigation owner
  (at most one reachability Story per plan), then re-persist.
- **Over budget** (`maxTickets`) — re-scope, or re-run with
  `--allow-over-budget` after confirming the rationale on the Epic.
- **Rate-limit abort on a large Epic** — resume with `--resume`; see
  [`plan-epic-reference.md` § `--resume` recovery](plan-epic-reference.md#persist----resume-recovery-secondary-rate-limit).

### Handoff

> "Planning is complete. Run `/deliver #[Epic_ID]` to start the wave loop,
> or pick a single Story from Wave 0 (the `plan-summary` comment's wave
> table) and run `/deliver #[Story_ID]` to drive it directly."

## Troubleshooting & recovery

Edge-case procedures live in the reference companion:

- [`plan-epic-reference.md` § Troubleshooting](plan-epic-reference.md#troubleshooting)
- [`plan-epic-reference.md` § Persist guards — background rationale](plan-epic-reference.md#persist-guards--background-rationale)
- [`plan-epic-reference.md` § `--resume` recovery](plan-epic-reference.md#persist----resume-recovery-secondary-rate-limit)
