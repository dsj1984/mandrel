# Gates and Baselines — Reference (on-demand)

**Read this when** a refresh is actually in front of you and the Policy Capsule
in [`SKILL.md`](SKILL.md) does not settle it. The capsule is the contract; this
file is the roster, the per-kind command table, and the procedure.

## The baseline roster

`baselines/` holds one snapshot per gate kind. What is present here is what
`check-baselines.js` and its siblings enforce:

| Baseline | Enforced by |
| --- | --- |
| `coverage.json` | `npm run coverage:check` |
| `crap.json` | `npm run crap:check` |
| `maintainability.json` | `npm run maintainability:check` |
| `duplication.json` | `npm run duplication:check` |
| `dead-exports.json`, `dead-exports-production.json` | `check-dead-exports.js` |
| `arch-cycles.json` | `npm run check:arch` |
| `cyclomatic.json` | `npm run check:cyclomatic` |
| `context-budget.json` | `npm run check:context-budget` |
| `agents-loc.csv` | `npm run baseline:agents-loc` |

A refresh is **not** a regression entry — it tells the ratchet that the new
baseline key is intentional, so the gate compares future runs against the
refreshed snapshot rather than the prior one.

**When to refresh:** a file rename/move detached an MI/CRAP key; a method
rename inside a file produced a phantom new + phantom deleted key (escomplex
keys CRAP rows on `<file>::<methodName>`); an operator-approved complexity bump
or perf delta needs to be enshrined as the new floor; a dead-export gate
flagged a signed-off API-surface change. If the underlying change is an
**unintentional** regression, do not refresh — remediate first.

## Per-kind refresh commands

| Kind            | After a code change (diff-scoped)  | Stale baseline (full re-anchor)      |
| --------------- | ---------------------------------- | ------------------------------------ |
| CRAP            | `npm run crap:update`              | `npm run crap:reanchor`              |
| Maintainability | `npm run maintainability:update`   | `npm run maintainability:reanchor`   |
| Coverage        | `npm run coverage:update`          | `npm run coverage:reanchor`          |
| Duplication     | `npm run duplication:update`       | `npm run duplication:reanchor`       |
| Dead-exports    | `npm run dead-exports:update` (regenerates both passes; never hand-edit the JSON) | same — no scope flag applies |
| Cyclomatic      | `npm run cyclomatic:update`        | same — no scope flag applies         |
| Context budget  | `node .agents/scripts/check-context-budget.js --update` | same — no scope flag applies |

## Procedure

1. **Run the matching command for your reason** — left column after a code
   change, right column for a stale baseline — on the Story branch (HEAD must
   already be the Story branch, not `main`).
2. **Verify the diff is scoped** to the relevant `baselines/<kind>.json` (and
   possibly cosmetic `package-lock.json` churn). Unrelated files → STOP, the
   refresh is contaminated. Judge contamination by **which files** changed, not
   how many rows moved inside the baseline: a `:reanchor` legitimately rewrites
   most of its own file, so say in the commit body that the breadth is a
   re-anchor and not a mass regression.
3. **Author the commit.** Stage the baseline file(s) explicitly, then commit
   with the Conventional-Commits subject the capsule pins, plus the body and
   trailers:

   ```bash
   git add baselines/<kind>.json
   git commit -m "$(cat <<'EOF'
   <the refresh subject the Policy Capsule pins>

   <body: what changed, why the new floor is correct, linking the Story.>

   baseline-refresh: true
   Story: #<storyId>
   EOF
   )"
   ```

   Do NOT pass `--no-verify`.
4. **Re-run the gate** — `node .agents/scripts/check-baselines.js`. If it still
   fails, a sibling kind drifted; repeat from step 1 for that kind.

The `baseline-refresh: true` body trailer — not a subject-level token — is the
canonical machine-readable marker for a refresh commit; the decision and its
history are recorded in
[`docs/decisions.md` ADR 20260906-5160b](../../../../docs/decisions.md).

## Red Flags

- CI failures ignored or silenced; tests disabled in CI to make the pipeline
  pass.
- A new required gate merged red on pre-existing findings, blocking every
  downstream PR.
- A legacy ad-hoc leading token (`baseline-refresh:`) as the commit subject
  type.
- An empty-body refresh — unreviewable, hides the operator decision.
- A refresh commit whose diff touches unrelated files (contaminated refresh).
- Refreshing to paper over an unintentional regression.

## Verification

- [ ] Any newly introduced gate is green at merge (advisory-first or
      baseline-in-same-change).
- [ ] A baseline refresh uses the pinned subject + non-empty body +
      `baseline-refresh: true` trailer, staged explicitly, no `--no-verify`.
- [ ] `check-baselines.js` passes against the refreshed snapshot.
