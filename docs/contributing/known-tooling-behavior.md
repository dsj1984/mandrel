# Known Tooling Behavior

This rule applies when you are about to trust the output of a gate, a
baseline ratchet, or a local stand-in for a CI check — before pushing,
before declaring a check green, and before diagnosing a red one.

Each entry below records a **measured** behavior of this repository's own
tooling: a place where a command's visible output does not mean what it
looks like it means. Entries exist because each one has already cost a
delivery cycle.

## The entry bar

- An entry states behavior that was **measured against this repo**, never
  recalled and never assumed.
- Every entry carries a **reproduction command** that was actually run. If
  the command stops reproducing the behavior, **delete the entry** — do not
  annotate it. A stale entry is worse than a missing one, because it is
  trusted.
- Entries describe the observable behavior and the safe move. They never
  describe a way to bypass a gate, and recording a behavior here is not a
  decision to keep it.

## 1. `npm run lint` prints `Summary: 0 error(s)` and can still exit 1

**Behavior.** `npm run lint` is `run-lint.js`, which spawns eight tools
concurrently with inherited stdio and exits with the first non-zero code —
Biome, markdownlint-cli2, the lifecycle lint, the workflow-CLI lint, the
label-vocabulary lint, the workflow-timeout gate, the arch-cycle ratchet, and
the Gherkin corpus gate. `Summary: 0 error(s)` is **markdownlint-cli2's own
verdict**, not the aggregate — it is printed whether or not any of the other
seven failed. Because the tools run in parallel, that line can land anywhere
in the output, including last, so the tail of a failing run reads green.
Biome's format diagnostics are `error`-severity, so a file that only needs
reformatting fails the check while emitting no lint rule name at all.

**Reproduce.**

```bash
# a format-only diff is an error, not a warning
printf 'export const x = {a:1,   b:2};\n' | npx biome check --stdin-file-path=probe.js
echo "biome exit=$?"   # 1 — "The contents aren't fixed"

# and markdownlint's Summary line is unconditional
npm run lint 2>&1 | grep -c 'Summary: 0 error(s)'
```

**Safe move.** Trust the exit code, never the last line. When `npm run lint`
exits non-zero and you cannot see why, re-run `npx biome ci .` on its own —
`scripts/run-lint.js` lists every tool it fans out to. Fix formatting
with `npm run format`; never reach for `--no-verify`.

## 2. `check-baselines.js` is not the whole `baselines` check

**Behavior.** `.agentrc.json` declares the `baselines` required check as
`node .agents/scripts/check-baselines.js`, but that script only runs the
gates configured under `delivery.quality.gates` — currently **crap,
maintainability, and duplication**. CI's job named `baselines` in
`.github/workflows/ci.yml` runs that script **and then nine standalone
commands** the script knows nothing about, so a locally green
`check-baselines.js` is not evidence that the `baselines` check will pass.

| Command CI's `baselines` job runs | Covered by `check-baselines.js` | Covered by `npm run lint` | Covered by `npm run verify` |
| --- | --- | --- | --- |
| `check-arch-cycles.js` | no | **yes** | via `lint` |
| `check-dead-exports.js` | no | no | **yes** |
| `check-dead-exports.js --production` | no | no | **yes** |
| `check-context-budget.js` | no | no | **yes** |
| `check-workflow-citations.js` | no | no | **yes** |
| `check-cyclomatic.js` | no | no | **yes** |
| `check-schema-references.js` | no | no | **yes** |
| `check-knip-entries.js` | no | no | **yes** |
| `check-baseline-scope.js` | no | no | **no** |

`check-comment-policy.js` left this table when it moved out of the
`baselines` job into `npm run lint` (and the `pre-push` hook), so a
comment-ratio breach now fails at close instead of first in CI.

One is still in **no** local aggregate command — `check-baseline-scope.js`,
reachable only as its own npm script (`baselines:scope`) or a direct
invocation. `check-workflow-citations.js` joined `verify` when Story #5340
demoted it to a report; before that it was exempted because
`tests/check-workflow-citations.test.js` re-ran its ratchet through the `test`
step.

**Two of the nine cannot fail this job any more** (Story #5340, ADR
20260917-5340). `check-workflow-citations.js` prints a per-file provenance
count and always exits 0 — it reads no baseline at all, and the one it used
to ratchet against is deleted.
`check-context-budget.js` fails on the `alwaysLoaded` tier alone: its
`workflow` and `mandatoryRead` tiers are printed, and the per-file 8 KB
agent-boot ceiling and the row-vs-tree drift gate are gone. A green run of
either is therefore **not** evidence the numbers held — read the report. Both
ratchets used to fail a *rise*, so a prose fix had to be paid for with an
unrelated trim in the same commit; the always-loaded gate is the one that
stays because every session and every subagent spawn re-pays that closure.

`prune-baseline-orphans.js --check` left this table in v2.32.0: it no longer
runs in CI in any mode. It reports the same absent / out-of-scope rows as
`check-baseline-scope.js` but without merge-base attribution, so holding it in
the required job made the scope gate's inherited-divergence warning
unreachable — a stale row on `main` red every open PR regardless of who landed
it. It stays the operator's remedy, via `npm run baselines:prune`.

`check-context-budget.js` and `check-workflow-citations.js` additionally run in
`.husky/pre-push`, as reports. A shrink in the always-loaded closure no longer
reds anything either (Story #5313): it is reported, and the close's write-back
seam commits the lower total on the Story branch.

**Reproduce.**

```bash
node .agents/scripts/check-baselines.js --format text   # names the 3 gates it ran
sed -n '/name: baselines/,/windows-smoke/p' .github/workflows/ci.yml | grep 'js'
sed -n '/^const STEPS/,/^];/p' scripts/run-verify.js  # the steps verify covers
```

**Safe move.** `npm run verify` is the closest local mirror. Run
`npm run baselines:scope && npm run baselines:prune -- --check` alongside it
when the change adds, deletes or moves files inside a scored `targetDirs`
root. Reproducing only the `.agentrc.json` command before a push is a false
green.

## 3. The two dead-export passes disagree, and the production pass is silent without `!`

**Behavior.** `check-dead-exports.js` runs twice with two separate
baselines. The default pass treats `tests/**` as knip entry points, so an
export whose only importer is a test still reads as *used*; the
`--production` pass discounts test importers and therefore sees a much
larger surface — `baselines/dead-exports.json` carries 130 rows against
`baselines/dead-exports-production.json`'s 695. A new export that is only
imported by its test passes the default pass and fails the production one.

Rows come in two shapes. `{ file, symbol: '<name>' }` is one unused export;
`{ file, symbol: '*' }` is **whole-file death** — a module nothing imports.
Knip reports such a module once, under its `files` category, and suppresses
that module's per-export rows, so a file losing its last importer *shrinks*
the export row set. Reading only `exports` therefore scored losing a whole
module as an improvement; the `*` rows exist so it reads as the regression
it is. `knip.json` lists the `.agents/scripts` CLIs as explicit entry paths
for the same reason: a blanket `.agents/scripts/*.js!` glob declared every
top-level CLI reachable by construction, so no uninvoked one could ever
surface. Adding a CLI means adding its entry line.

The production pass depends entirely on the `!` suffix on the `entry` and
`project` patterns in `knip.json`: `!` marks a pattern as
production-relevant. Strip the suffixes and `knip --production` reports
**zero** export rows and exits clean — a green that means "nothing was
analyzed", not "nothing is dead".

**Reproduce.**

```bash
node .agents/scripts/check-dead-exports.js              # default pass
node .agents/scripts/check-dead-exports.js --production # strictly larger row set
grep -c '!"' knip.json                                  # the production markers
```

**Safe move.** Run both passes before pushing. When an export is genuinely
test-only, keep it and refresh both baselines deliberately with `npm run
dead-exports:update` — `scripts/update-dead-exports-baseline.js`,
which rewrites the rows knip currently reports and fails closed rather than
persisting an empty snapshot from a knip run that never worked. Never
hand-edit `baselines/dead-exports*.json`: a hand-written row set is the one
input no gate re-derives. `docs/contributing/test-seams.md` governs which seams
are sanctioned. Never remove the `!` suffixes from `knip.json` to quieten the
production pass.

## 4. A green pre-push is only evidence the two scopes agreed because `--ref` outranks config

**Behavior.** `.husky/pre-push` captures coverage and then scores it, both
against a literal `origin/main`. The CRAP half of `quality-preview.js` is a
function of complexity **and** coverage, so the preview is only reading its
own tree if the artifact under it was captured over the same change set.
Both steps resolve that set through **one** rule, stated once in
`resolveChangedFilesRef` (`.agents/scripts/lib/changed-files.js`): the ref the
caller named wins, and
`delivery.quality.gates.crap.incrementalCoverage.baseRef` is the default for a
caller that names none — the close-validation gate, which passes no `--ref`.
Both `coverage-capture` paths and the preview's CRAP baseline join call it, so
one hook invocation cannot resolve two refs.

Before Story #5365 the configured value outranked the flag. The preview has
no config ref to consult, so a consumer that set `baseRef` captured against
one ref while the preview scored another, and the preview could read an
artifact whose scope was not its own — the stale-artifact read the
capture-before-preview ordering (Story #5356) exists to prevent, reopened by
configuration rather than by editing the hook. **This repository sets no
`baseRef`**, so the divergence was invisible here: a green local run proved
nothing about a consumer's.

**Reproduce.**

```bash
node -e "import('./.agents/scripts/lib/changed-files.js').then(({ resolveChangedFilesRef }) => { const crap = { incrementalCoverage: { baseRef: 'develop' } }; console.log(resolveChangedFilesRef({ crap, ref: 'origin/main' })); console.log(resolveChangedFilesRef({ crap, ref: null })); })"
# → origin/main   (the hook's flag wins over a configured baseRef)
# → develop       (config still answers a caller that named no ref)
grep -n 'origin/main' .husky/pre-push   # the same literal on both steps
```

**Safe move.** Read a green pre-push as evidence about CRAP only when both
hook steps still carry the same literal ref. Moving one means moving the
other; adding another consumer of the change set means routing it through
`resolveChangedFilesRef` rather than reading `baseRef` directly.
