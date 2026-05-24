---
name: introducing-a-baseline-gate
description:
  Land a new CI check that asserts on a body of pre-existing state
  (doc-drift, lint-vocabulary, dependency-cycle, missing-test-coverage,
  unused-export). Use when introducing a gate whose first run would
  surface latent findings — the introducing Story MUST guarantee the
  gate exits 0 at merge, not just that the cited discrepancies pass.
---

# Skill: Introducing a Baseline-Style Gate

## Policy Capsule

- A new check that asserts on pre-existing state MUST exit 0 at merge time. Wiring the gate into CI without proving it's green ships a red gate that blocks every downstream Story.
- "The cited discrepancies are fixed" is **not** the AC. The AC is **"the gate exits 0 against the full repository on the merge commit"** — write it in the Story body in those words.
- Choose one of two landing shapes before you write the AC: **advisory-first** (gate exits 0 with warnings; a follow-up Story flips it to blocking) or **populate-the-baseline** (the introducing Story fixes every existing finding in the same PR, or writes them to an ignore-list / baseline snapshot the gate respects).
- Run the gate against `main` (or `epic/<id>`) **before** writing the AC. The findings count it surfaces is the scope of what landing-green will cost.
- Wire the gate into `.agentrc.json` `github.branchProtection.requiredChecks` in the **same PR** that ships the gate's first green run — never split "add the check script" from "make it required".
- Never land a gate red and rely on a follow-up Story to populate the baseline. The window between merge and the follow-up landing blocks every Story in flight.

## When to reach for this

Reach for this skill whenever you're introducing a check whose **first
run on the existing codebase would surface findings you didn't author**.
That includes (but is not limited to):

- **Doc-drift gates** — `check-lifecycle-doc-drift.js`, "docs/X.md must
  enumerate every Y in `src/Y/`", "README badge list must match the CI
  workflow file list".
- **Lint-vocabulary gates** — "no `TODO` without an issue link", "every
  exported function must have a JSDoc summary", "every `agent::*` label
  must appear in `label-constants.js`".
- **Dependency-cycle / boundary gates** — "no import from `app/` into
  `lib/`", "no cycle in module graph", "every workspace dep declared at
  the right `package.json` level".
- **Coverage-shape gates** — "every public API surface in
  `tests/contract/**` has at least one negative-path test", "every
  feature flag defined in `flags.ts` is referenced".
- **Baseline-numeric gates** — Lighthouse / bundle-size / CRAP first
  introduction. (For the numeric-ratchet shape specifically, also read
  `stack/qa/lighthouse-baseline`.)

If the check only fires on **new** code (e.g. a lint rule wired with
`--cache` against the diff, or a hook scoped to staged files), this
skill is not required — there's no latent-state landmine.

## The Trap (Why This Skill Exists)

**Epic #2880, Wave 1.** Story #2895 introduced
`check-lifecycle-doc-drift.js` — a gate that asserts every entry in the
project's lifecycle event registry has a matching row in
`docs/LIFECYCLE.md`. The Story's AC required correcting 3 cited
discrepancies and adding 2 new event rows. The gate landed wired into
CI. The first CI run on the **next** Story (#2898) reported **11
pre-existing drift findings** — drift that had been latent for months,
silent because no gate enforced it.

Stories #2898 and #2900 were both blocked. A hotfix commit on
`epic/2880` (5e3ef962) had to populate the full listener table before
wave 1 could merge. The cost was a half-day of wave-1 wall-clock and
two interrupted Stories.

**The diagnosis:** the introducing Story's AC was scoped to "fix what
we cited", not "the gate is green". Those are different ACs. The
second one is the load-bearing one.

This skill exists so the next drift-style gate doesn't replay that
pattern.

## Two Landing Shapes — Pick One Before AC Authoring

### Shape A: Advisory-First (exit 0 + warnings)

Land the gate as **non-blocking** in the introducing Story. The script
exits 0 even when findings exist, but prints them as warnings (and
optionally posts them as a PR comment). A follow-up Story drives the
findings count to zero, then flips the gate to blocking
(`process.exit(1)` on finding-count > 0) and adds it to
`requiredChecks`.

**When to choose this shape:**

- The existing-state findings are numerous (10+) and a one-shot fix
  would balloon the introducing Story's scope.
- The findings need per-finding owner triage (each row is a different
  module's bug).
- You want the warnings to surface in PRs immediately so contributors
  can fix-as-they-touch.

**Required AC line:**

> "The gate runs in advisory mode (exits 0 with warnings on the full
> repo). The follow-up Story #<NNN> flips it to blocking."

The follow-up Story MUST exist as a real ticket on the board before the
introducing Story closes — otherwise "follow-up" is a euphemism for
"never".

### Shape B: Populate-the-Baseline (exit 0 from day one)

The introducing Story includes the work to drive existing findings to
zero. Two sub-shapes:

1. **Fix-them-all.** Edit the docs / add the missing tests / break the
   cycles. The PR diff includes the gate code **and** the
   findings-resolution diff. The first CI run is green.
2. **Snapshot-as-baseline.** Write the current findings to a committed
   ignore-list (`baselines/<gate>-ignore.json`) that the gate reads at
   startup. The gate exits 0 when the only failures are in the ignore
   list, and exits non-zero on any **new** finding. A follow-up Story
   shrinks the ignore list to empty.

**When to choose this shape:**

- The findings count is small (≤ 10) and tractable in one PR.
- Or: the findings reflect real bugs that should be fixed, not papered
  over.
- Or: an ignore-list snapshot is a meaningful artifact (it answers
  "what's our drift debt right now?").

**Required AC line:**

> "On the merge commit, `<gate-script>` exits 0 against the full
> repository. The gate is wired into `requiredChecks` in this PR."

## Pre-Authoring Step: Run the Gate Against `main`

**Before** writing the AC, run the gate script against `main` (or
`epic/<id>`) locally and count the findings.

```bash
# In the introducing Story's worktree, with the gate script written:
node .agents/scripts/<new-gate>.js
echo "exit=$?"
```

That number — the **pre-existing finding count** — is the budget the
Story is choosing to spend. Write it in the Story body:

```text
## Pre-existing finding count (as of <SHA>)
- N findings on main / epic/<id>
- Landing shape: <Advisory-First | Populate-the-Baseline:fix |
  Populate-the-Baseline:snapshot>
```

If you skip this step you are gambling that the count is zero. It
isn't, that's why you're adding the gate.

## AC Checklist for a Drift-Style Gate Story

Copy this checklist into the Story body. Every line MUST appear:

- [ ] The gate script (`<path>`) exists and runs locally.
- [ ] The pre-existing finding count on `<base-branch>` is documented
      in the Story body.
- [ ] The landing shape (Advisory-First / Populate-fix /
      Populate-snapshot) is named in the Story body.
- [ ] If Advisory-First: the follow-up Story (#<NNN>) exists on the
      board with `type::story` and a link from this Story.
- [ ] On the merge commit, the gate exits 0 against the full
      repository (logs attached to the close comment).
- [ ] The gate is wired into `.agentrc.json`
      `github.branchProtection.requiredChecks` (Populate-shape) **or**
      explicitly marked advisory (Advisory-First).
- [ ] CI on the introducing PR shows the gate green.

## Anti-patterns

- **"The AC just says fix the cited cases."** The cited cases are the
  spark that surfaced the need for the gate. The AC must cover the
  whole forest, not just the tree the operator was standing under.
- **"We'll wire it in now and clean up the drift in a follow-up."**
  Every Story merged between "wire in" and "clean up" is blocked.
  That's a wave-stopper, not a follow-up. Either populate-now or
  advisory-now — never blocking-now-with-debt.
- **"It's green locally, ship it."** Local environments routinely have
  uncommitted state that the gate accepts. Verify against the **base
  branch tip**, not `git status`-clean working tree.
- **"The hotfix commit on the integration branch counts as cleanup."**
  It counts as a Story-2895-class debt: the gate is green on
  `epic/<id>` only because someone manually populated the gap.
  Codify the populate work as scope of the introducing Story instead.
- **No follow-up Story for Advisory-First.** "Advisory forever" means
  the gate is decoration. Either commit to flipping it or don't ship
  the advisory version.

## Cross-references

- **`stack/qa/lighthouse-baseline`** — for the **numeric-ratchet**
  flavour of baseline gate (a number with a tolerance band that
  ratchets only with intent). That skill's `--self-test` and
  weekly-cadence patterns complement this one's landing-shape
  patterns; the two skills cover orthogonal concerns (number-shape
  vs. land-green).
- **`core/baseline-refresh`** — once the gate exists and is blocking,
  this skill governs how an intentional drift in the baseline is
  refreshed without bypassing the gate.
- **`core/ci-cd-and-automation`** — generic CI-pipeline conventions
  (gate ordering, no-skip rule, branch-protection wiring) that this
  skill specialises for the latent-state case.
- **`.agents/rules/git-conventions.md` § Contract Cutovers** — a
  drift-style gate is itself a contract cutover (the contract is "the
  artifact and the source agree"). The hard-cutover policy applies:
  land green in one PR, don't ship two-shape tolerance.
- **Source incident:** Epic #2880 friction note **F-W1-1**
  (LIFECYCLE.md drift exposure), hotfix
  [`5e3ef962`](https://github.com/dsj1984/mandrel/commit/5e3ef962),
  Stories
  [#2895](https://github.com/dsj1984/mandrel/issues/2895),
  [#2898](https://github.com/dsj1984/mandrel/issues/2898),
  [#2900](https://github.com/dsj1984/mandrel/issues/2900).
