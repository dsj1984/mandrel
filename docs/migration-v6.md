# Migrating to v6.x

This document tracks operator-facing migration notes for the v6 release
line. Each minor version that introduces operator-visible discontinuities
gets its own section; patch releases without a discontinuity are not
listed here (see [`docs/CHANGELOG.md`](CHANGELOG.md) for the full
release log).

---

## v6.1.0

### Baseline reset

The v6.1.0 release ships a one-time reset of the
`baselines/coverage.json`, `baselines/maintainability.json`, and
`baselines/crap.json` files. The ratchet now compares against fresh
snapshots taken from the post-remediation `main` HEAD; the new baseline
is **not comparable** to v5.x or v6.0.0 entries.

See
[`docs/quality-gates.md` § v6.1.0 baseline reset](quality-gates.md#v610-baseline-reset)
for the rationale, the captured commit sha, and the policy on diffing
per-file numbers across the discontinuity. Operator action: none — the
reset is committed and the gates pass against the new floor out of the
box.

> If `docs/migration-v6.md` is updated by other v6.1.0 work (sibling
> Stories under Epic #1653 may extend this section with additional
> migration notes), the baseline-reset entry above remains the
> canonical reference for the quality-gate side of the v6.1.0 cutover.
