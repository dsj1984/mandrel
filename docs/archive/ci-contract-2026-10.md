# Archived CI contract history — 2026-10

Retired section relocated verbatim out of [`docs/ci-contract.md`](../ci-contract.md)
by Story #5682, under the Pruning & Archiving convention. It records the
`validate` job's deleted `Maintainability Check` step (Story #5004) and the
correction to how that deletion was first described.

**Archived, not deleted.** The body below is word-for-word as it stood in
`docs/ci-contract.md`; the only edits re-root relative links one level up so
they still resolve from this directory, and lift each heading one level so
the file's heading hierarchy starts at `##`.

**Still-live guidance was lifted out before the move.** The one fact that
still binds — `BASELINE_SCOPE=full` disables the head-vs-base ratchet arm
rather than re-scoring — now lives in § The real gap of
[`docs/ci-contract.md`](../ci-contract.md).

## Retired: push-scoped maintainability (`BASELINE_SCOPE=full`)

Until Story #5004 this table carried a **Push-scoped maintainability** row: the
`validate` job's `Maintainability Check` step exported
`BASELINE_SCOPE: ${{ github.event_name == 'pull_request' && '' || 'full' }}`,
so on PR runs it was diff-scoped — a byte-for-byte duplicate of the required
`baselines` job's `check-baselines.js` run — and on push-to-`main` it took the
`full` branch.

### Correction: the `full` leg was not a sweep

Story #5004 recorded the deleted `full` leg as a full-scope sweep that
"re-scored untouched files", and called losing it the price of removing the
duplicate. **That was wrong on the mechanism, and so wrong on the loss.**

`check-baselines.js` is a **reader**. It loads the committed baseline envelope
via `lib/baselines/reader.js` and never invokes a scorer. On the read path
`BASELINE_SCOPE=full` does one thing: it makes `evaluateCompare`
([`phases/compare.js`](../../.agents/scripts/lib/orchestration/check-baselines/phases/compare.js))
return an empty result, because that function short-circuits whenever
`scope.mode !== 'diff'`. Full scope **disables the head-vs-base ratchet arm**;
it does not widen a re-score, because there is no re-score to widen.

Measured on this repository:

| Invocation | Rows compared | `baseRead` | Wall clock |
| --- | --- | --- | --- |
| `check-baselines.js --gate maintainability` | 556 | `true` | 0.18s |
| `BASELINE_SCOPE=full` + the same command | 0 | `false` | 0.14s |

Both finish in under a fifth of a second, which is the tell on its own: a real
full-scope maintainability re-score of this tree takes ~1.7s of escomplex work.

So the push-to-`main` leg ran **floors only** over the committed rollup —
strictly weaker than the diff-scoped PR leg, and a strict subset of the
required `baselines` job on push runs as well as on PR runs. Deleting the step
lost nothing. There is no gap here to attribute to Story #5004.
