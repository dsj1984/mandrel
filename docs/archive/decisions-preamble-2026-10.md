# Archived decisions-log preamble history — 2026-10

Narrative relocated out of the "How to read this log" preamble of
[`docs/decisions.md`](../decisions.md) by Story #5811, under the Pruning &
Archiving convention. The live rules it explains stay in that preamble, one
line each; this file keeps the history of how they were established.

**Archived, not deleted.** The paragraphs below are word-for-word as they
stood in `docs/decisions.md`.

Every entry that is still **Accepted** carries a `**Surface:**` line naming the
one primary path the decision governs. What that line is machine-checked for is
**existence only** — `tests/docs/decisions-and-archive-contract.test.js` runs
`existsSync` on the path, nothing more. It catches the loud failure (an ADR
still Accepted after its file was deleted) and cannot catch the quiet one: a
decision whose mechanism was dismantled while the named file lived on, or whose
Surface names a file too broad to witness anything. Treat a passing Surface as
necessary, never sufficient. Entries known to be in that state carry an
explicit `**Materially dead:**` line — grep for it.

**Identifiers are unique and stable.** An entry is cited by its `<date>-<ticket>`
identifier, and the same contract test rejects a collision. Story #4786 resolved
seven: the freshness-gate entry moved from `20260507-1114a` to `-1114b`, and the
six date-only `ADR-20260421` / `ADR-20260422` entries gained their Epic suffix
(`-321a/b`, `-380a/b`, `-413a/b`). Story #5077 resolved the last two entries
that carried no identifier at all: the facade entry became `20260420-297` and
the `drain-pending-cleanup` overturn became `20260607-3706`. Renumber, never
reuse.

**Every entry carries `**Status:**`, `**Date:**` and — while in force —
`**Surface:**` as block lines directly under its heading.** Story #5077
normalized the eleven 2026-04/05 entries that carried those fields as list
items instead, where the contract test's ADR predicate could not be pinned to
them; their bodies keep the older bullet layout. The contract test now derives
the ADR set structurally — every level-two entry below the Index block, minus
one the Index declares under "Not ADR entries" — so an entry missing a `Status`
line or a `<date>-<ticket>` identifier fails rather than being silently
reclassified as not-an-ADR.

Backticked paths **inside an entry's body are not maintained**. An ADR records
what was true when it was written, so roughly 60% of them point at files later
renamed or removed — that is the record working as intended, not rot. Trust the
`**Surface:**` line and the status; treat body paths as historical citations.
