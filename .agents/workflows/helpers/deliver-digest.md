---
description: >-
  The deliver path's one bundled framework read: dispatch decision, engine
  invariants, the change-set/ceremony incantation, the acceptance-eval gate,
  the credited full-suite run, and the terminal envelope contract.
---

# Deliver digest (read once per session)

> **Bundle, not a procedure.** [`deliver-story.md`](deliver-story.md) is still
> the steps; this file bundles the material they reference. Situational
> material stays on demand in
> [`deliver-story-reference.md`](deliver-story-reference.md) and
> [`deliver-reference.md`](deliver-reference.md), read only when routed.

## 1. Dispatch — where the engine runs

Read `stories[].dispatchMode` from the `resolve-stories.js` envelope. One
rule produces it:

1. **Run topology.** A one-Story run is `inline` (the router's own session)
   whatever its shape — isolation only matters against a *concurrent*
   sibling.
2. **Every other run is `subagent`**, whatever each Story's shape.

`inline` drops only the `story-worker` boot — not the verdict owner, which
the profile alone names (§ 3). **`subagent` and `inline` run the same engine**: same gates,
same PR to `main`, same envelope.

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
the only sanctioned landing.

## 3. Change set — computed once, handed to everyone

One enumeration per Story: a critic re-running `git diff` can score
another set. **One script** derives the change set, the level and the
ceremony (close and critic hand-offs call it; the worker gets it from § 4's
`--init`):

```bash
node <main-repo>/.agents/scripts/ceremony-derive.js --story <storyId> --cwd <workCwd>
```

It prints one object: `files` — the one change set handed to the verdict
owner (`null` when the diff is unenumerable) — plus `level` and
`classes` from `review-depth.js`, and `mode`, `reason` and `verdictOwner`
from `ceremony-routing.js`. Level: a sensitive
`audit-rules.json` path → `high`, else `low`; unenumerable → `null`.
The level drives **review depth** only (close reads it too): a
sensitive footprint buys a **deep review**, not a fresh acceptance critic.

> **The ceremony rule, stated once.** The **profile alone** names the verdict
> owner: `minimal` / `standard` → `inline`, `strict` → `fresh`. Nothing else
> moves it — not the change level, not sensitivity, **not the dispatch
> mode**: an `inline` Story under `strict` still spawns the fresh critic,
> bar the harness fallback in [`acceptance-self-eval.md`](acceptance-self-eval.md).

## 4. Acceptance self-eval (Step 1a, required)

**One verdict owner per Story** — named by `verdictOwner`: the inline
self-eval under `minimal` / `standard` (the default), a fresh maker-blind
critic under `strict`. Never both. Start from the
skeleton — it derives § 3's `files` and `verdictOwner` with the same function:

`node <main-repo>/.agents/scripts/acceptance-eval.js --story <storyId> --init
--cwd <workCwd>`

It writes one empty record per `acceptance[]` item under
`temp/scratch/story-<id>/`. The owner fills **every** record,
scored against that change set with `verify[]` output as evidence, and scores
it in **one** gate call. Bounded by `delivery.acceptanceEval.maxRounds`
(default 2; `0` scores once with no redraft).

`node <main-repo>/.agents/scripts/acceptance-eval.js --story <storyId>
--verdict <verdict-path>`

The gate reads the Story's `acceptance[]` count itself and rejects, **before**
scoring and consuming no round, a verdict whose `criteria[]` length differs
or with an unfilled record (naming its indices).

`proceed` → § 5. `redraft` → one more round inside the cap. `block` → **do
not close**: post a `friction` comment and flip `agent::blocked`.
Per-round mechanics: [`acceptance-self-eval.md`](acceptance-self-eval.md).

## 5. The one credited run — `story-handoff.js`

After the self-eval's last fix commit the worker runs **one** command:

`node <main-repo>/.agents/scripts/story-handoff.js --story <storyId> --cwd <workCwd>`

`ready` (exit 0) → hand off. `fix-required` (exit 2) → a finding, a red or
deferred suite, a base-merge conflict (files named), a non-fast-forward push,
a `commit_refs_rules` push stepping missed or a CRITICAL: fix, commit,
re-run; labels untouched. `blocked` (exit 1) → only a remote-refused push,
an unreachable remote, an unconfirmed base branch, an unregistered merge
driver or `host-resources` (exit 77): it flips `agent::blocked` and posts
`friction`. A re-run skips every step still valid for HEAD. Past the sync Bash ceiling → **background**.

1. **Base merge:** merge `origin/<baseBranch>` into the Story branch
   **first**, ahead of every check: close's base-sync then no-ops. Then close's **duplication re-score**, committed
   **untagged** before any credit.
2. **Preflight — blocking.** `typecheck`/`lint`/`format` (close's credit),
   `quality-preview.js --changed-since origin/<baseBranch>`, then each
   baselined ratchet; one `fix-required` lists every finding. Serial unless
   a host's `.agentrc.local.json` sets `delivery.execution.preflightConcurrency`
   above 1 (default 1): close's independent gates may then run in admitted
   lanes beside the base lane — [`deliver-reference.md`](deliver-reference.md) § Preflight.
3. **One depositor**, by the one predicate close registers `coverage-capture`
   on — coverage or CRAP gate on **and** a `captureScript`:
   - **Capture-active** →
     `node <main-repo>/.agents/scripts/coverage-capture.js --cwd <workCwd>`,
     behind the full-suite lock. Signal: `Wrote content-digest capture
     stamp`. No second `npm test`.
   - **Otherwise** → `node <main-repo>/.agents/scripts/evidence-gate.js
     --standalone --scope-id <storyId> --gate test --worktree <workCwd> -- npm test`;
     a predicted capture skip runs `testChanged --changed-since` the
     merge-base, else says why. Signal: `✓ test passed`.
4. **Seat.** `--seat-missing` (`seated: N`): MI before step 2, CRAP and
   capture-path coverage here, committed `chore(baselines): baseline-refresh:
   …`; then post-capture checks: close's `quality-preview-crap` and `check-baselines`,
   then `delivery.handoff.postSeatChecks`. Children get `MANDREL_HANDOFF_STEP`.
5. **Push** `story-<id>`; the remote ref must equal HEAD.
6. **Held review** from step 1, beside 2: a CRITICAL skips or aborts 3,
   one envelope with any finding — [`deliver-reference.md`](deliver-reference.md) § Held review.

A later commit voids any credit; a baseline-JSON seat keeps the stamp. It
reads the **output**, not the exit code: no signal deposits nothing. Seat order, re-score, runner shapes:
[`deliver-reference.md`](deliver-reference.md) § Credited run.

`verify[]` is scoped entries **plus** this one run: an entry that is a
full-suite command is reported credited against the same record, never
respawned.

## 6. Terminal envelope — the return contract

`single-story-close.js` emits exactly one envelope on stdout between
`--- STORY DELIVER TERMINAL ---` markers, schema-validated against
[`story-deliver-terminal.schema.json`](../../schemas/story-deliver-terminal.schema.json)
— the SSOT. Relay it verbatim; never hand-compose one.

| `status` | Exit | Meaning | You do |
| --- | --- | --- | --- |
| `landed` | 0 | PR merged, `agent::done`, tail ran (`tail.*: false` degrades the report, not the land) | Relay it. Done. |
| `pending` | 3 | **Resumable, not a failure** — the bounded wait expired healthy, or a human owns the merge. Nothing was mutated. | Run `nextCommand`. Each beat: run every `confirm[]` verbatim, pre-epilogue. |
| `blocked` | 1 | Hard block; `blocked.blockClass` names it | `checks-failed` → fix + resume; else relay |
| `failed` | 1 | A phase crashed; `phase` names which | Diagnose, fix, re-run close. `base-sync` conflict (files in `failure.reason`): resolve in `workCwd`, commit, run `nextCommand`; block only if you cannot |

Required fields: `kind` (`story-deliver-terminal`), `storyId`, `status`,
`phase` (the schema's enum names where it stopped), `elapsedSeconds`,
`nextCommand`. `gates`
reports every gate as `passed` / `failed` / `skipped` — a skipped gate is
never omitted, so a missing gate never reads as passing.

## 7. When to leave this file

Unclear state / a re-run refusal → `deliver-recover.js --story <id>`; boot
auto-lists stalled `agent::executing` Stories with it (read-only, advisory).
Lease, sweep, worktree scope; sequencing, epilogue, checklist threading → [`deliver-story-reference.md`](deliver-story-reference.md) and
[`deliver-reference.md`](deliver-reference.md). CI red after the PR opens →
[`rules/ci-remediation.md`](../../rules/ci-remediation.md).
