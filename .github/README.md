# `.github/` — repository automation surface

## `ruleset.json` — branch-protection snapshot (NOT the enforcement source)

[`ruleset.json`](./ruleset.json) is a **committed snapshot** of the
`Protect Main` repository ruleset (id `14286998`). It documents the
intended branch-protection contract for `main` so the required-check set is
reviewable in version control.

> **Committing this file does not change enforcement.** The live ruleset is
> the only enforcement source. After editing `ruleset.json`, an operator
> MUST re-apply it out-of-band via `gh api` or the GitHub UI:
>
> ```bash
> gh api \
>   --method PUT \
>   repos/dsj1984/mandrel/rulesets/14286998 \
>   --input .github/ruleset.json
> ```
>
> (or paste the updated `required_status_checks` into
> **Settings → Rules → Rulesets → Protect Main** in the GitHub UI).

### Required status-check contexts

The `required_status_checks` contexts MUST match the live CI job names and
the documented gate set:

- `Validate and Test` — the `ci.yml` `validate` job (de-matrixed in
  PR #1348; the former `(ubuntu-latest, node 22)` matrix suffix no longer
  exists).
- `baselines` — the `ci.yml` `baselines` job.
- `install (npm / ubuntu-latest)` and `install (yarn / windows-latest)` —
  the two **Install Matrix** gate legs
  ([`workflows/install-matrix.yml`](./workflows/install-matrix.yml)). Do
  **not** add the internal `select-matrix` plumbing job.

This set is cross-referenced by
[`.agentrc.json`](../.agentrc.json) `github.branchProtection.requiredChecks`
and the operator notes in
[`docs/release-operations.md`](../docs/release-operations.md)
(§ Install Matrix release gate) and `install-matrix.yml`. Keep all four in
sync when the check names change.
