---
name: Windows CI per-file coverage gate flaps under Node 22
description: Tiny fractional branch-coverage deltas vary run-to-run on Windows CI; ratchet-from-artifact loops can chase the noise
type: feedback
originSessionId: 5ee8effd-2d88-4a5f-b708-2fc8bdcc8897
---

# Windows CI per-file coverage gate flaps under Node 22

The per-file coverage baseline gate in CI (Windows runner, Node 22) produces slightly different branch-coverage fractions across runs of the *same* commit — observed deltas in the ±0.5–3% range on small files. Refreshing `baselines/coverage.json` from one failing run's `coverage-final-windows-latest-node-22` artifact will fix that run's regression but a subsequent run can flap to a different file at the new baseline.

**Why:** Node 22 V8 instrumentation produces non-deterministic branch counts on tiny modules (~50–100 LOC) when scheduling/IO timing shifts microsecond-scale. Local Node 24 doesn't see this. Witnessed on Epic #1142 close-out (PR #1232 → PR #1233) — first ratchet fixed `epic-merge-lock.js -2.55` and `crap-engine.js +0.67`; the very next CI run on the fix branch surfaced `crap-engine.js -0.67` (back to where it had been) as a regression.

**How to apply:**

- When the gate fails on a small fractional branch delta on a file with no diff in the PR, treat it as flap, not regression. Don't loop the ratchet.
- For one-off unblocks: pull the failing run's artifact, run `update-coverage-baseline.js`, push, and force-merge with `gh pr merge --admin` if it flaps again on a different file.
- Real fix lives upstream: either (a) widen the per-file branch tolerance for files under N branches, (b) gate on aggregate coverage instead of per-file, or (c) pin the CI Node version where the noise is lower. None of these were in scope for #1142; flag if it bites a third time.
- Don't pull the artifact + push + hope — the next run will probably pick a different victim file in the same noise band.
