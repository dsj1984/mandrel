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

Read `stories[].dispatchMode` from the `resolve-stories.js` envelope.
`inline` names one indivisible resource — **the router's own session** — so one
rule produces it:

1. **Run topology.** A run resolving **one** Story is `inline` whatever its
   shape — sub-agent isolation only matters against a *concurrent* sibling
   racing the same checkout, and a one-Story run has none.
2. **Every other run is `subagent`.** A multi-Story run dispatches every Story
   as a sub-agent however trivial its shape. Shape still sets ceremony; the
   `route::lite` label is a human-visible hint, never the control signal.

`inline` removes model-side fan-out only — no `story-worker` boot, no fresh
acceptance-critic spawn. **`subagent` and `inline` run the same engine**: same
gates, same PR to `main`, same terminal envelope, byte for byte.

## 2. Engine invariants

| Trait | Contract |
| --- | --- |
| Ticket type | `type::story` only; an `Epic: #N` footer means **stop and re-plan** |
| Branch | `story-<id>`, seeded from `project.baseBranch` (`main`) |
| Merge target | `main` via PR (squash + required checks) — never a direct push |
| Gates | Every close gate runs regardless of route; no route bypasses one |
| State | Only via `update-ticket-state.js --ticket <id> --state <state>` |
| Paths | Prefix every path-based tool with the absolute `workCwd` — `cd` does not scope them |

**Land or block.** Worktree → `story-<id>` → close-validation → PR to `main` is
the only sanctioned landing. A silent local build is not a delivery.

## 3. Change set — computed once, handed to everyone

One enumeration per Story. A critic that re-runs its own `git diff`
can score a different set than the one that routed it. Both routing calls take
a single options object and are **total — they never throw**, so a wrong-shaped
argument is silently absorbed into the `null` fail-safe:

```bash
node --input-type=module -e '
  const lib = "<main-repo>/.agents/scripts/lib/orchestration";
  const { computeChangeSet } = await import(`${lib}/change-set.js`);
  const { deriveChangeLevel } = await import(`${lib}/review-depth.js`);
  const { resolveCeremonyForRisk } = await import(`${lib}/ceremony-routing.js`);
  const { files } = computeChangeSet({ baseRef: "main", headRef: "story-<storyId>" });
  // deriveChangeLevel({ changedFiles, injectedRules?, selectSensitivePathClassesFn? })
  //   -> { level, classes } — an OBJECT, never a bare level.
  const { level, classes } = deriveChangeLevel({ changedFiles: files });
  // resolveCeremonyForRisk({ derivedLevel, clusterIndex?, freshCriticSampleRate?,
  //   ceremonyProfile? }) -> { mode, reason, sampled, profile, verdictOwner }.
  // derivedLevel is that level STRING — the object above matches no tier and
  // routes to the null fail-safe: a fresh critic, silently.
  const ceremony = resolveCeremonyForRisk({ derivedLevel: level, clusterIndex: 0 });
  console.log(JSON.stringify({ files, level, classes, ...ceremony }));
'
```

Level rules ([`review-depth.js`](../../scripts/lib/orchestration/review-depth.js)):
a sensitive path registered in `audit-rules.json` → `high`, none → `low`, an
unenumerable diff (`files === null`) → `null`. Ceremony rules
([`ceremony-routing.js`](../../scripts/lib/orchestration/ceremony-routing.js)):
`minimal` → always inline, `strict` → always fresh, `standard` → `high`/`null`
→ fresh and `low` → inline unless the `freshCriticSampleRate` floor forces
fresh. An `inline` dispatch mode overrides all of it to inline critics. Close's
`review-depth.js` reads the same derived level, so the two cannot disagree.

## 4. Acceptance self-eval (Step 1a, required)

**One verdict-owner per cluster** — the fresh critic *or* the inline
self-eval, named by `verdictOwner`, never both and never a warm-up pass. Each
scores its cluster's `acceptance[]` items against the change set above, with
`verify[]` output as evidence. Bounded by `delivery.acceptanceEval.maxRounds`
(default 2).

**One round = N cluster critics → ONE merged verdict → ONE gate call.** Merge
every cluster's records into a single `criteria[]` in `acceptance[]` order, one
per acceptance item, and score that once. A gate call per cluster spends a
round *per cluster* and races the round ledger:

`node <main-repo>/.agents/scripts/acceptance-eval.js --story <storyId>
--verdict <merged-verdict-path> --expected-criteria <acceptance[] count>`

Pass `--expected-criteria` — **without it the coverage assertion is inert**, so
an unmerged cluster verdict scores a fraction of the criteria and still reports
`proceed`. A mismatch is rejected before scoring and costs no round.

`proceed` → close. `redraft` → one more round inside the cap. `block` → **do
not close**: post a `friction` comment and flip `agent::blocked`.
Per-round mechanics: [`acceptance-self-eval.md`](acceptance-self-eval.md).

## 5. The one creditable full-suite run

**After the self-eval loop's last fix commit, immediately after the push** —
the credit is keyed on the tree, not push state: a later commit voids it, a
push does not, and the backgrounded capture (below) ends the turn. Redraft
rounds run scoped tests; only this run needs credit, and a bare `npm test` /
`pnpm run test` deposits **none**, so close re-runs it. Shape it by what
`close-validation/gates.js` runs:

```bash
# CRAP gate on (default) + a `test:coverage` script — writes close's stamp:
node <main-repo>/.agents/scripts/coverage-capture.js --cwd <workCwd>
# otherwise — the record close's `test` gate reads; <workCwd> ABSOLUTE,
# runner exactly `npm test` (both sides hash {cmd, args, cwd}):
node <main-repo>/.agents/scripts/evidence-gate.js --standalone \
  --scope-id <storyId> --gate test --worktree <workCwd> -- npm test
```

Dispatch it in the **background**: it outruns the host's sync Bash ceiling, and its completion re-invokes you. Never spawn a task to poll or
`sleep`-loop against it ([`parallel-tooling.md`](parallel-tooling.md)
Rule 2).

Read the **output**, not the exit code: capture skips — no test run, no
credit — when nothing changed under CRAP `targetDirs`. Run the scoped
projects for the roots you changed plus `verify[]`, not the whole suite.

`verify[]` is scoped entries **plus** this one run: an entry that is itself a
full-suite command is reported credited against the same stamp, never
respawned.

## 6. Terminal envelope — the return contract

`single-story-close.js` emits exactly one envelope on stdout between
`--- STORY DELIVER TERMINAL ---` markers, schema-validated against
[`story-deliver-terminal.schema.json`](../../schemas/story-deliver-terminal.schema.json)
— the SSOT; read the JSON only when you need a field this table omits.
Relay it verbatim; never hand-compose one, never substitute prose.

| `status` | Exit | Meaning | You do |
| --- | --- | --- | --- |
| `landed` | 0 | PR merged, `agent::done`, tail ran (`tail.*: false` degrades the report, not the land) | Relay it. Done. |
| `pending` | 3 | **Resumable, not a failure** — the bounded wait expired healthy, or a human owns the merge. Nothing was mutated. | Run `nextCommand`. |
| `blocked` | 1 | Hard block; `blocked.blockClass` names it | `checks-failed` → fix + resume; else relay |
| `failed` | 1 | A phase crashed; `phase` names which | Diagnose, fix, re-run close |

Required fields: `kind` (`story-deliver-terminal`), `storyId`, `status`,
`phase`, `elapsedSeconds`, `nextCommand`. `phase` is one of `init`,
`wrong-tree-guard`, `base-sync`, `close-validation`, `push`, `pull-request`,
`code-review`, `auto-merge`, `confirm-merge`, `post-land`, `done`. `gates`
reports every gate as `passed` / `failed` / `skipped` — a skipped gate is
reported, never omitted, so a missing gate is never read as a passing one.

**Gate output is captured, not streamed.** Close writes gate lines to
`temp/orchestration/close-gates-<storyId>.log` and reports a one-line digest on
success; a failed gate replays its tail inline. `AGENT_LOG_LEVEL=verbose`
restores live streaming.

## 7. When to leave this file

Unclear state / a re-run refusal → `deliver-recover.js --story <id>`
(read-only). Lease, sweep, worktree scope; sequencing, epilogue, checklist
threading → [`deliver-story-reference.md`](deliver-story-reference.md) and
[`deliver-reference.md`](deliver-reference.md). CI red after the PR opens →
[`rules/ci-remediation.md`](../../rules/ci-remediation.md).
