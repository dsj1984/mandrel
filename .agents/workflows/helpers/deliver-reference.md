---
description:
  On-demand reference appendix for /deliver — the sequencing edge cases,
  role-scoped dispatch mechanics, lite-route inline execution, checklist
  threading, and the per-run epilogue. Read it when the matching lever is in
  play; the lean spine in deliver.md links here.
---

# /deliver — reference appendix (on-demand)

Reference-only detail split out of [`deliver.md`](../deliver.md) so the
always-resident spine stays lean (Story #4708). Nothing here is a new MUST —
it is the mechanics an operator consults when the matching lever is engaged.

## Sequencing edge cases (`stories-wave-tick.js`)

Each beat re-probes live state: it re-resolves the graph, classifies **done**
(`agent::done` or a closed issue — including foreign blockers that landed in
another run), and derives **in-flight** from live `agent::executing` /
`agent::closing` labels. You never compute `done` or `in-flight` — that
accounting is read from reality every beat (Story #4594).

**`--dispatched` is the one thing you must tell it (Story #4601).** List every
Story id you have spawned this run. Live state cannot instantly report a Story
you dispatched moments ago: `single-story-init.js` publishes `agent::executing`
before the worktree install (Story #4620 moved it ahead of the multi-minute
install, so the window is now short rather than minutes-long), but it is not
zero — until the label lands the Story still reads `agent::ready` and, without
`--dispatched`, the next beat would hand it back and a second sub-agent would
join the first on the same branch and worktree, interleaving commits.
`--dispatched` closes that residual same-run window. The rule is
**append-only: add each id as you dispatch it and never remove one.** The flag
is additive, not authoritative — the probe unions it into the label-derived set
and then filters it against live state, so an id that has since gone
`agent::done` is dropped for you. Re-listing an id costs nothing and cannot
double-count a slot; *omitting* one is the only way to get this wrong. This is
why `--dispatched` is not the `--done` bookkeeping #4594 retired, and why
`--in-flight` remains rejected under `--probe-live`.

**Cross-run de-confliction is automatic (Story #4620).** A Story another
operator is delivering is withheld without any bookkeeping from you: the probe
reads the Story's assignee lease and, when it belongs to a different operator,
withholds the Story and reports it in the envelope's
`foreignHeld: [{ id, holder }]` (with `foreignHeldReason`). That is not a
failure or a wedge — the holder's run owns the branch, and this run picks the
Story up automatically once their lease clears. Init is the backstop: it
refuses a Story already labelled `agent::executing`, or one whose lease a
different operator holds, unless you pass `--steal`. Assignee-based withholding
needs `github.operatorHandle` set (in `.agentrc.local.json`); without it the
probe logs a warning and leans on init's lease refusal alone.

## Dispatch mechanics (role-scoped by default)

**A single-Story run executes inline (Story #4736).** Sub-agent isolation is
load-bearing only for **concurrent** dispatch — two workers sharing a checkout
would race on worktrees and branch refs — so a run resolving exactly one Story
has no sibling to isolate from and pays the spawn premium for nothing (a boot is
a cache write at full rate; an inline continuation is a cache read at ~10%).
`resolve-stories.js` already reports it: a one-id run comes back with
`dispatchMode: "inline"` whatever the Story's shape. Role-scoped spawning is
retained in full for multi-Story waves, and the rule changes **where** the
engine runs, never what runs — gates, PR, and terminal envelope are identical.

**Lite-shaped Stories execute inline (Story #4722).** Before spawning anything,
read the Story's `dispatchMode` from the resolver envelope
(`stories[].dispatchMode`, derived by `resolveStoryDispatchMode` in
`lib/orchestration/complexity-gate.js` **from the fetched Story body's own
shape** — `changes[]` count, acceptance count, creates-vs-refactors mix, and
sensitive-path classes; the `route::lite` label is a human-visible hint only,
never the control signal, so a lost or never-written label cannot misroute
delivery): a Story with `dispatchMode: "inline"` executes
[`deliver-story.md`](deliver-story.md) **inline in this session** — no
`story-worker` sub-agent boot and no fresh acceptance-critic sub-agents
(sub-agent boots are the dominant deliver-phase token cost at trivial scope) —
threading the same `docsDigestPath` / `checklistPath` / change-set discipline
as a spawned worker. Inline removes model-side fan-out only: every
`single-story-close.js` gate, the PR to `main`, and the terminal envelope are
identical. Everything else — a full-shaped body, a missing/unparseable body,
or a footprint intersecting a sensitive-path class (sensitivity wins and
keeps the fresh acceptance critic) — takes the standard sub-agent path.

**Dispatch each `ready` Story (role-scoped by default).** When
`delivery.routing.roleScopedAgents` is enabled (the **default**) and the host
exposes agent dispatch, spawn each ready Story as its own
`subagent_type: story-worker` sub-agent — it boots on the role-scoped
[`story-worker`](../../agents/story-worker.md) context (its own system prompt, no
`CLAUDE.md` @-closure) carrying the load-bearing delivery MUSTs standalone. The
sub-agent executes [`deliver-story.md`](deliver-story.md) end to end
(init → implement → acceptance self-eval → close-and-land). Thread into its
prompt: `storyId`; `docsDigestPath` (the per-run docs digest, null when
`project.docsContextFiles` is unset); `checklistPath` (the footprint-matched
write-time audit checklist, produced at dispatch, below); and the
**change-set discipline** — the worker computes the change set once with
`computeChangeSet` and hands that one list to every acceptance critic (Story #4593); it never lets a critic re-derive the diff.

**Produce `checklistPath` before the spawn (Story #4627).** Compute the payload
from the Story's predicted footprint (its `changes[]` / `references[]` path
entries) with `buildDispatchChecklist` and write it to the run temp dir, then
thread the resulting path (empty when nothing matched):

```bash
node --input-type=module -e '
  import { buildDispatchChecklist } from "<main-repo>/.agents/scripts/lib/audit-suite/index.js";
  import { parse } from "<main-repo>/.agents/scripts/lib/story-body/story-body.js";
  // storyBody is the fetched Story issue body.
  const { changes, references } = parse(process.env.STORY_BODY);
  const { checklistPath } = buildDispatchChecklist({
    storyId: <storyId>, changes, references, runTempDir: "temp/run-<id>",
  });
  console.log(checklistPath ?? "");
'
```

`buildDispatchChecklist` (`lib/audit-suite/dispatch-checklist.js`) is a pure
function of the footprint and the on-disk checklists; an empty match prints
nothing and the worker runs with no write-time checklist — the maker-blind
close-scope pass still covers it.

**Inline fallback (`roleScopedAgents: false` / no-nesting harness).** When the
kill-switch is off, or the host cannot spawn a sub-agent at this nesting depth,
do **not** stall: read [`deliver-story.md`](deliver-story.md) **in full** and
execute it directly, in this turn, threading the same `docsDigestPath` /
`checklistPath` / change-set discipline. Under `--yes` / injected helper
content, execute directly without a re-read turn. The engine, gates, and
terminal envelope are identical either way — only the isolation differs.

## Operator-merge implies no-wait

`--no-auto-merge` and `delivery.ci.autoMerge: "strict"` leave the PR
deliberately un-armed: there is nothing for close to land, so the Story rests
at `agent::closing` for the human merge and is **not** flipped to
`agent::blocked` — `--wait-merge` does not override this, because the operator
owning the merge is a decision to respect, not a fault to report. A genuine
*arm failure* is the opposite case: nobody chose it, so close still waits and
still blocks. That asymmetry is what keeps the must-land contract intact
without misfiling deliberate human merges as blocks.

## Per-run epilogue (N>1)

Once the sequence reports `epilogueDue: true` (every Story done), keyed on the
delivered id set:

```bash
node .agents/scripts/plan-run-epilogue.js --stories 101,102
```

This executes, in order:

- `audit-roster` — selects cross-Story audit lenses over the combined landed
  tip and posts `plan-run-audit-roster` on the primary Story; the host MUST
  walk each listed lens against the combined diff.
- `follow-up-rollup` — friction follow-ups across every Story in the run
  (files issues when auto-file is on; posts `follow-ups`).
- `sibling-coherence` — Spec/Acceptance coherence check across sibling bodies
  (`plan-run-sibling-coherence`).

A single-Story run skips the epilogue — follow-ups are captured on merge
confirm instead (`captureStoryFollowUps`).

## Ceremony (profiles + two scopes)

Ceremony depth is selected by `delivery.routing.ceremonyProfile`
(`minimal` | `standard` | `strict`, default `standard`) and the **change level
derived from the Story's own diff** — the changed files' intersection with the
sensitive-path classes in `audit-rules.json`
(`review-depth.js#deriveChangeLevel`), not a planner-authored verdict
(Story #4542):

| Profile | Acceptance critic | When to use |
| --- | --- | --- |
| `minimal` | Always inline | Tiny trusted N=1 Stories |
| `standard` | Derived-level routed (+ sampling floor) | Default |
| `strict` | Always fresh-context | High-assurance / regulated surfaces |

| Scope | What runs | Mechanism |
| --- | --- | --- |
| **Per-Story (always)** | Gates, branch discipline, close-and-land | `deliver-story` / `single-story-close` |
| **Per-Story (profile + derived level)** | Acceptance critic mode; review depth | `ceremony-routing.js` + `review-depth.js` + `code-review.js` |
| **Per-run (N>1)** | Audit roster · follow-up roll-up · sibling coherence | `plan-run-epilogue.js` once at run end |
| **Per-Story land tail** | Follow-up capture · status resync · ref cleanup · base fast-forward | `single-story-close/phases/post-land.js` (in-process, per-step reported) |

## Async merge-confirm mode (`delivery.mergeWatch.mode: "async"`, Story #4698)

A slow-CI consumer can opt the close into `"async"` mode so the merge wait
probes once for ~60s (catching an instant merge or an instantly-red required
check) and then returns `pending` instead of burning ~5 minutes of the host
tool slot polling a merge that lands after the wait would have expired anyway.
When a worker returns that `pending` envelope, launch its `nextCommand` as a
**background** invocation (host background Bash — its completion re-invokes the
agent) and move on to the next Story; `single-story-confirm-merge.js` is
idempotent and owns the whole tail. Do not foreground-poll the merge. The
default `"sync"` behaviour is unchanged.
