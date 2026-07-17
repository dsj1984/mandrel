# Code Quality Guardrails — Helper

Single source of truth for the **numeric coding-time rules** every workflow in
this framework cites. Reviewers, prescriptive auditors, and writing agents all
read the same numbers from here so a "high cyclomatic complexity" finding in
`/audit-clean-code` and a pre-commit refusal cite the same threshold.

> Tunable via `delivery.quality.codingGuardrails` in `.agentrc.json` —
> see [`agentrc-reference.json`](../../docs/agentrc-reference.json) for the framework
> defaults and [`schemas/agentrc.schema.json`](../../schemas/agentrc.schema.json)
> for the validated shape. Override per-project; never fork this helper to
> change a number.

## At-keyboard verification

Run [`npm run quality:preview`](../../../package.json) before committing
on any Story that touches production source. The preview runs
`quality-preview.js`, which scopes the diff to `HEAD` by default (the
alias passes no `--changed-since`; the script defaults to `HEAD`) and
exercises the same maintainability and CRAP engines (`escomplex` +
`c8` coverage) that
`check-baselines.js` enforces at merge time, then merges the results
into a single per-file delta table. A clean preview means the commit
will not bounce off the unified baselines gate. The `.husky/pre-commit`
hook calls the same script.

## Cyclomatic ceilings

Cyclomatic complexity (CC) is measured per function by `escomplex` (the same
engine the maintainability axis of `check-baselines.js` runs). Two
thresholds, sourced from
`delivery.quality.codingGuardrails.cyclomaticFlag` /
`cyclomaticMustFix`:

| CC range | Action |
| --- | --- |
| ≤ 8 | Pass — no annotation required. |
| > 8 (default `cyclomaticFlag`) | **Flag** in review: explain why, or split. The function is allowed to land but the audit report names it. |
| > 12 (default `cyclomaticMustFix`) | **Must-fix**: refactor before the Story commits. `quality:preview` reports it as a violation; the close-validation chain refuses the merge. |

A common refactor that pulls a 13-CC function under 8 is extracting the early-
return guard chain into a named predicate, then collapsing the remaining
switch into a lookup table.

## Sibling-test convention

Every commit that adds a new public method or exported function in `src/`
must add a sibling test in the **same commit**. The test lives next to the
source under `tests/<mirrored-path>/<basename>.test.js`. Same-commit pairing
keeps the bisect honest — a regression and the test that would have caught
it land or revert together.

When `delivery.quality.codingGuardrails.requireSiblingTest` is `true`,
the pre-commit hook refuses to commit a staged new source file that
lacks a sibling test. Default is `false` so legacy repos opt in
deliberately; once enabled, the structural check replaces the
review-time prose rule.

## Maintainability-Index drop refactor rule

Per-file Maintainability Index (MI) is tracked in
[`baselines/maintainability.json`](../../../baselines/maintainability.json).
A commit that drops a file's MI by more than the configured
`delivery.quality.gates.maintainability.tolerance` (default `0.5` points)
requires a refactor in the same Story — not a baseline bump. `tolerance` is
the single MI-drop control: it is not a noise filter beneath a separate
must-refactor ceiling — any drop past it is treated as a regression that
must be undone or offset, not absorbed. Set `tolerance` higher only when the
project deliberately wants a looser MI-drop budget.

`quality:preview` shows the per-file MI delta in the working tree before
the commit lands (scoped to `HEAD` by default — the alias passes no
`--changed-since`; the script defaults to `HEAD`).

## Rename = baseline-refresh

Renaming a file (or moving it across `src/` directories) detaches its MI and
CRAP history from the baseline keys. The correct response is a **baseline
refresh**, not a regression entry: include `baseline-refresh:` (the
`delivery.quality.crap.refreshTag` default) in the commit subject so the
ratchet treats the new key as a clean entry instead of comparing it to
nothing.

The same convention applies when a method's name changes within a file —
escomplex keys CRAP rows on `<file>::<methodName>`, so a rename produces a
phantom new method + a phantom deleted method. Use the refresh tag to
suppress the noise.

## When a number changes

Update three places **in the same commit**:

1. `delivery.quality.codingGuardrails.<key>` in
   [`agentrc-reference.json`](../../docs/agentrc-reference.json).
2. The matching schema bound in
   [`schemas/agentrc.schema.json`](../../schemas/agentrc.schema.json) and the
   AJV mirror in
   [`scripts/lib/config-settings-schema.js`](../../scripts/lib/config-settings-schema.js).
3. The threshold cell or sentence in this helper.

The drift test (`tests/config-schema-mirror-drift.test.js`) catches schema
divergence between the JSON mirror and the AJV runtime; the helper-prose
drift is caught by `audit-clean-code` and `agent-protocol` linking back here
rather than restating the numbers.
