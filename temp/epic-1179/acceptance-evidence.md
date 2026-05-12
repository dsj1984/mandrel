# Epic #1179 — Acceptance Evidence

**Epic:** #1179 — v6 Epic A — MCP + gh CLI rebase
**Story:** #1366 — Verify all Epic-level acceptance invariants on the merged branch
**Task:** #1384 — Run + record Epic acceptance invariants
**Captured:** 2026-05-11T22:32:50Z
**Branch:** `story-1366` (forked from `epic/1179`)
**HEAD:** `7213c7d5fec9656a0c4a37f05fb55e5ad18ff7b8`
**Compared against:** `origin/main` @ `ac3dbad808d2f841ae5d39f2c8180988c9d1be99`

---

## Invariant 1 — No octokit/httpClient/retryWith residue

**Command:** `rg 'octokit|httpClient|retryWith' .agents/`
**Run at:** 2026-05-11T22:31:30Z
**Expected:** 0 matches
**Result:** PASS — `No matches found`

---

## Invariant 2 — Single api.github.com fetch site (projects-v2-graphql.js)

**Command:** `rg 'fetch\("https://api.github.com' .agents/`
**Run at:** 2026-05-11T22:31:30Z
**Expected:** Only matches in `providers/github/projects-v2-graphql.js`
**Result:** PASS

```
.agents/scripts/providers/github/projects-v2-graphql.js:59:  const res = await fetchImpl('https://api.github.com/graphql', {
```

Broader probe `rg 'api.github.com' .agents/` surfaces one additional hit in
`.agents/workflows/git-merge-pr.md` — this is PowerShell documentation prose
(`$url = "https://api.github.com/..."`), not a `fetch()` call, and therefore
does not violate the invariant.

---

## Invariant 3 — Net negative LOC delta vs `main`

**Command:** `git diff --stat origin/main -- .agents/ tests/`
**Run at:** 2026-05-11T22:31:35Z
**Expected:** Net negative LOC delta
**Result:** PASS

```
 55 files changed, 4600 insertions(+), 4817 deletions(-)
```

Net: **-217 LOC** (4600 inserted, 4817 deleted).

Full file-by-file diff stat is recorded in `temp/epic-1179/_diff-stat.txt`
within this evidence directory.

---

## Invariant 4 — `npm test` exits 0

**Command:** `npm test`
**Run at:** 2026-05-11T22:31:50Z → 2026-05-11T22:32:50Z
**Expected:** Exit code 0
**Result:** PASS

```
ℹ tests 3301
ℹ suites 494
ℹ pass 3299
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 56132.9262
```

Exit code: `0`.

---

## Invariant 5 — `baselines/epic` references are doc-prose or intentional legacy

**Command:** `rg 'baselines/epic' .agents/`
**Run at:** 2026-05-11T22:31:30Z
**Expected:** Only doc-prose or intentional legacy-path references (after
                the #1467 baseline-migration Story)
**Result:** PASS

Matches found (all expected):

```
.agents/workflows/agents-update.md:162:- Loose `baselines/epic-<id>-{maintainability,crap}.json` files →
.agents/workflows/agents-update.md:166:- Committed `baselines/epic/<id>/{maintainability,crap}.json` snapshots
.agents/workflows/agents-update.md:169:  for removal via `git rm -r --quiet --ignore-unmatch baselines/epic/<id>`
.agents/scripts/lib/baseline-snapshot.js:53: * `baselines/epic/<id>/`, which committed them to git and accumulated obsolete
.agents/scripts/lib/bootstrap/baselines-layout-migration.js:10
.agents/scripts/lib/bootstrap/baselines-layout-migration.js:12
.agents/scripts/lib/bootstrap/baselines-layout-migration.js:27
.agents/scripts/lib/bootstrap/baselines-layout-migration.js:28
.agents/scripts/lib/bootstrap/baselines-layout-migration.js:31
.agents/scripts/lib/bootstrap/baselines-layout-migration.js:123
.agents/scripts/lib/bootstrap/baselines-layout-migration.js:180
```

Classification:
- `agents-update.md` — documentation prose describing the legacy → new layout.
- `baseline-snapshot.js:53` — JSDoc comment describing legacy history.
- `baselines-layout-migration.js` — the bootstrap helper that intentionally
  detects and prunes the legacy `baselines/epic/<id>/` subdirectory layout
  (delivered by Story #1467).

No runtime path writes to `baselines/epic/<id>/`.

---

## Invariant 6 — `baselines/epic/` has no per-epic subdirectories

**Command:** `ls baselines/epic/`
**Run at:** 2026-05-11T22:31:35Z
**Expected:** Directory absent or empty of per-epic subdirectories
**Result:** PASS — `ls: cannot access 'baselines/epic/': No such file or directory`

The committed `baselines/epic/` directory does not exist on `epic/1179`.

---

## Summary

| # | Invariant | Result |
| - | --------- | ------ |
| 1 | No `octokit|httpClient|retryWith` in `.agents/` | PASS |
| 2 | `fetch("https://api.github.com` only in `projects-v2-graphql.js` | PASS |
| 3 | Net negative LOC delta vs `main` (-217) | PASS |
| 4 | `npm test` exits 0 (3299 pass, 0 fail) | PASS |
| 5 | `baselines/epic` matches are doc-prose / intentional legacy | PASS |
| 6 | `baselines/epic/` has no per-epic subdirectories | PASS |

All six Epic #1179 acceptance invariants hold on the merged epic branch.
