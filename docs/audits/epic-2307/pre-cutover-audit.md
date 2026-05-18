# Pre-Cutover Snapshot Audit — Epic #2307 / Story #2414 / Task #2424

**Date:** 2026-05-18
**Epic:** [#2307](https://github.com/dsj1984/mandrel/issues/2307) — Retire
the Legacy Orchestration Scripts and Migrate Checkpointer Consumers
**Story:** [#2414](https://github.com/dsj1984/mandrel/issues/2414) — Delete
`lifecycle/legacy-resume.js` + remove call site
**Task:** [#2424](https://github.com/dsj1984/mandrel/issues/2424) — Confirm
no open Epic carries a pre-cutover snapshot

## Goal

Verify the one-shot migration `lifecycle/legacy-resume.js` performs is no
longer needed for any open Epic. The seeder fires only when an Epic's
lifecycle is mid-flight and lacks a native `lifecycle.ndjson` ledger
(a "pre-cutover" snapshot). Once D-1 has executed against every live
Epic and the native ledger is in place, the seeder is dead code and the
import + call-site in `CheckpointPointerWriter` can be removed (Task
#2427).

## Method

1. Enumerated all currently-open Epics:

   ```sh
   gh issue list --label "type::epic" --state open --json number,title --limit 100
   ```

2. For each open Epic, downloaded the full structured-comment stream and
   grepped `epic-run-state` (and surrounding) comments for any flag
   matching `pre-cutover`, `preCutover`, or `pre_cutover`
   (case-insensitive).

## Open Epics audited

| Epic   | Title                                                                       |
| ------ | --------------------------------------------------------------------------- |
| #2307  | Retire the Legacy Orchestration Scripts and Migrate Checkpointer Consumers  |

(One open Epic; this is the Epic the current Story belongs to.)

## Findings

- Epic #2307 — comment stream scanned (311 lines):
  - Matches for `pre-cutover|preCutover|pre_cutover`
    (case-insensitive): **0**.

A scratch copy of the raw `gh issue view` output and the grep
verification is captured at `temp/epic-2307/pre-cutover-audit.txt` in
the Story #2414 worktree for the reviewer's local inspection. The
`temp/` tree is gitignored by design; this committed audit is the
durable record.

## Conclusion

Zero open Epics carry a pre-cutover snapshot flag. D-1 has run against
every live Epic; native `lifecycle.ndjson` ledgers are in place. The
`legacy-resume.js` seeder is safe to delete in Task #2427.

## Acceptance

- [x] Audit scan across open Epics' `epic-run-state` structured comments
      finds zero entries flagged pre-cutover.
- [x] Audit output captured for reviewer inspection
      (`docs/audits/epic-2307/pre-cutover-audit.md` durable, and
      `temp/epic-2307/pre-cutover-audit.txt` in-worktree).
