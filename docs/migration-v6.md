# v6 migration guide (mandrel)

This is the **only doc** a v5 consumer needs to read to move to v6. v6 is
the **Mandrel rebrand + breaking-change cut** (Epic #1184). It is a
**major-boundary** release: the package name, submodule URL, quality-gate
contract, and `.agentrc.json` schema all change shape.

If you are upgrading a consuming repository from v5.x → v6.x, read this
file once before bumping the `.agents/` submodule pin or the npm
dependency.

---

## What changed (TL;DR)

| Surface | v5 | v6 | Scripted? |
| --- | --- | --- | --- |
| Package name | `agent-protocols` | **`mandrel`** | yes — `migrate-to-v6.js` rewrites `package.json` deps |
| Submodule URL | `…/agent-protocols(.git)` | `…/mandrel(.git)` | yes — `migrate-to-v6.js` rewrites `.gitmodules` |
| `.agentrc.json` keys | flat / legacy positions | flat `orchestration.concurrency.*` etc. | yes — `migrate-to-v6.js` applies the v5→v6 keymap |
| `.agentrc.json` schema | partial `additionalProperties` | **`additionalProperties: false` everywhere** | manual — unknown keys now throw |
| Quality gates | per-file **ratchet** only | ratchet **+ absolute floor** (90/85/90 lines/branches/functions, MI ≥ 70, CRAP ≤ 20) | partial — gate ships; below-floor files block their own pushes |
| Baselines (coverage / MI / CRAP) | v5 history | **fresh v6 snap** — not numerically comparable | manual — re-snap your own baselines after upgrade |
| `VERSION` | `5.41.0` | **`6.0.0`** | n/a — published with the release |
| `npm pack` artifact | `agent-protocols-5.x.tgz` | **`mandrel-6.0.0.tgz`** | n/a |
| Live `CHANGELOG.md` | mixed 4.x / 5.x history | starts at v6 (`archive/CHANGELOG-pre-v6.md` holds pre-v6) | already done in the repo |
| `.agents/` directory name | `.agents/` | **unchanged** — preserved by design | n/a |
| `.agentrc.json` filename | `.agentrc.json` | **unchanged** — preserved by design | n/a |
| Slash-command catalog | mixed names | audited + `/mandrel` discoverability | already done in the repo |

Two principles to keep in mind while reading the rest:

1. **`.agents/` and `.agentrc.json` are stable.** v6 keeps both names so
   consumers do not have to `git submodule deinit` + re-add. Only the
   *remote* the submodule points at changes — the on-disk path stays put.
2. **Every mechanical change is scripted.** `migrate-to-v6.js` is the
   one command a consumer runs. Anything it cannot do is collected in
   the **manual residue checklist** below.

---

## How to migrate (running `migrate-to-v6.js`)

From your consumer repo root, on a **clean working tree**:

```bash
# 1. Pin your .agents/ submodule (or your npm dep) at the v6 tag.
#    Submodule consumers: bump the SHA in .gitmodules / superproject pin
#    to the first v6 commit, then `git submodule update --init`.
git submodule update --remote .agents

# 2. Dry-run first to see the plan.
node .agents/scripts/migrate-to-v6.js --dry-run

# 3. Apply.
node .agents/scripts/migrate-to-v6.js

# 4. Re-run to confirm idempotency — should report zero changes.
node .agents/scripts/migrate-to-v6.js
```

The script:

- Reads `.agentrc.json`, `.gitmodules`, and `package.json` at the repo
  root (skips any file that does not exist).
- Rewrites legacy v5 keys per the v5→v6 keymap in
  [`lib/v5-to-v6-keymap.js`](../.agents/scripts/lib/v5-to-v6-keymap.js).
- Bumps the `.gitmodules` URL from `agent-protocols` → `mandrel`.
- Renames the package reference in your `package.json` dependency
  blocks (range preserved).
- Prints a per-section summary and a "Total changes" count. The second
  run on the same tree should report `alreadyV6` and write nothing.

Flags:

| Flag | Effect |
| --- | --- |
| `--cwd <path>` | Target a repo other than the cwd. |
| `--dry-run` | Compute the plan, print summary, write nothing. |
| `--yes` / `-y` | Proceed on a dirty working tree (use sparingly). |
| `--help` / `-h` | Print usage. |

The tool makes **zero network calls** and never writes outside the
target repo root.

---

## Manual residue checklist

`migrate-to-v6.js` covers the mechanical changes. The items below
require human judgement — work through them after running the script.

- [ ] **Re-snap your baselines.** v6 ships new baselines for the repo
      itself, but yours need a fresh capture against the v6 gate:
      ```bash
      npm run coverage:update
      npm run maintainability:update
      npm run crap:update
      ```
      Commit the regenerated `baselines/*.json`. Numbers will not be
      diffable against your v5 history; see the
      [Baseline reset](#baseline-reset-story-1602) section below.
- [ ] **Run the full-scope floor gate.** Before pushing v6 for the
      first time:
      ```bash
      npm run coverage:check -- --full-scope
      npm run maintainability:check -- --full-scope
      npm run crap:check -- --full-scope
      ```
      Every failure names the file, axis, current value, and floor.
      Decide per-file: add tests, refactor, or — if the file is a
      legitimate thin CLI shell whose logic lives in tested `lib/` —
      add an entry to your `.c8rc.cjs` exclude list with a one-line
      rationale and the `/* node:coverage ignore file */` pragma.
- [ ] **Confirm `.husky/pre-push` reflects the v6 layout.** The hook
      should run the ratchet calls first, then the three
      `--full-scope` floor calls. The audit suite spot-checks for
      accidental `--floor=off` on the hook — never wire it in.
- [ ] **Audit your `.agentrc.json` for unknown keys.** v6 sets
      `additionalProperties: false` on every nested object in
      `agentrc.schema.json`; an unknown axis now throws at config
      load. The migration tool only rewrites *known* legacy keys —
      truly bespoke keys you may have added by hand have to be
      reviewed manually. See [Schema tightening](#schema-tightening-epic-1184)
      below.
- [ ] **Verify `git submodule sync` resolves.** GitHub serves a
      redirect from the old `agent-protocols` repo URL to `mandrel`
      for web, `git clone`, and submodule sync — but the redirect is
      best-effort. If you maintain an internal mirror, update its
      upstream URL by hand.
- [ ] **Smoke-test on a throwaway branch first.** Run your own test
      and lint suites on the v6 pin in a branch before merging to
      `main`. The gate is strict by design.

---

## Deletion sweep (Epic #1184, Phase 1)

Epic F's Phase 1 explicitly drove **net-negative LOC** across the
repository:

- The `@deprecated`-marked carve-outs accumulated during Epics A–E
  were removed at the v6 boundary rather than being aliased forward.
  There are **no v5 → v6 compatibility shims** in the surface — every
  removed symbol is gone, not deprecated-with-warning.
- The obsolete checks from Epic #1143 (concurrent-close race, `npm
  test` `core.bare` flip, post-merge push cascade, stale
  `origin/epic/<id>`) were removed; the May 8 `withEpicMergeLock`
  landing made them impossible by construction.
- The scripts + commands surface was audited (`.agents/scripts/`
  ~50 files; `.claude/commands/` 33 commands). Unreferenced scripts
  and broken / orphaned commands were deleted. The new
  `/mandrel` discoverability workflow at `.agents/workflows/mandrel.md`
  prints the auto-generated Mandrel-owned catalog so consumers can
  distinguish project commands from Claude Code built-ins without
  forcing brand-prefixed names everywhere.
- Audit-tracked High findings (clean-code, performance, dependencies,
  security) were either remediated or carry an explicit follow-up
  issue with deferral rationale — no silent drops.

**Consumer impact:** if your code reached into any `@deprecated` v5
symbol, it will fail at import / load time on v6 with a clear
"undefined export" error. The cure is to move to the replacement named
in the matching v5 changelog entry (see
[`archive/CHANGELOG-pre-v6.md`](archive/CHANGELOG-pre-v6.md) for the
full pre-v6 history).

---

## Schema tightening (Epic #1184)

`agentrc.schema.json` already had `additionalProperties: false` at the
top level. v6 audits every nested object in the schema for the same
setting, and removes legacy fields the changelog had been trailing
(specifically, any residual runner-config keys deleted in the 5.40.0
flatten — see `archive/CHANGELOG-pre-v6.md` for the keymap).

What this means in practice:

- Unknown keys at **any** depth of your `.agentrc.json` now throw.
  Previously, a typo in a nested block could be silently ignored — v6
  fails fast at config load with the offending JSON path.
- Concurrency caps have already flattened to
  `orchestration.concurrency.*` (Epic #1178 — see the live
  `CHANGELOG.md` for the full keymap). `migrate-to-v6.js` rewrites
  these for you; any *hand-authored* unknown key is your call.

If your CI fails after the upgrade with a config validation error,
read the JSON path the validator reports and either:

- delete the key (if it was a typo or legacy residue), or
- move it under the correct v6 location (cross-reference the v5→v6
  keymap in [`lib/v5-to-v6-keymap.js`](../.agents/scripts/lib/v5-to-v6-keymap.js)).

---

## Quality-gate contract (Epic #1184)

v5 enforced **per-file ratchet** only: the gate failed when a metric
dropped below the recorded baseline for that file. It said nothing about
the absolute level — a file pinned at 60 % coverage or MI = 58 for years
sailed through every push.

v6 layers an **absolute floor** on top of the ratchet. The three
checkers (`check-coverage-baseline.js`, `check-maintainability.js`,
`check-crap.js`) all delegate to the shared
`lib/quality-floors.js#applyFloorPolicy` helper after their ratchet
decision, with the contract:

| Metric                  | v5      | v6 floor   |
| ----------------------- | ------- | ---------- |
| Coverage — lines        | ratchet | ≥ 90 %     |
| Coverage — branches     | ratchet | ≥ 85 %     |
| Coverage — functions    | ratchet | ≥ 90 %     |
| Maintainability Index   | ratchet | ≥ 70       |
| CRAP                    | ratchet | ≤ 20       |

The floor block is enabled **by default**. The only opt-out is the
`--floor=off` flag, used exclusively by the `*:update` baseline-snap
scripts (which need to record whatever the current numbers are without
regard to the floor).

See [`docs/quality-gates.md#absolute-quality-floors-v6--epic-1184`](quality-gates.md)
for the runtime details.

### Why this is a major-version bump

Two reasons make the v5 → v6 contract incompatible:

1. **Behaviour change for consumers.** A consuming repo whose tree was
   green on v5 can fail v6's gate on its very first post-upgrade
   `pre-push` even with no source changes, because in-scope files that
   were sitting below the new floors will now trip the gate.
2. **`.agentrc.json` schema growth.** v6 reads
   `agentSettings.quality.qualityFloors.*` (validated by
   `loadFloorConfig`) — an unknown axis throws. Consumers that author
   their own `.agentrc.json` may need to add an empty `qualityFloors:
   {}` block to inherit defaults or override specific axes.

---

## Baseline reset (Story #1602)

Story #1602 of Epic #1184 ships the floor gate and **re-snaps all three
baselines** to the post-remediation state of `main`. After the reset:

- `baselines/coverage.json` — 274 in-scope files, captured from
  `coverage/coverage-final.json` after the v6 `.c8rc.cjs` exclude prune
  (Task #1627 removed two stale entries whose source files had already
  been deleted).
- `baselines/maintainability.json` — 650 files scored by `escomplex`.
- `baselines/crap.json` — 1383 method-level rows, scored against the
  fresh coverage capture.

### The v5 → v6 discontinuity

The post-snap baselines are intentionally **the current state**, not
the v6-floor state. Numeric diffs against pre-v6 snapshots are
meaningless because:

- The `.c8rc.cjs` exclude list changed (smaller, two stale entries
  removed). Per-file numbers for the removed files are now real,
  whereas they used to be zeros.
- `lib/quality-floors.js` is new and shows up as a new baseline row.
- The MI calculator pinned its kernel version; pre-pin scores may
  drift by sub-1 MI on noisy files.

A direct comparison reports "everything changed." That is expected.
Diff-shaped triage (per-file regressions on `check-coverage-baseline`'s
`---changed-since origin/main` path) keeps working — the ratchet
half of the gate is unaffected by the reset.

### Files known to be below floor on first v6 push

The fresh snap also surfaced the v5 → v6 discontinuity in the other
direction: a number of pre-existing files in the agent-protocols
repository itself are **below the v6 absolute floor**. The floor gate
will fail on these the first time it runs full-scope (the `pre-push`
hook, the post-merge CI step, or `npm run *:check -- --full-scope`).

This is intentional. The Story #1602 charter is "wire the gate +
re-snap baselines"; clearing the in-tree below-floor files is sized as
follow-up Stories under Epic #1184 (one per cluster of related files).
Until those land, operators have two options for the agent-protocols
repo itself:

- **Recommended:** treat each below-floor file as a Sev-3 issue and
  refactor / add tests against the floor in a follow-up Story. The
  floor gate stays enforcing; below-floor files block their own
  pushes until they pass.
- **Escape hatch (use sparingly):** pass `--floor=off` on the offending
  checker invocation. The audit suite spot-checks for accidental
  long-lived `--floor=off` uses in `.husky/pre-push` and
  `.github/workflows/`. Never wire `--floor=off` into a default
  workflow — it defeats the entire gate.

The current below-floor inventory (as of 2026-05-13 snap) is:

**Coverage (lines/branches/functions vs 90/85/90):**

- `.agents/scripts/lib/worktree/lifecycle/creation.js` — lines 84.87, branches 83.33
- `.agents/scripts/lib/worktree/lifecycle/force-drain.js` — lines 87.68, functions 60.00
- `.agents/scripts/lib/worktree/lifecycle/gc.js` — branches 81.25
- `.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js` — lines 88.26, branches 78.57
- `.agents/scripts/lib/worktree/lifecycle/reap.js` — lines 85.46, branches 74.44
- `.agents/scripts/providers/github.js` — lines 83.78, branches 67.86, functions 82.35
- `.agents/scripts/providers/github/projects-v2-graphql.js` — lines 85.13, branches 82.18

**Maintainability Index (vs 70):**

- `.agents/scripts/lib/config-schema.js` — MI 59.46
- `.agents/scripts/lib/config-settings-schema.js` — MI 46.09
- `.agents/scripts/lib/orchestration/epic-cleanup.js` — MI 0.00
- `.agents/scripts/lib/orchestration/epic-deliver-close-tail.js` — MI 67.92
- `.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js` — MI 0.00
- `.agents/scripts/quality-watch.js` — MI 0.00

**CRAP (per method, vs 20):**

- `.agents/scripts/lib/worktree/lifecycle/reap.js#reap` — 27.69
- `.agents/scripts/lib/worktree/node-modules-strategy.js#installDependencies` — 22.30
- `.agents/scripts/lint-baseline.js#diffBaseline` — 28.37
- `.agents/scripts/lint-baseline.js#checkBaseline` — 53.47
- `.agents/scripts/providers/github.js#resolveToken` — 27.73
- `.agents/scripts/providers/github.js#classifyGithubError` — 210.00
- `.agents/scripts/providers/github/projects-v2-graphql.js#resolveToken` — 30.00
- `.agents/scripts/signals-view.js#parseArgs` — 20.21
- `.agents/scripts/story-close.js#runStoryCloseLocked` — 45.57

Each cluster will be addressed by a follow-up Story under Epic #1184.
The list above is the cross-check evidence for the close-out audit
trail; once a follow-up Story lands a fix, the line above moves to the
"Resolved" section of the relevant Epic retrospective.

---

## Upgrade checklist (consumer repos)

1. Bump the `.agents/` submodule pin (or the npm dependency) to the
   first v6 tag.
2. Run `node .agents/scripts/migrate-to-v6.js --dry-run` from your
   repo root, review the plan, then re-run without `--dry-run`.
3. Run `npm run coverage:check -- --full-scope`,
   `maintainability:check -- --full-scope`, `crap:check --full-scope`.
   Each failure names the specific file and metric. Decide for each:
   add tests, refactor, or — if the file is a legitimate thin CLI
   shell whose logic lives in tested `lib/` — add an entry to your
   repo's `.c8rc.cjs` exclude list (with rationale + pragma, per
   [`docs/quality-gates.md`](quality-gates.md#no-silent-excludes-c8rccjs-policy)).
4. Re-snap your own baselines via the `*:update` scripts once the tree
   is clean.
5. Confirm `.husky/pre-push` reflects the v6 hook layout (ratchet calls
   first, then the three `--full-scope` floor calls).
6. Work through the [Manual residue checklist](#manual-residue-checklist)
   above and tick each item.
