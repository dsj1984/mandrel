# Cross-platform baseline canonicalization fixture

Fixture corpus for Story #2192 (Epic #2173 — Unified Baseline Refresh
Service). The downstream determinism test
(`tests/baselines/canonicalize-path-fixture.test.js`) walks this directory
deterministically and feeds every discovered relative path through
[`canonicalizeBaselinePath()`](../../../../.agents/scripts/lib/baselines/path-canon.js)
to assert that the emitted POSIX key list is byte-identical on Windows
and Linux CI.

## Layout

```text
tests/fixtures/baselines/cross-platform/
├── README.md              ← this file (excluded from corpus)
├── module-a.js            ← deterministic source
├── nested/
│   └── module-b.js        ← deterministic source under a subdir
└── deep/
    └── nested/
        └── module-c.js    ← deterministic source under a deeper subdir
```

Every `.js` file ships content that is **deterministic by line**, **does
not import or evaluate anything**, and is keyed by its repo-relative path
— never by absolute path. Do not rename, reorder, or add platform-specific
side effects.

## Usage

Run the snapshot test from anywhere in the repo:

```text
node --test tests/baselines/canonicalize-path-fixture.test.js
```

The test produces a sorted list of canonicalized paths and compares it
against a pinned snapshot. If the snapshot drifts because a file is
added, removed, or renamed, update the `EXPECTED` array in the test file
and re-run.

## Adding a new fixture file

1. Add the `.js` source under this directory (or a nested subdir).
2. Re-run the snapshot test; copy the printed `actual` list into the
   `EXPECTED` array in the test.
3. Commit both the fixture and the snapshot update together.
