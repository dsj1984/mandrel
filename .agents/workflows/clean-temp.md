---
description: >-
  Clear the temp-tree backlog the land-time purge cannot attribute: sort every
  top-level entry under the project's tempRoot into framework, closed-issue,
  aged and kept buckets, preview by default, and delete only confirmed buckets.
---

# /clean-temp [--execute] [--yes] [--json]

The land-time and boot-time purges only reap what they can attribute: the
framework's own temp layouts and `temp/scratch/`. Everything else an agent
dropped at the temp root is reported and left alone, so a busy consumer's temp
tree grows without bound. `/clean-temp` is the operator's catch-up for that
backlog. It classifies and deletes through the same temp-retention engine the
purges use — there is no second walker.

The script documents its own flags:
`node .agents/scripts/clean-temp.js --help`. Without `--execute` it is a
**dry-run preview**; nothing is deleted.

## Buckets

Every top-level entry under tempRoot lands in exactly one:

| Bucket | What it holds | Unattended (`--yes`) |
| --- | --- | --- |
| **framework** | A framework layout holding artifacts the auto-purge would take — Story-keyed on a closed Story, or past `staleDays`. | Deleted |
| **closed-issue** | An unrecognized entry whose basename names exactly one issue id, and that issue reads `closed`. | Deleted |
| **aged** | An unrecognized entry naming no id, or several, older than `staleDays`. | **Never** — an age heuristic has no attribution, so it needs a human |
| **kept** | Everything else, with the reason: issue open, issue read failed, too recent, reserved, or nothing spent. | Kept |

An id is a standalone run of up to seven digits in the basename. A basename
naming two ids is never attributed to either — it is treated as id-less.

## Constraint

> [!WARNING] `--execute` deletes files. Interactive runs confirm each bucket;
> `--yes` deletes the framework and closed-issue buckets only.

- Reads fail safe: an open issue, or one whose read fails, keeps its entry.
- `qa/`, `cache/`, `*.lock` and `signals.ndjson` at any depth are never
  deleted.
- Project-scoped: the script exits 1 without deleting anything when the
  resolved tempRoot is not inside the project root it was invoked from. It
  never touches `$TMPDIR` or a sibling checkout.

## Steps

1. Preview and read the table (bucket, entry, size, age, reason):

   ```bash
   node .agents/scripts/clean-temp.js
   ```

2. Delete, confirming each bucket:

   ```bash
   node .agents/scripts/clean-temp.js --execute
   ```

   Unattended, `--execute --yes` deletes the framework and closed-issue buckets
   and reports the aged bucket as left for a human. `--json` emits the envelope
   (per-bucket totals and `bytesReclaimed`) instead of the table.

Going forward, put ad-hoc scratch under `temp/scratch/story-<id>/` (or
`temp/scratch/` with no Story): a Story's landing reaps its scratch directory,
and the boot sweep age-floors the rest.
