---
description: >-
  The deliver path's one bundled framework read: dispatch decision, engine
  invariants, the change-set/ceremony incantation, the acceptance-eval gate,
  the credited full-suite run, and the terminal envelope contract.
---

# Deliver digest (read once per session)

> **Bundle, not a procedure.** [`deliver-story.md`](deliver-story.md) is still
> the steps; this file is the material they reference, bundled so one read
> covers the happy path. Situational material (lease preflight, recovery
> routers, merge-wait budgets, CI remediation) stays on demand in
> [`deliver-story-reference.md`](deliver-story-reference.md) and
> [`deliver-reference.md`](deliver-reference.md); read those **only** when an
> envelope or a failure routes you there.

## 1. Dispatch — where the engine runs

Read `stories[].dispatchMode` from the `resolve-stories.js` envelope. One
rule produces it:

1. **Run topology.** A one-Story run is `inline` (the router's own session)
   whatever its shape — isolation only matters against a *concurrent*
   sibling, and a one-Story run has none.
2. **Every other run is `subagent`**, however trivial each Story's shape.

`inline` removes the `story-worker` boot and nothing else — not the verdict
owner, which the profile alone names (§ 3). **`subagent` and `inline` run the same engine**: same gates,
same PR to `main`, same terminal envelope, byte for byte.

## 2. Engine invariants

| Trait | Contract |
| --- | --- |
| Ticket type | `type::story` only — `resolve-stories.js` validates it |
| Branch | `story-<id>`, seeded from `project.baseBranch` (`main`) |
| Merge target | `main` via PR (squash + required checks) — never a direct push |
| Gates | Every close gate runs regardless of route; no route bypasses one |
| State | Only via `update-ticket-state.js --ticket <id> --state <state>` |
| Paths | Prefix every path-based tool with the absolute `workCwd` — `cd` does not scope them |

**Land or block.** Worktree → `story-<id>` → close-validation → PR to `main` is
the only sanctioned landing. A silent local build is not a delivery.

## 3. Change set — computed once, handed to everyone

One enumeration per Story: a critic that re-runs its own `git diff` can
score a different set than the one that routed it. **One script** derives
the change set, the level and the ceremony (close and critic hand-offs call
it; the worker gets it from § 4's `--init`):

```bash
node <main-repo>/.agents/scripts/ceremony-derive.js --story <storyId> --cwd <workCwd>
```

It prints one JSON object: `files` — the one change set the verdict owner is
handed (`null` when the diff could not be enumerated) — plus `level` and
`classes` from `review-depth.js`, and `mode`, `reason` and `verdictOwner`
from `ceremony-routing.js`. Level rules: a sensitive path registered in
`audit-rules.json` → `high`, none → `low`, an unenumerable diff → `null`.
The level drives **review depth** only (close reads the same level): a
sensitive footprint buys a **deep review**, not a fresh acceptance critic.

> **The ceremony rule, stated once.** The **profile alone** names the verdict
> owner: `minimal` / `standard` → `inline`, `strict` → `fresh`. Nothing else
> moves it — not the change level, not sensitivity, **not the dispatch
> mode**: an `inline` Story under `strict` still spawns the fresh critic. The
> only inline authoring under `strict` is the harness fallback in
> [`acceptance-self-eval.md`](acceptance-self-eval.md), noted in any friction
> comment.

## 4. Acceptance self-eval (Step 1a, required)

**One verdict owner per Story** — named by `verdictOwner`: the inline
self-eval under `minimal` / `standard` (the default), a fresh maker-blind
critic under `strict`. Never both, and never a warm-up pass. Start from the
skeleton — it derives § 3's `files` and `verdictOwner` with the same function:

`node <main-repo>/.agents/scripts/acceptance-eval.js --story <storyId> --init
--cwd <workCwd>`

It writes one empty record per `acceptance[]` item (plus the next round and
HEAD) under `temp/scratch/story-<id>/`. The owner fills **every** record,
scored against that change set with `verify[]` output as evidence, and scores
it in **one** gate call. Bounded by `delivery.acceptanceEval.maxRounds`
(default 2; `0` scores once with no redraft).

`node <main-repo>/.agents/scripts/acceptance-eval.js --story <storyId>
--verdict <verdict-path>`

The gate reads the Story's `acceptance[]` count itself and rejects, **before**
scoring and consuming no round, a verdict whose `criteria[]` length differs
or with an unfilled record (naming its indices). A second gate call in the
same round spends a round for nothing and races the Story-scoped ledger.

`proceed` → § 5. `redraft` → one more round inside the cap. `block` → **do
not close**: post a `friction` comment and flip `agent::blocked`.
Per-round mechanics: [`acceptance-self-eval.md`](acceptance-self-eval.md).

## 5. The one credited run — `story-handoff.js`

After the self-eval loop's last fix commit the worker runs **one** command,
which performs this section in order and prints one envelope:

`node <main-repo>/.agents/scripts/story-handoff.js --story <storyId> --cwd <workCwd>`

`ready` (exit 0) → hand off. `fix-required` (exit 2) → a finding, a red or
deferred suite, a base-merge conflict (files named), a non-fast-forward push
or a CRITICAL: fix, commit, re-run; labels untouched. `blocked` (exit 1) →
only a remote-refused push, an unreachable remote, an unconfirmed base branch
or an unregistered merge driver: it flips `agent::blocked` and posts
`friction`. A re-run skips every step still valid for HEAD. It never runs
close, opens a PR or writes another label. Outruns the sync Bash ceiling → run
it in the **background**.

1. **Preflight — blocking.** `project.commands.lint` and
   `quality-preview.js --changed-since origin/<baseBranch>`
   ([`deliver-reference.md`](deliver-reference.md) § Preflight).
2. **Base merge.** It will merge `origin/<baseBranch>` into the Story branch
   **first**, ahead of this run and the push: close's base-sync then no-ops,
   so neither stamp goes stale.
3. **One depositor**, by the predicate close registers `coverage-capture` on
   (one shared function) — CRAP gate enabled **and** a `test:coverage` script:
   - **Capture-active** →
     `node <main-repo>/.agents/scripts/coverage-capture.js --cwd <workCwd>`,
     behind the host full-suite lock. Signal: `Wrote content-digest capture
     stamp`. No second `npm test`.
   - **Otherwise** → `node <main-repo>/.agents/scripts/evidence-gate.js
     --standalone --scope-id <storyId> --gate test --worktree <workCwd> -- npm test`.
     Signal: `✓ test passed` — the `test` evidence close reads.
4. **Seat.** CRAP or MI gate on → `--seat-missing` for each (signal
   `seated: N`), committed as `chore(baselines): baseline-refresh: …`.
5. **Push** `story-<id>`; the remote ref must equal HEAD.
6. **Held review** — [`deliver-reference.md`](deliver-reference.md)
   § Held review.

A later commit voids either credit; a baseline-JSON seat keeps the stamp. The
handoff reads the **output**, not the exit code: a run that prints no signal
deposits nothing. Seat order, runner shapes, redraft rounds:
[`deliver-reference.md`](deliver-reference.md) § Credited run.

`verify[]` is scoped entries **plus** this one run: an entry that is itself a
full-suite command is reported credited against the same record, never
respawned.

## 6. Terminal envelope — the return contract

`single-story-close.js` emits exactly one envelope on stdout between
`--- STORY DELIVER TERMINAL ---` markers, schema-validated against
[`story-deliver-terminal.schema.json`](../../schemas/story-deliver-terminal.schema.json)
— the SSOT. Relay it verbatim; never hand-compose one or substitute prose.

| `status` | Exit | Meaning | You do |
| --- | --- | --- | --- |
| `landed` | 0 | PR merged, `agent::done`, tail ran (`tail.*: false` degrades the report, not the land) | Relay it. Done. |
| `pending` | 3 | **Resumable, not a failure** — the bounded wait expired healthy, or a human owns the merge. Nothing was mutated. | Run `nextCommand`. |
| `blocked` | 1 | Hard block; `blocked.blockClass` names it | `checks-failed` → fix + resume; else relay |
| `failed` | 1 | A phase crashed; `phase` names which | Diagnose, fix, re-run close. `base-sync` conflict (files in `failure.reason`): resolve in `workCwd`, commit, run `nextCommand`; block only if you cannot |

Required fields: `kind` (`story-deliver-terminal`), `storyId`, `status`,
`phase` (the schema's enum names where it stopped), `elapsedSeconds`,
`nextCommand`. `gates`
reports every gate as `passed` / `failed` / `skipped` — a skipped gate is
reported, never omitted, so a missing gate is never read as a passing one.

## 7. When to leave this file

Unclear state / a re-run refusal → `deliver-recover.js --story <id>`
(read-only). Lease, sweep, worktree scope; sequencing, epilogue, checklist
threading → [`deliver-story-reference.md`](deliver-story-reference.md) and
[`deliver-reference.md`](deliver-reference.md). CI red after the PR opens →
[`rules/ci-remediation.md`](../../rules/ci-remediation.md).
